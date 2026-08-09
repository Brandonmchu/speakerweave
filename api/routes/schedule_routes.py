"""The agenda: what is schedulable, where it sits, and what collides.

Three routes behind one idea — the grid the organizer drags on is a *view* of
`sessions`, not a document of its own. There is no separate schedule table:
placing a card writes `starts_at` / `ends_at` / `room_id` on the session, and
everything else here is assembly and arithmetic over those columns.

Two guards matter:

  * Every query carries the JWT-derived org predicate. The service-role client
    bypasses RLS, so a missing predicate is a cross-org leak.
  * Postgres owns the last word on room double-booking (the EXCLUDE constraint
    in migration 001). We translate its violation into a 409 the UI can undo an
    optimistic drag with, rather than letting it surface as a 500.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from postgrest.exceptions import APIError
from pydantic import BaseModel

from auth import get_current_user_and_org, verify_org_access
from services.auto_place import plan_auto_placements
from services.scheduling import (
    Labels,
    detect_conflicts,
    duration_minutes,
    scheduled_session,
)
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/api", tags=["schedule"])
logger = logging.getLogger(__name__)

# What may appear on the grid. `pending` is included deliberately: an organizer
# blocks out the shape of the programme before every decision is final, and a
# pending session on the grid is exactly the prompt to go decide it. Only
# accepted/accept_queue rows are covered by the DB exclusion constraint, so the
# conflicts endpoint is what keeps the rest honest.
SCHEDULABLE_STATUSES = ("accepted", "accept_queue", "pending")

# Whoever is actually on stage. Falls back to the submitter when no speaker has
# been assigned yet — an accepted CFP submission is a talk with one known human
# on it, and dropping them out of speaker-conflict detection would be pedantry.
SPEAKER_ROLE = "speaker"
SUBMITTER_ROLE = "submitter"

#: Last-resort card length when a session has neither an end nor a format.
DEFAULT_DURATION_MIN = 30

#: Postgres `exclusion_violation`.
EXCLUSION_VIOLATION = "23P01"
ROOM_DOUBLE_BOOKED = "Room double-booked at that time."


class SchedulePatchRequest(BaseModel):
    """All three keys are optional; an explicit null clears the field.

    `exclude_unset` at the call site is what makes "unschedule this" (null)
    different from "leave the room alone" (omitted).
    """

    starts_at: datetime | None = None
    ends_at: datetime | None = None
    room_id: str | None = None


def _as_datetime(value: object) -> datetime | None:
    """Body values arrive parsed, DB values as ISO text. Naive is read as UTC."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _ordered(items: list[dict]) -> list[dict]:
    """`order` then name — sorted here because `order` is also PostgREST's own
    sort parameter, and these lists are tiny."""
    return sorted(
        items,
        key=lambda row: (
            row["order"] if isinstance(row.get("order"), int) else 0,
            str(row.get("name") or "").casefold(),
        ),
    )


def _contact_name(contact: dict) -> str:
    name = f"{contact.get('first_name') or ''} {contact.get('last_name') or ''}".strip()
    return name or str(contact.get("email") or contact.get("id") or "")


