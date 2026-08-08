"""Organizer surface. Every query carries the JWT-derived org predicate —
the service-role client bypasses RLS, so a missing predicate is a cross-org
leak, not a bug you notice in testing.
"""

from __future__ import annotations

import logging
from datetime import datetime, time, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import get_current_user_and_org, verify_org_access
from services.forms import load_form_layout
from services.invites import (
    InviteTargetNotFound,
    SessionNotScheduled,
    cancel_session_invites,
    send_session_invites,
)
from services.org_scope import fetch_scoped
from services.slugs import slugify, unique_slug
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/api", tags=["admin"])
logger = logging.getLogger(__name__)

SESSION_STATUSES = (
    "draft",
    "pending",
    "accept_queue",
    "accepted",
    "decline_queue",
    "declined",
    "withdrawn",
)

# events.slot_minutes CHECK (migration 001)
SLOT_MINUTES = (5, 10, 15, 20, 30, 45, 60)

# A brand-new event with an empty Formats list cannot accept a submission that
# names one, so every event starts with the four everybody runs.
DEFAULT_FORMATS = (
    ("Keynote", 45),
    ("Talk", 30),
    ("Lightning Talk", 15),
    ("Workshop", 90),
)


class SessionPatchRequest(BaseModel):
    status: str


class EventCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    slug: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, max_length=64)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = Field(default=None, max_length=300)


class EventPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    timezone: str | None = Field(default=None, max_length=64)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = Field(default=None, max_length=300)
    day_start: time | None = None
    day_end: time | None = None
    slot_minutes: int | None = None


@router.get("/events")
async def list_events(auth: tuple = Depends(get_current_user_and_org)):
    _user_id, org_id = auth
    res = await db(
        lambda: supabase.table("events")
        .select("*")
        .eq("org_id", org_id)
        .order("starts_at", desc=True)
        .execute(),
        "list_events",
    )
    return {"events": rows(res)}


def _as_datetime(value: object) -> datetime | None:
    """Timestamps arrive parsed from the body and as ISO text from the DB."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


@router.post("/events", status_code=201)
async def create_event(
    payload: EventCreateRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """A new event, ready to receive submissions.

    events.slug is globally unique (it appears in public URLs), so the slug is
    derived and de-collided rather than taken from the body verbatim.
    """
    _user_id, org_id = auth
    if payload.starts_at and payload.ends_at and payload.ends_at <= payload.starts_at:
        raise HTTPException(status_code=400, detail="The event must end after it starts")

    slug = await unique_slug("events", slugify(payload.slug or payload.name, fallback="event"))
    record: dict = {"org_id": org_id, "name": payload.name.strip(), "slug": slug}
    if payload.timezone:
        record["timezone"] = payload.timezone
    if payload.location is not None:
        record["location"] = payload.location
    if payload.starts_at:
        record["starts_at"] = payload.starts_at.isoformat()
    if payload.ends_at:
        record["ends_at"] = payload.ends_at.isoformat()

    event = first(
        await db(lambda: supabase.table("events").insert(record).execute(), "create_event")
    )
    if not event:
        raise HTTPException(status_code=500, detail="Could not create event")

    formats = [
        {
            "org_id": org_id,
            "event_id": event["id"],
            "name": name,
            "default_duration_min": minutes,
        }
        for name, minutes in DEFAULT_FORMATS
    ]
    try:
        await db(
            lambda: supabase.table("formats").insert(formats).execute(),
            "create_event_default_formats",
        )
    except Exception:
        # The event exists and is usable; formats are editable in Settings.
        # Failing the whole request here would leave an orphan the organizer
        # cannot see and cannot name again (the slug is taken).
        logger.warning("events: default formats not seeded event_id=%s", event["id"], exc_info=True)

    return {"event": event}


@router.get("/events/{event_id}")
async def get_event(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
    _user_id, org_id = auth
    return {"event": await fetch_scoped("events", event_id, org_id, "Event")}


@router.patch("/events/{event_id}")
async def update_event(
    event_id: str,
    payload: EventPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    if payload.slot_minutes is not None and payload.slot_minutes not in SLOT_MINUTES:
        raise HTTPException(
            status_code=400,
            detail=(
                "slot_minutes must be one of "
                f"{', '.join(str(value) for value in SLOT_MINUTES)}"
            ),
        )
    existing = await fetch_scoped("events", event_id, org_id, "Event")

    provided = payload.model_dump(exclude_unset=True)
    patch: dict = {}
    for key in ("timezone", "location", "slot_minutes"):
        if key in provided:
            patch[key] = provided[key]
    if payload.name is not None:
        patch["name"] = payload.name.strip()
    for key in ("starts_at", "ends_at"):
        if key in provided:
            value = getattr(payload, key)
            patch[key] = value.isoformat() if value else None
    for key in ("day_start", "day_end"):
        if key in provided:
            value = getattr(payload, key)
            patch[key] = value.isoformat() if value else None
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    # slug stays put: it is the public agenda URL people have already shared.

    # The merged range, not just the patched half: moving `ends_at` before an
    # untouched `starts_at` is the easy way to get an impossible event.
    starts_at = _as_datetime(patch.get("starts_at", existing.get("starts_at")))
    ends_at = _as_datetime(patch.get("ends_at", existing.get("ends_at")))
    if starts_at and ends_at and ends_at <= starts_at:
        raise HTTPException(status_code=400, detail="The event must end after it starts")

    updated = first(
        await db(
            lambda: supabase.table("events")
            .update(patch)
            .eq("id", event_id)
            .eq("org_id", org_id)
            .execute(),
            "update_event",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"event": updated}


@router.get("/events/{event_id}/submissions")
async def list_submissions(
    event_id: str,
    status: str | None = Query(default=None),
    is_abstract: bool | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    auth: tuple = Depends(get_current_user_and_org),
):
    """Submissions inbox: sessions for one event, newest submission first."""
    _user_id, org_id = auth
    if status and status not in SESSION_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown status '{status}'")

    event = first(
        await db(
            lambda: supabase.table("events")
            .select("id, org_id, name, slug")
            .eq("id", event_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "submissions_event_lookup",
        )
    )
    verify_org_access(event, org_id, "Event")

    def _query():
        q = (
            supabase.table("sessions")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
        )
        if status:
            q = q.eq("status", status)
        if is_abstract is not None:
            q = q.eq("is_abstract", is_abstract)
        return q.order("submitted_at", desc=True).limit(limit).execute()

    sessions = rows(await db(_query, "list_submissions"))

    # Second query rather than a PostgREST embed: an embedded resource cannot
    # carry its own org predicate, and the FK-hint syntax breaks the moment a
    # constraint is renamed.
    contact_ids = sorted({s["submitter_contact_id"] for s in sessions if s.get("submitter_contact_id")})
    contacts_by_id: dict[str, dict] = {}
    if contact_ids:
        c_res = await db(
            lambda: supabase.table("contacts")
            .select("id, first_name, last_name, email")
            .in_("id", contact_ids)
            .eq("org_id", org_id)
            .execute(),
            "list_submissions_contacts",
        )
        contacts_by_id = {row["id"]: row for row in rows(c_res)}

    for session in sessions:
        session["submitter"] = contacts_by_id.get(session.get("submitter_contact_id"))

    return {"event": event, "submissions": sessions, "count": len(sessions)}


async def _resolve_answers(session: dict, org_id: str) -> list[dict]:
    """`form_answers` ({field_id: value}) rendered as an ordered Q&A list.

    Ordering follows the form the speaker actually filled in — reading a
    submission out of form order is reading a different submission. Answers to
    fields since removed from the form still show, after the rest, so nothing
    an applicant wrote silently disappears from the organizer's view.
    """
    answers = session.get("form_answers") or {}
    if not isinstance(answers, dict) or not answers:
        return []

    resolved: list[dict] = []
    seen: set[str] = set()

    if session.get("source_form_id"):
        for entry in await load_form_layout(session["source_form_id"], org_id):
            field_id = entry["field_id"]
            if field_id not in answers:
                continue
            seen.add(field_id)
            resolved.append(
                {
                    "field_id": field_id,
                    "label": entry.get("label_override") or entry["public_name"],
                    "field_type": entry["field_type"],
                    "value": answers[field_id],
                }
            )

    orphans = [field_id for field_id in answers if field_id not in seen]
    if orphans:
        definitions = rows(
            await db(
                lambda: supabase.table("fields")
                .select("id, public_name, field_type")
                .in_("id", orphans)
                .eq("org_id", org_id)
                .execute(),
                "submission_orphan_fields",
            )
        )
        by_id = {row["id"]: row for row in definitions}
        for field_id in orphans:
            field = by_id.get(field_id) or {}
            resolved.append(
                {
                    "field_id": field_id,
                    "label": field.get("public_name") or field_id,
                    "field_type": field.get("field_type") or "text",
                    "value": answers[field_id],
                }
            )
    return resolved


async def _load_participants(session_id: str, org_id: str) -> list[dict]:
    """Everyone attached to a session, primary speakers first."""
    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("contact_id, role, is_primary")
            .eq("session_id", session_id)
            .eq("org_id", org_id)
            .execute(),
            "submission_participants",
        )
    )
    if not participants:
        return []

    contact_ids = sorted({p["contact_id"] for p in participants if p.get("contact_id")})
    contacts_by_id: dict[str, dict] = {}
    if contact_ids:
        contacts = rows(
            await db(
                lambda: supabase.table("contacts")
                .select("id, first_name, last_name, email")
                .in_("id", contact_ids)
                .eq("org_id", org_id)
                .execute(),
                "submission_participant_contacts",
            )
        )
        contacts_by_id = {row["id"]: row for row in contacts}

    merged = [
        {
            "contact_id": p.get("contact_id"),
            "role": p.get("role"),
            "is_primary": bool(p.get("is_primary")),
            "first_name": (contacts_by_id.get(p.get("contact_id")) or {}).get("first_name"),
            "last_name": (contacts_by_id.get(p.get("contact_id")) or {}).get("last_name"),
            "email": (contacts_by_id.get(p.get("contact_id")) or {}).get("email"),
        }
        for p in participants
    ]
    merged.sort(key=lambda p: (not p["is_primary"], str(p["role"] or ""), str(p["email"] or "")))
    return merged


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """One submission, everything the review drawer shows."""
    _user_id, org_id = auth
    session = await fetch_scoped("sessions", session_id, org_id, "Session")
    return {
        "session": session,
        "answers": await _resolve_answers(session, org_id),
        "participants": await _load_participants(session_id, org_id),
    }


@router.patch("/sessions/{session_id}")
async def update_session(
    session_id: str,
    payload: SessionPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Move a session between status tabs (accept/decline queues)."""
    _user_id, org_id = auth
    if payload.status not in SESSION_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown status '{payload.status}'")

    existing = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "session_lookup",
        )
    )
    verify_org_access(existing, org_id, "Session")

    updated = first(
        await db(
            lambda: supabase.table("sessions")
            .update(
                {
                    "status": payload.status,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("id", session_id)
            .eq("org_id", org_id)
            .execute(),
            "session_update_status",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session": updated}


@router.post("/sessions/{session_id}/send-invites")
async def send_invites(
    session_id: str,
    dry_run: bool = Query(default=False),
    auth: tuple = Depends(get_current_user_and_org),
):
    """Send/refresh calendar invites for a session's speakers.

    Safe to press twice: unchanged attendees come back as "unchanged" and get
    no mail. `dry_run=true` renders the ICS without writing or sending.
    """
    _user_id, org_id = auth
    try:
        return await send_session_invites(session_id, org_id, dry_run=dry_run)
    except InviteTargetNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except SessionNotScheduled as exc:
        # 409, not 400: the request is fine, the session just isn't ready.
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.post("/sessions/{session_id}/cancel-invites")
async def cancel_invites(
    session_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    """METHOD:CANCEL every invite already sent for this session."""
    _user_id, org_id = auth
    try:
        return await cancel_session_invites(session_id, org_id)
    except InviteTargetNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