async def _load_event(event_id: str, org_id: str) -> dict:
    """The event the grid is drawn from, or 404."""
    event = first(
        await db(
            lambda: supabase.table("events")
            .select("id, org_id, name, slug, timezone, starts_at, ends_at, day_start, day_end, slot_minutes")
            .eq("id", event_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "agenda_event_lookup",
        )
    )
    return verify_org_access(event, org_id, "Event")


async def _load_speakers(session_ids: list[str], org_id: str) -> dict[str, list[dict]]:
    """{session_id: [{contact_id, first_name, last_name}]}, primary first.

    Two queries rather than a PostgREST embed: an embedded resource cannot
    carry its own org predicate, and the FK-hint syntax breaks the moment a
    constraint is renamed.
    """
    if not session_ids:
        return {}

    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("session_id, contact_id, role, is_primary")
            .in_("session_id", session_ids)
            .eq("org_id", org_id)
            .execute(),
            "agenda_participants",
        )
    )

    by_session: dict[str, list[dict]] = {}
    for participant in participants:
        if not participant.get("contact_id"):
            continue
        by_session.setdefault(str(participant.get("session_id")), []).append(participant)

    chosen: dict[str, list[dict]] = {}
    for session_id, group in by_session.items():
        speakers = [p for p in group if p.get("role") == SPEAKER_ROLE]
        if not speakers:
            speakers = [p for p in group if p.get("role") == SUBMITTER_ROLE]
        if speakers:
            chosen[session_id] = speakers

    contact_ids = sorted({str(p["contact_id"]) for group in chosen.values() for p in group})
    if not contact_ids:
        return {}

    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select("id, first_name, last_name, email")
            .in_("id", contact_ids)
            .eq("org_id", org_id)
            .execute(),
            "agenda_speaker_contacts",
        )
    )
    contacts_by_id = {str(row["id"]): row for row in contacts}

    resolved: dict[str, list[dict]] = {}
    for session_id, group in chosen.items():
        people = []
        for participant in group:
            contact = contacts_by_id.get(str(participant["contact_id"]))
            if not contact:
                continue
            people.append(
                {
                    "contact_id": str(contact["id"]),
                    "first_name": contact.get("first_name") or "",
                    "last_name": contact.get("last_name") or "",
                    "is_primary": bool(participant.get("is_primary")),
                }
            )
        people.sort(
            key=lambda p: (
                not p["is_primary"],
                str(p["first_name"]).casefold(),
                str(p["last_name"]).casefold(),
                p["contact_id"],
            )
        )
        for person in people:
            person.pop("is_primary", None)
        if people:
            resolved[session_id] = people
    return resolved


def _duration_for(session: dict, default_by_format: dict[str, int]) -> int:
    """Derived, never stored: the placed length wins, then the format's default."""
    placed = duration_minutes(session.get("starts_at"), session.get("ends_at"))
    if placed:
        return placed
    fallback = default_by_format.get(str(session.get("format_id")))
    return fallback if fallback else DEFAULT_DURATION_MIN


async def _assemble_agenda(event_id: str, org_id: str) -> dict:
    """Everything the grid needs, in one shape. Org predicate on every query."""
    event = await _load_event(event_id, org_id)

    # `select("*")`, like taxonomy_routes: `order` is a column on both tables and
    # also PostgREST's own sort parameter, and the response is trimmed below
    # anyway. These lists are a handful of rows.
    rooms = _ordered(
        rows(
            await db(
                lambda: supabase.table("rooms")
                .select("*")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .execute(),
                "agenda_rooms",
            )
        )
    )
    tracks = _ordered(
        rows(
            await db(
                lambda: supabase.table("tracks")
                .select("*")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .execute(),
                "agenda_tracks",
            )
        )
    )
    formats = rows(
        await db(
            lambda: supabase.table("formats")
            .select("id, default_duration_min")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "agenda_formats",
        )
    )
    sessions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select(
                "id, friendly_id, title, status, starts_at, ends_at, "
                "room_id, track_id, format_id, submitter_contact_id"
            )
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .in_("status", list(SCHEDULABLE_STATUSES))
            .execute(),
            "agenda_sessions",
        )
    )

    default_by_format = {
        str(row["id"]): int(row["default_duration_min"])
        for row in formats
        if row.get("id") and isinstance(row.get("default_duration_min"), int)
    }

    speakers_by_session = await _load_speakers([str(s["id"]) for s in sessions], org_id)

    assembled = [
        {
            "id": str(session["id"]),
            "friendly_id": session.get("friendly_id"),
            "title": session.get("title") or "",
            "status": session.get("status"),
            "starts_at": session.get("starts_at"),
            "ends_at": session.get("ends_at"),
            "room_id": session.get("room_id"),
            "track_id": session.get("track_id"),
            "duration_min": _duration_for(session, default_by_format),
            "speakers": speakers_by_session.get(str(session["id"]), []),
        }
        for session in sessions
    ]
    # Scheduled first in start order, then the unscheduled tray alphabetically —
    # the same reading order as the grid, so the response needs no client sort.
    assembled.sort(
        key=lambda s: (
            s["starts_at"] is None,
            str(s["starts_at"] or ""),
            str(s["title"]).casefold(),
        )
    )

    return {
        "event": {
            "id": event["id"],
            "name": event.get("name"),
            "slug": event.get("slug"),
            "timezone": event.get("timezone"),
            "starts_at": event.get("starts_at"),
            "ends_at": event.get("ends_at"),
            "day_start": event.get("day_start"),
            "day_end": event.get("day_end"),
            "slot_minutes": event.get("slot_minutes"),
        },
        "rooms": [
            {
                "id": room["id"],
                "name": room.get("name"),
                "capacity": room.get("capacity"),
                "order": room.get("order"),
            }
            for room in rooms
        ],
        "tracks": [
            {"id": track["id"], "name": track.get("name"), "color": track.get("color")}
            for track in tracks
        ],
        "sessions": assembled,
    }


def _labels(agenda: dict) -> Labels:
    """Ids -> the names an operator recognises, for the `detail` strings."""
    return {
        "rooms": {str(room["id"]): str(room.get("name") or room["id"]) for room in agenda["rooms"]},
        "speakers": {
            speaker["contact_id"]: _contact_name(speaker)
            for session in agenda["sessions"]
            for speaker in session["speakers"]
        },
    }


@router.get("/events/{event_id}/agenda")
async def get_agenda(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """The whole grid in one request: event geometry, rooms, tracks, sessions.

    Unscheduled sessions come back too, with `starts_at` null — they are the
    tray the organizer drags from, not a separate resource.
    """
    _user_id, org_id = auth
    return await _assemble_agenda(event_id, org_id)


@router.get("/events/{event_id}/agenda/conflicts")
async def get_agenda_conflicts(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """The authoritative conflict list.

    The browser detects conflicts live while dragging so feedback is instant;
    this is what it reconciles against, and it sees rows the browser cannot —
    another organizer's drag in another tab, or a session whose status changed
    underneath the open grid.
    """
    _user_id, org_id = auth
    agenda = await _assemble_agenda(event_id, org_id)

    placed = []
    for session in agenda["sessions"]:
        candidate = scheduled_session(
            session,
            duration_min=session["duration_min"],
            speaker_ids=tuple(speaker["contact_id"] for speaker in session["speakers"]),
        )
        if candidate:
            placed.append(candidate)

    conflicts = detect_conflicts(placed, _labels(agenda))
    return {"conflicts": [conflict.as_dict() for conflict in conflicts]}


def _is_room_double_book(exc: APIError) -> bool:
    """The EXCLUDE constraint from migration 001, as PostgREST reports it."""
    if getattr(exc, "code", None) == EXCLUSION_VIOLATION:
        return True
    blob = " ".join(
        str(part or "")
        for part in (getattr(exc, "message", ""), getattr(exc, "details", ""), exc)
    ).lower()
    return "exclusion constraint" in blob or EXCLUSION_VIOLATION.lower() in blob


@router.patch("/sessions/{session_id}/schedule")
async def update_session_schedule(
    session_id: str,
    payload: SchedulePatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Place, move or unschedule one session.

    Only the three schedule columns are writable here — status stays on
    `PATCH /api/sessions/{id}`, so a drag can never accept a talk by accident.
    """
    _user_id, org_id = auth

    existing = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id, starts_at, ends_at, room_id")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "schedule_session_lookup",
        )
    )
    verify_org_access(existing, org_id, "Session")

    provided = payload.model_dump(exclude_unset=True)
    if not provided:
        raise HTTPException(status_code=400, detail="Nothing to update")

    patch: dict = {}
    if "room_id" in provided:
        patch["room_id"] = payload.room_id or None
    for key in ("starts_at", "ends_at"):
        if key in provided:
            value = getattr(payload, key)
            patch[key] = _as_datetime(value).isoformat() if value else None

    # The merged range, not just the patched half: moving `ends_at` before an
    # untouched `starts_at` is the easy way to get an impossible session, and
    # the DB CHECK would answer with a 500 instead of a reason.
    starts_at = _as_datetime(patch.get("starts_at", existing.get("starts_at")))
    ends_at = _as_datetime(patch.get("ends_at", existing.get("ends_at")))
    if starts_at and ends_at and ends_at <= starts_at:
        raise HTTPException(status_code=400, detail="The session must end after it starts")

    patch["updated_at"] = datetime.now(timezone.utc).isoformat()

    try:
        updated = first(
            await db(
                lambda: supabase.table("sessions")
                .update(patch)
                .eq("id", session_id)
                .eq("org_id", org_id)
                .execute(),
                "session_update_schedule",
            )
        )
    except APIError as exc:
        if not _is_room_double_book(exc):
            raise
        # 409, not 500: the request is well-formed, the room is taken. The grid
        # rolls its optimistic move back on exactly this status.
        logger.info("schedule: room double-book rejected session_id=%s", session_id)
        raise HTTPException(status_code=409, detail=ROOM_DOUBLE_BOOKED) from None

    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session": updated}


@router.post("/events/{event_id}/schedule/auto-place")
async def auto_place_schedule(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """Fill the tray in one action: every unscheduled session into a clean slot.

    The decision is made by `services/auto_place.py` against the *same* rule
    engine the conflicts endpoint sweeps with, so this endpoint can only ever
    write placements the grid would draw green. What it cannot fit it leaves in
    the tray with a reason — a schedule is never forced.

    The writes are the ordinary schedule columns, one row at a time, so an
    auto-placed card is indistinguishable from a dragged one afterwards: it can
    be moved, unscheduled, and re-auto-placed. Postgres still has the last word
    on room double-booking; if the exclusion constraint refuses a row (another
    organizer moved something mid-run) that one session becomes a skip rather
    than a 500 that abandons the rest of the plan.
    """
    _user_id, org_id = auth
    agenda = await _assemble_agenda(event_id, org_id)  # 404s a foreign / unknown event

    plan = plan_auto_placements(agenda)
    placed: list[dict] = []
    skipped: list[dict] = [entry.as_dict() for entry in plan.skipped]

    for placement in plan.placed:
        patch = {
            "room_id": placement.room_id,
            "starts_at": placement.starts_at,
            "ends_at": placement.ends_at,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            updated = first(
                await db(
                    lambda patch=patch, session_id=placement.session_id: supabase.table("sessions")
                    .update(patch)
                    .eq("id", session_id)
                    .eq("org_id", org_id)
                    .execute(),
                    "schedule_auto_place",
                )
            )
        except APIError as exc:
            # ANY per-session write failure becomes a skip: earlier placements
            # in this run have already persisted, so raising here would turn a
            # partial success into a 500 the caller can't reconcile.
            reason = (
                ROOM_DOUBLE_BOOKED
                if _is_room_double_book(exc)
                else "Could not save this placement."
            )
            logger.warning(
                "auto-place: write rejected session_id=%s: %s", placement.session_id, exc
            )
            skipped.append(
                {
                    "id": placement.session_id,
                    "title": placement.title,
                    "reason": reason,
                }
            )
            continue

        if not updated:
            skipped.append(
                {
                    "id": placement.session_id,
                    "title": placement.title,
                    "reason": "Session could not be updated.",
                }
            )
            continue
        placed.append(placement.as_dict())

    return {"placed": placed, "skipped": skipped}


@router.post("/events/{event_id}/schedule/publish")
async def publish_schedule(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """Mark the programme published and hand back the public schedule link.

    This is an explicit, visible affirmation — NOT a visibility switch. The
    public schedule (routes/program_routes.py) already returns accepted+scheduled
    sessions regardless of this flag, and keeps doing so; publishing only records
    *when* the organizer pressed the button and surfaces the URL to share.

    The `program_published_at` column is additive (migration 005) and may not
    exist in every environment yet, so the write is best-effort: if it fails the
    endpoint still returns a success with the public URL and a fresh timestamp,
    so the organizer never sees the affordance break.
    """
    _user_id, org_id = auth
    event = await _load_event(event_id, org_id)  # 404s a foreign / unknown event

    published_at = datetime.now(timezone.utc).isoformat()
    try:
        updated = first(
            await db(
                lambda: supabase.table("events")
                .update({"program_published_at": published_at})
                .eq("id", event_id)
                .eq("org_id", org_id)
                .execute(),
                "schedule_publish",
            )
        )
        if updated and updated.get("program_published_at"):
            published_at = updated["program_published_at"]
    except APIError as exc:
        # Missing column (migration not applied here) or any transient write
        # error: publishing must still succeed and return the link. The
        # timestamp is a best-effort record, never a hard dependency.
        logger.warning("publish: could not persist program_published_at: %s", exc)

    slug = event.get("slug")
    return {
        "event": {
            "id": event["id"],
            "slug": slug,
            "program_published_at": published_at,
        },
        "public_url": f"/e/{slug}/schedule" if slug else None,
    }
