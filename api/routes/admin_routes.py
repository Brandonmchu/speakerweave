"""Organizer surface. Every query carries the JWT-derived org predicate —
the service-role client bypasses RLS, so a missing predicate is a cross-org
leak, not a bug you notice in testing.
"""

from __future__ import annotations

import html as html_module
import logging
from datetime import datetime, time, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field, field_validator

from auth import get_current_user_and_org, verify_org_access
from services import mailer, speaker_crm
from services.comms import DEFAULT_TEMPLATES, render_template
from services.evaluations import session_review_aggregate, session_review_scores
from services.forms import load_form_layout
from services.invites import (
    InviteTargetNotFound,
    SessionNotScheduled,
    cancel_session_invites,
    send_session_invites,
)
from services.onboarding import provision_speaker_onboarding
from services.org_scope import fetch_event, fetch_scoped
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


# The organizer's central session editor (CNT-09). Lengths are checked in the
# handler rather than by Field(max_length=…) so an over-long title comes back as
# a 400 an organizer can read, not pydantic's 422.
MAX_SESSION_TITLE = 300
MAX_SESSION_DESCRIPTION = 10_000


class SessionPatchRequest(BaseModel):
    """A status move between tabs, an edit of the title/abstract, or both.

    Every field is optional and read with ``exclude_unset``: sending only
    ``title`` must not blank the description, and sending ``description: ""``
    must clear it. ``abstract`` is accepted as an alias for ``description`` —
    the CFP form and the manual-add dialog both call that field the abstract.
    """

    status: str | None = None
    title: str | None = None
    description: str | None = None
    abstract: str | None = None


class ManualSubmissionRequest(BaseModel):
    """An organizer typing in a submission that never came through a CFP form."""

    title: str = Field(..., min_length=1, max_length=300)
    submitter_name: str = Field(default="", max_length=200)
    submitter_email: str = Field(..., min_length=3, max_length=320)
    abstract: str | None = Field(default=None, max_length=50_000)
    track_id: str | None = Field(default=None, max_length=64)
    format_id: str | None = Field(default=None, max_length=64)

    @field_validator("submitter_email")
    @classmethod
    def looks_like_email(cls, value: str) -> str:
        value = value.strip()
        if "@" not in value or value.startswith("@") or value.endswith("@"):
            raise ValueError("Enter a valid email address")
        return value


class SessionDecisionRequest(BaseModel):
    decision: Literal["approve", "maybe", "deny"]
    feedback: str | None = Field(default=None, max_length=10_000)
    email_speaker: bool = False


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

    # Average review score per submission, so the inbox can show a score column
    # and sort/compare by it — the organizer's read of the reviewers' verdicts.
    scores_by_session = await session_review_scores(
        org_id, [str(s["id"]) for s in sessions if s.get("id")]
    )

    for session in sessions:
        session["submitter"] = contacts_by_id.get(session.get("submitter_contact_id"))
        score = scores_by_session.get(str(session.get("id"))) or {}
        session["review_score"] = score.get("review_score")
        session["review_count"] = score.get("review_count", 0)

    return {"event": event, "submissions": sessions, "count": len(sessions)}


async def _upsert_submission_contact(
    org_id: str, event_id: str, email: str, first_name: str, last_name: str
) -> dict:
    """Find-or-create the submitter contact for a manual add.

    contacts is unique on (event_id, email); an organizer adding a second talk
    for the same person must reuse the existing contact, not collide. Names fill
    only when the stored contact has none — a manual add never clobbers a richer
    record.
    """
    normalized = email.strip().lower()
    existing = first(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("email", normalized)
            .limit(1)
            .execute(),
            "manual_submission_contact_lookup",
        )
    )
    if existing:
        patch: dict = {}
        if first_name and not (existing.get("first_name") or "").strip():
            patch["first_name"] = first_name
        if last_name and not (existing.get("last_name") or "").strip():
            patch["last_name"] = last_name
        if patch:
            updated = first(
                await db(
                    lambda: supabase.table("contacts")
                    .update(patch)
                    .eq("id", existing["id"])
                    .eq("org_id", org_id)
                    .execute(),
                    "manual_submission_contact_fill",
                )
            )
            return updated or existing
        return existing

    created = first(
        await db(
            lambda: supabase.table("contacts")
            .insert(
                {
                    "org_id": org_id,
                    "event_id": event_id,
                    "email": normalized,
                    "first_name": first_name,
                    "last_name": last_name,
                }
            )
            .execute(),
            "manual_submission_contact_create",
        )
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not create the submitter contact")
    return created


async def _verify_taxonomy(kind: str, item_id: str, event_id: str, org_id: str, label: str) -> None:
    """A track/format named on a manual add must belong to this event and org."""
    found = first(
        await db(
            lambda: supabase.table(kind)
            .select("id")
            .eq("id", item_id)
            .eq("event_id", event_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            f"manual_submission_{kind}_lookup",
        )
    )
    if not found:
        raise HTTPException(status_code=400, detail=f"{label} not found")


@router.post("/events/{event_id}/sessions", status_code=201)
async def create_manual_submission(
    event_id: str,
    payload: ManualSubmissionRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Create a submission by hand — the same shape a CFP form would produce
    (contact + pending session + submitter participant), minus the form."""
    _user_id, org_id = auth
    await fetch_scoped("events", event_id, org_id, "Event")

    if payload.track_id:
        await _verify_taxonomy("tracks", payload.track_id, event_id, org_id, "Track")
    if payload.format_id:
        await _verify_taxonomy("formats", payload.format_id, event_id, org_id, "Format")

    parts = payload.submitter_name.strip().split()
    first_name = parts[0] if parts else ""
    last_name = " ".join(parts[1:]) if len(parts) > 1 else ""
    contact = await _upsert_submission_contact(
        org_id, event_id, payload.submitter_email, first_name, last_name
    )

    counter = await db(
        lambda: supabase.rpc("next_friendly_id", {"p_event_id": event_id}).execute(),
        "manual_submission_friendly_id",
    )
    friendly_id_raw = getattr(counter, "data", None)
    if isinstance(friendly_id_raw, list) and friendly_id_raw:
        friendly_id_raw = friendly_id_raw[0]
    if friendly_id_raw is None:
        raise HTTPException(status_code=500, detail="Could not allocate submission id")

    session_payload = {
        "org_id": org_id,
        "event_id": event_id,
        "friendly_id_raw": int(friendly_id_raw),
        "title": payload.title.strip(),
        "description": (payload.abstract or "").strip(),
        "status": "pending",
        "is_abstract": True,
        "form_answers": {},
        "submitter_contact_id": contact["id"],
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    if payload.track_id:
        session_payload["track_id"] = payload.track_id
    if payload.format_id:
        session_payload["format_id"] = payload.format_id

    session = first(
        await db(
            lambda: supabase.table("sessions").insert(session_payload).execute(),
            "manual_submission_session_create",
        )
    )
    if not session:
        raise HTTPException(status_code=500, detail="Could not create submission")

    await db(
        lambda: supabase.table("session_participants")
        .insert(
            {
                "org_id": org_id,
                "session_id": session["id"],
                "contact_id": contact["id"],
                "role": "submitter",
                "is_primary": True,
            }
        )
        .execute(),
        "manual_submission_participant_create",
    )

    if payload.track_id:
        # Mirror the CFP path: the primary track also lives in session_tracks.
        # Best-effort — the submission and its primary track_id already exist.
        try:
            await db(
                lambda: supabase.table("session_tracks")
                .upsert(
                    {"org_id": org_id, "session_id": session["id"], "track_id": payload.track_id},
                    on_conflict="session_id,track_id",
                )
                .execute(),
                "manual_submission_session_track_create",
            )
        except Exception:
            logger.warning(
                "manual submission: could not persist session track session_id=%s",
                session["id"],
                exc_info=True,
            )

    session["submitter"] = {
        "id": contact["id"],
        "first_name": contact.get("first_name"),
        "last_name": contact.get("last_name"),
        "email": contact.get("email"),
    }
    session["review_score"] = None
    session["review_count"] = 0
    return {"session": session}


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
    """One submission, everything the review drawer shows.

    `reviews` is the organizer-facing read of what evaluators scored and wrote:
    the aggregate that closes the reviewer-writes -> organizer-reads roundtrip.
    """
    _user_id, org_id = auth
    session = await fetch_scoped("sessions", session_id, org_id, "Session")
    return {
        "session": session,
        "answers": await _resolve_answers(session, org_id),
        "participants": await _load_participants(session_id, org_id),
        "reviews": await session_review_aggregate(org_id, session_id),
    }


@router.patch("/sessions/{session_id}")
async def update_session(
    session_id: str,
    payload: SessionPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Move a session between status tabs, and edit its title/abstract.

    The inbox drawer is where an organizer reads a submission, so it is also
    where they fix the typo in its title — CNT-09's "one central place to edit
    a session" is this endpoint plus that drawer, not a second screen.
    """
    _user_id, org_id = auth

    provided = payload.model_dump(exclude_unset=True)
    values: dict = {}

    if payload.status is not None:
        if payload.status not in SESSION_STATUSES:
            raise HTTPException(status_code=400, detail=f"Unknown status '{payload.status}'")
        values["status"] = payload.status

    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        if len(title) > MAX_SESSION_TITLE:
            raise HTTPException(
                status_code=400,
                detail=f"Title is too long (maximum {MAX_SESSION_TITLE} characters)",
            )
        values["title"] = title

    # `abstract` is the same column under the name the forms use; an explicit
    # empty string on either key clears it.
    description = payload.description if "description" in provided else payload.abstract
    if description is not None:
        if len(description) > MAX_SESSION_DESCRIPTION:
            raise HTTPException(
                status_code=400,
                detail=f"Description is too long (maximum {MAX_SESSION_DESCRIPTION} characters)",
            )
        values["description"] = description.strip()

    if not values:
        raise HTTPException(status_code=400, detail="Nothing to update")

    existing = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id, event_id, status")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "session_lookup",
        )
    )
    verify_org_access(existing, org_id, "Session")

    values["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = first(
        await db(
            lambda: supabase.table("sessions")
            .update(values)
            .eq("id", session_id)
            .eq("org_id", org_id)
            .execute(),
            "session_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")

    # Acceptance means the same thing on every path: a status flipped to
    # 'accepted' here (the tab/status dropdown) provisions the speaker's
    # onboarding exactly like the dedicated decision endpoint — idempotent
    # upserts, so a talk accepted twice never duplicates tasks. Only the
    # decision endpoint sends the (organizer-composed) decision email.
    if (
        values.get("status") == "accepted"
        and (existing or {}).get("status") != "accepted"
        and (existing or {}).get("event_id")
    ):
        try:
            await provision_speaker_onboarding(org_id, existing["event_id"], session_id)
        except Exception:
            logger.exception("session PATCH: onboarding provisioning failed session=%s", session_id)

    return {"session": updated}


_DECISION_STATUSES = {
    "approve": "accepted",
    "maybe": "accept_queue",
    "deny": "declined",
}

_MAYBE_TEMPLATE = {
    "key": "maybe",
    "subject": "A question about {{session_title}} for {{event_name}}",
    "body_html": (
        "<p>Hi {{first_name}},</p>"
        "<p>Thank you for submitting <strong>{{session_title}}</strong> to {{event_name}}. "
        "We're still considering it and have a note for you below.</p>"
    ),
}


def _fallback_decision_template(template_key: str) -> dict[str, str]:
    if template_key == "maybe":
        return _MAYBE_TEMPLATE
    return next(template for template in DEFAULT_TEMPLATES if template["key"] == template_key)


async def _decision_recipients(session: dict, org_id: str) -> list[dict]:
    """The submitter plus session speakers, once each and scoped at every hop."""
    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("contact_id, role")
            .eq("org_id", org_id)
            .eq("session_id", session["id"])
            .in_("role", ["speaker", "submitter"])
            .execute(),
            "decision_participants_lookup",
        )
    )
    contact_ids: list[str] = []
    if session.get("submitter_contact_id"):
        contact_ids.append(str(session["submitter_contact_id"]))
    contact_ids.extend(
        str(participant["contact_id"])
        for participant in participants
        if participant.get("contact_id")
    )
    contact_ids = list(dict.fromkeys(contact_ids))
    if not contact_ids:
        return []

    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select("id, email, first_name, last_name")
            .eq("org_id", org_id)
            .eq("event_id", session["event_id"])
            .in_("id", contact_ids)
            .execute(),
            "decision_contacts_lookup",
        )
    )
    by_id = {str(contact["id"]): contact for contact in contacts if contact.get("id")}
    return [by_id[contact_id] for contact_id in contact_ids if by_id.get(contact_id, {}).get("email")]


async def _send_decision_feedback(
    session: dict,
    org_id: str,
    decision: Literal["approve", "maybe", "deny"],
    feedback: str,
) -> bool:
    """Render, deliver, and record decision mail for this one submission."""
    event = first(
        await db(
            lambda: supabase.table("events")
            .select("id, name")
            .eq("id", session["event_id"])
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "decision_event_lookup",
        )
    )
    if not event:
        return False

    recipients = await _decision_recipients(session, org_id)
    if not recipients:
        return False

    template_key = {"approve": "accept", "maybe": "maybe", "deny": "decline"}[decision]
    template = first(
        await db(
            lambda: supabase.table("email_templates")
            .select("key, subject, body_html")
            .eq("org_id", org_id)
            .eq("event_id", session["event_id"])
            .eq("key", template_key)
            .limit(1)
            .execute(),
            "decision_template_lookup",
        )
    ) or _fallback_decision_template(template_key)

    feedback_html = html_module.escape(feedback).replace("\n", "<br>")
    sent = 0
    for recipient in recipients:
        first_name = str(recipient.get("first_name") or "")
        last_name = str(recipient.get("last_name") or "")
        context = {
            "first_name": first_name,
            "last_name": last_name,
            "full_name": " ".join(part for part in (first_name, last_name) if part).strip(),
            "email": str(recipient.get("email") or ""),
            "event_name": str(event.get("name") or ""),
            "session_title": str(session.get("title") or ""),
        }
        subject = render_template(str(template.get("subject") or ""), context)
        body_html = render_template(str(template.get("body_html") or ""), context)
        body_html += (
            '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb">'
            '<p style="margin:0 0 6px;font-weight:600">Message from the event team</p>'
            f'<p style="margin:0;white-space:normal">{feedback_html}</p></div>'
        )

        now = datetime.now(timezone.utc).isoformat()
        delivery: dict | None = None
        error: str | None = None
        status = "sent"
        try:
            delivery = await mailer.send_email(
                to=str(recipient["email"]),
                subject=subject,
                html=body_html,
            )
            sent += 1
        except Exception as exc:  # one speaker's mailbox must not block the rest
            logger.exception(
                "decision email failed session=%s contact=%s",
                session["id"],
                recipient.get("id"),
            )
            status = "failed"
            error = str(exc)

        outbox_payload: dict = {
            "to": recipient.get("email"),
            "subject": subject,
            "body_html": body_html,
            "context": context,
            "feedback": feedback,
            "decision": decision,
        }
        if delivery is not None:
            outbox_payload["delivery"] = delivery
        outbox_record = {
            "org_id": org_id,
            "event_id": session["event_id"],
            "contact_id": recipient["id"],
            "template_key": template_key,
            "payload": outbox_payload,
            "attempts": 1,
            "last_error": error,
            "status": status,
            "sent_at": now if status == "sent" else None,
            "created_at": now,
        }
        await db(
            lambda outbox_record=outbox_record: supabase.table("email_outbox")
            .insert(outbox_record)
            .execute(),
            "decision_outbox_insert",
        )
    return sent > 0


@router.post("/sessions/{session_id}/decision")
async def decide_submission(
    session_id: str,
    payload: SessionDecisionRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Make the minimum review decision and provision accepted speakers."""
    _user_id, org_id = auth
    existing = first(
        await db(
            lambda: supabase.table("sessions")
            .select("*")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "session_decision_lookup",
        )
    )
    verify_org_access(existing, org_id, "Session")

    status = _DECISION_STATUSES[payload.decision]
    updated = first(
        await db(
            lambda: supabase.table("sessions")
            .update({"status": status, "updated_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", session_id)
            .eq("org_id", org_id)
            .execute(),
            "session_decision_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")

    tasks_assigned = 0
    if payload.decision == "approve":
        tasks_assigned = await provision_speaker_onboarding(
            org_id,
            str(existing["event_id"]),
            session_id,
        )

    feedback = (payload.feedback or "").strip()
    emailed = False
    if payload.email_speaker and feedback:
        emailed = await _send_decision_feedback(updated, org_id, payload.decision, feedback)

    return {
        "session": updated,
        "onboarding": {"tasks_assigned": tasks_assigned},
        "emailed": emailed,
    }


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


# ── speaker CRM ──────────────────────────────────────────────────────────────
# The roster list lives in portal_admin_routes; this is the per-speaker detail,
# bulk CSV import, and profile edit that turn the roster into a CRM. Everything
# is org-scoped AND event-scoped: a contact belongs to exactly one event, so a
# foreign contact_id or one from another event 404s.

# task_assignments.status that count as finished work (mirrors the roster).
_DONE_STATUSES = frozenset({"approved", "done"})


class SpeakerRowInput(BaseModel):
    first_name: str = Field(default="", max_length=200)
    last_name: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=320)
    company: str = Field(default="", max_length=300)
    title: str = Field(default="", max_length=300)


class SpeakerImportRequest(BaseModel):
    """Bulk add: paste/upload CSV text, or hand a structured list (manual add)."""

    csv: str | None = Field(default=None, max_length=1_000_000)
    rows: list[SpeakerRowInput] | None = None


class SpeakerPatchRequest(BaseModel):
    first_name: str | None = Field(default=None, max_length=200)
    last_name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)
    company_name: str | None = Field(default=None, max_length=300)
    title: str | None = Field(default=None, max_length=300)
    about: str | None = Field(default=None, max_length=50_000)
    # Travel & logistics (migration 009): flights, hotel, arrival/departure,
    # ground transport, dietary and accessibility needs. Free-form because every
    # conference handles travel differently.
    logistics_notes: str | None = Field(default=None, max_length=50_000)
    # Manual workflow status (migration 010). Explicit null (or "") clears it
    # back to "not set" — the state most of a roster is in on day one.
    speaker_status: str | None = Field(default=None, max_length=32)


# Contact columns the speaker PATCH may write verbatim (strings, trimmed).
_SPEAKER_TEXT_FIELDS = ("first_name", "last_name", "company_name", "title", "about", "logistics_notes")

# contacts.speaker_status — the organizer's own record of where the conversation
# with a speaker stands. Deliberately NOT derived from the portal invite or the
# onboarding tasks: those answer "did we send a link" and "is their paperwork
# in", this answers "have they said yes".
SPEAKER_STATUSES = ("invited", "confirmed", "declined")

# Columns a later migration adds. On a database that hasn't run it, PostgREST
# rejects the whole UPDATE for one unknown column — so drop that column and save
# the rest rather than lose the organizer's other edits to a pending migration.
_OPTIONAL_CONTACT_COLUMNS = {
    "logistics_notes": "Travel & logistics isn't available yet on this database.",
    "speaker_status": "Speaker status isn't available yet on this database.",
}


def _validate_speaker_status(value: object) -> str | None:
    """One of SPEAKER_STATUSES, or None for "not set". Anything else is a 400.

    Mirrors the CHECK constraint from migration 010, so a bad value is refused
    with a readable message instead of surfacing as a 500 from Postgres.
    """
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None  # "" from a cleared <select> means "not set"
    if text not in SPEAKER_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown speaker status '{value}' — use one of: {', '.join(SPEAKER_STATUSES)}.",
        )
    return text


async def _fetch_event_contact(event_id: str, contact_id: str, org_id: str) -> dict:
    """One contact owned by this org AND on this event, or 404.

    Scoping by event_id as well as org_id is what makes a contact_id from a
    different event of the same org 404 rather than leak across events.
    """
    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("id", contact_id)
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .limit(1)
            .execute(),
            "speaker_contact_lookup",
        )
    )
    return verify_org_access(contact, org_id, "Speaker")


@router.get("/events/{event_id}/speaker-statuses")
async def list_speaker_statuses(
    event_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Every set workflow status on this event's contacts, in one flat query.

    The roster itself is assembled elsewhere; this rides alongside it so the
    list can show and filter by status without a request per row. Contacts with
    no status set are simply absent — the roster reads them as "not set".
    """
    _user_id, org_id = auth
    await fetch_event(event_id, org_id, columns="id, org_id")

    try:
        contacts = rows(
            await db(
                lambda: supabase.table("contacts")
                .select("id, speaker_status")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .execute(),
                "speaker_statuses",
            )
        )
    except APIError as exc:
        # Pre-010 database: no column, so nobody has a status. An empty map is
        # the honest answer and leaves the roster fully usable.
        if "speaker_status" not in str(exc):
            raise
        logger.warning("speakers: speaker_status column missing — reporting no statuses")
        contacts = []

    return {
        "statuses": [
            {"contact_id": contact["id"], "speaker_status": contact.get("speaker_status")}
            for contact in contacts
            if contact.get("id") and contact.get("speaker_status")
        ]
    }


@router.get("/events/{event_id}/speakers/{contact_id}")
async def get_speaker_profile(
    event_id: str,
    contact_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    """The full profile drawer: identity, submissions, scheduled sessions,
    onboarding progress, and the email history for this speaker on this event.

    A flat handful of grouped queries — never one per row — so the drawer opens
    cheaply even for a speaker on many sessions.
    """
    _user_id, org_id = auth
    event = await fetch_event(event_id, org_id, columns="id, org_id, name")
    contact = await _fetch_event_contact(event_id, contact_id, org_id)

    # Submissions this speaker filed (their CFP entries).
    submissions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id, friendly_id, title, status, submitted_at")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("submitter_contact_id", contact_id)
            .execute(),
            "speaker_submissions",
        )
    )
    submissions.sort(key=lambda s: str(s.get("submitted_at") or ""), reverse=True)

    # Sessions this speaker is on the program for (participant), scheduled first.
    participations = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("session_id, role, is_primary")
            .eq("org_id", org_id)
            .eq("contact_id", contact_id)
            .execute(),
            "speaker_participations",
        )
    )
    part_by_session: dict[str, dict] = {}
    for part in participations:
        session_id = part.get("session_id")
        if session_id and session_id not in part_by_session:
            part_by_session[session_id] = part
    session_ids = sorted(part_by_session)

    session_rows: list[dict] = []
    if session_ids:
        session_rows = rows(
            await db(
                lambda: supabase.table("sessions")
                .select("id, friendly_id, title, status, starts_at, ends_at, room_id")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .in_("id", session_ids)
                .execute(),
                "speaker_sessions",
            )
        )
    room_ids = sorted({s["room_id"] for s in session_rows if s.get("room_id")})
    rooms_by_id: dict[str, str] = {}
    if room_ids:
        rooms_by_id = {
            r["id"]: r.get("name")
            for r in rows(
                await db(
                    lambda: supabase.table("rooms")
                    .select("id, name")
                    .eq("org_id", org_id)
                    .eq("event_id", event_id)
                    .in_("id", room_ids)
                    .execute(),
                    "speaker_session_rooms",
                )
            )
            if r.get("id")
        }
    sessions_out = []
    for session in session_rows:
        part = part_by_session.get(session["id"], {})
        sessions_out.append(
            {
                "id": session["id"],
                "friendly_id": session.get("friendly_id"),
                "title": session.get("title"),
                "status": session.get("status"),
                "starts_at": session.get("starts_at"),
                "ends_at": session.get("ends_at"),
                "room": rooms_by_id.get(session.get("room_id")),
                "role": part.get("role"),
                "is_primary": bool(part.get("is_primary")),
                "scheduled": bool(session.get("starts_at")),
            }
        )
    sessions_out.sort(
        key=lambda s: (not s["scheduled"], str(s.get("starts_at") or ""), str(s.get("title") or ""))
    )

    # Onboarding: this speaker's task assignments, joined to this event's tasks.
    assignments = rows(
        await db(
            lambda: supabase.table("task_assignments")
            .select("id, task_id, status, completed_at")
            .eq("org_id", org_id)
            .eq("contact_id", contact_id)
            .execute(),
            "speaker_assignments",
        )
    )
    task_ids = sorted({a["task_id"] for a in assignments if a.get("task_id")})
    tasks_by_id: dict[str, dict] = {}
    if task_ids:
        tasks_by_id = {
            t["id"]: t
            for t in rows(
                await db(
                    lambda: supabase.table("tasks")
                    .select("id, name, kind, due_at, required")
                    .eq("org_id", org_id)
                    .eq("event_id", event_id)
                    .in_("id", task_ids)
                    .execute(),
                    "speaker_tasks",
                )
            )
            if t.get("id")
        }
    onboarding = []
    for assignment in assignments:
        task = tasks_by_id.get(assignment.get("task_id"))
        if not task:
            continue  # an assignment to some other event's task is not shown here
        onboarding.append(
            {
                "assignment_id": assignment["id"],
                "task_id": task["id"],
                "name": task.get("name"),
                "kind": task.get("kind"),
                "status": assignment.get("status"),
                "due_at": task.get("due_at"),
                "required": bool(task.get("required")),
                "completed_at": assignment.get("completed_at"),
            }
        )
    onboarding.sort(key=lambda t: (t["status"] in _DONE_STATUSES, str(t.get("name") or "")))
    tasks_total = len(onboarding)
    tasks_done = sum(1 for t in onboarding if t["status"] in _DONE_STATUSES)

    # Communication history: this speaker's outbox rows for this event.
    outbox = rows(
        await db(
            lambda: supabase.table("email_outbox")
            .select("id, template_key, payload, status, sent_at, created_at, last_error")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("contact_id", contact_id)
            .order("created_at", desc=True)
            .execute(),
            "speaker_communications",
        )
    )
    communications = [
        {
            "id": row.get("id"),
            "template_key": row.get("template_key"),
            "subject": (row.get("payload") or {}).get("subject"),
            "status": row.get("status"),
            "sent_at": row.get("sent_at"),
            "created_at": row.get("created_at"),
            "error": row.get("last_error"),
        }
        for row in outbox
    ]

    invited = bool(
        first(
            await db(
                lambda: supabase.table("magic_link_tokens")
                .select("id")
                .eq("org_id", org_id)
                .eq("purpose", "portal")
                .eq("contact_id", contact_id)
                .limit(1)
                .execute(),
                "speaker_invited_lookup",
            )
        )
    )

    speaker = {
        "contact_id": contact_id,
        "name": speaker_crm.full_name(
            contact.get("first_name"), contact.get("last_name"), contact.get("email")
        ),
        "first_name": contact.get("first_name") or "",
        "last_name": contact.get("last_name") or "",
        "email": contact.get("email"),
        "company_name": contact.get("company_name"),
        "title": contact.get("title"),
        "about": contact.get("about"),
        # Absent on a database that hasn't run migration 009 yet — reads as null
        # rather than blowing up the whole drawer.
        "logistics_notes": contact.get("logistics_notes"),
        # The organizer's manual workflow status (migration 010). Null = not
        # set, and stays distinct from `invited` below, which is derived from
        # whether a portal magic link was ever minted.
        "speaker_status": contact.get("speaker_status"),
        "photo_url": contact.get("photo_url"),
        "pronouns": contact.get("pronouns"),
        "linkedin_url": contact.get("linkedin_url"),
        "twitter_url": contact.get("twitter_url"),
        "phone": contact.get("phone"),
        "last_portal_access_at": contact.get("last_portal_access_at"),
        "invited": invited,
        "session_count": len(sessions_out),
        "submission_count": len(submissions),
        "tasks_total": tasks_total,
        "tasks_done": tasks_done,
        "tasks_outstanding": max(tasks_total - tasks_done, 0),
    }
    return {
        "event": {"id": event["id"], "name": event.get("name")},
        "speaker": speaker,
        "submissions": submissions,
        "sessions": sessions_out,
        "onboarding": onboarding,
        "communications": communications,
    }


@router.post("/events/{event_id}/speakers/import")
async def import_speakers(
    event_id: str,
    payload: SpeakerImportRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Bulk-add speakers by upserting contacts on ``(event_id, email)``.

    One bad row never aborts the batch: it lands in ``errors`` and the rest
    import. Returns ``{created, updated, skipped, errors, total}`` so the UI can
    show an honest summary of what a paste/upload did.
    """
    _user_id, org_id = auth
    await fetch_event(event_id, org_id)

    parse_errors: list[dict] = []
    if payload.csv is not None and payload.csv.strip():
        parsed, header_error, parse_errors = speaker_crm.parse_speaker_csv(payload.csv)
        if header_error:
            raise HTTPException(status_code=400, detail=header_error)
    elif payload.rows:
        parsed = [
            {
                "first_name": row.first_name,
                "last_name": row.last_name,
                "email": row.email,
                "company": row.company,
                "title": row.title,
                "line": index,
            }
            for index, row in enumerate(payload.rows, start=1)
        ]
    else:
        raise HTTPException(status_code=400, detail="Provide CSV text or a list of rows to import.")

    valid, row_errors, duplicate_skips = speaker_crm.collect_import(parsed)
    # Rows that couldn't even be parsed are errors too — surface them alongside.
    errors = parse_errors + row_errors

    created = 0
    updated = 0
    skipped = duplicate_skips
    if valid:
        emails = [row["email"] for row in valid]
        existing_rows = rows(
            await db(
                lambda: supabase.table("contacts")
                .select("*")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .in_("email", emails)
                .execute(),
                "speaker_import_existing",
            )
        )
        existing_by_email = {
            speaker_crm.normalize_email(c.get("email")): c for c in existing_rows if c.get("email")
        }

        to_insert: list[dict] = []
        for row in valid:
            existing = existing_by_email.get(row["email"])
            if existing:
                patch = speaker_crm.contact_patch(row, existing)
                if patch:
                    await db(
                        lambda existing=existing, patch=patch: supabase.table("contacts")
                        .update(patch)
                        .eq("id", existing["id"])
                        .eq("org_id", org_id)
                        .execute(),
                        "speaker_import_update",
                    )
                    updated += 1
                else:
                    skipped += 1
            else:
                to_insert.append(speaker_crm.contact_insert(org_id, event_id, row))

        if to_insert:
            await db(
                lambda: supabase.table("contacts").insert(to_insert).execute(),
                "speaker_import_insert",
            )
            created = len(to_insert)

    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "total": len(parsed) + len(parse_errors),
    }


@router.patch("/events/{event_id}/speakers/{contact_id}")
async def update_speaker(
    event_id: str,
    contact_id: str,
    payload: SpeakerPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Edit one speaker's profile fields (name/email/company/title/bio)."""
    _user_id, org_id = auth
    await fetch_event(event_id, org_id)
    contact = await _fetch_event_contact(event_id, contact_id, org_id)

    provided = payload.model_dump(exclude_unset=True)
    patch: dict = {}
    for key in _SPEAKER_TEXT_FIELDS:
        if key in provided:
            value = provided[key]
            patch[key] = value.strip() if isinstance(value, str) else value

    if "speaker_status" in provided:
        patch["speaker_status"] = _validate_speaker_status(provided["speaker_status"])

    if "email" in provided:
        email = speaker_crm.normalize_email(provided.get("email") or "")
        if not speaker_crm.looks_like_email(email):
            raise HTTPException(status_code=400, detail="Enter a valid email address")
        if email != speaker_crm.normalize_email(contact.get("email") or ""):
            # (event_id, email) is unique — refuse a collision rather than let the
            # constraint turn into a 500 the organizer can't read.
            clash = first(
                await db(
                    lambda: supabase.table("contacts")
                    .select("id")
                    .eq("org_id", org_id)
                    .eq("event_id", event_id)
                    .eq("email", email)
                    .limit(1)
                    .execute(),
                    "speaker_email_clash",
                )
            )
            if clash and clash.get("id") != contact_id:
                raise HTTPException(status_code=409, detail="Another speaker already uses that email.")
            patch["email"] = email

    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    patch["updated_at"] = datetime.now(timezone.utc).isoformat()

    async def _write(values: dict) -> dict | None:
        return first(
            await db(
                lambda: supabase.table("contacts")
                .update(values)
                .eq("id", contact_id)
                .eq("org_id", org_id)
                .execute(),
                "speaker_update",
            )
        )

    try:
        updated = await _write(patch)
    except APIError as exc:
        # logistics_notes (009) and speaker_status (010) arrive by migration —
        # see _OPTIONAL_CONTACT_COLUMNS.
        missing = [
            column
            for column in _OPTIONAL_CONTACT_COLUMNS
            if column in patch and column in str(exc)
        ]
        if not missing:
            raise
        logger.warning("speakers: column(s) %s missing — saving other fields", ", ".join(missing))
        for column in missing:
            patch.pop(column)
        if len(patch) == 1:  # only updated_at left — nothing real to write
            raise HTTPException(
                status_code=503,
                detail=_OPTIONAL_CONTACT_COLUMNS[missing[0]],
            ) from exc
        updated = await _write(patch)

    if not updated:
        raise HTTPException(status_code=404, detail="Speaker not found")
    updated["name"] = speaker_crm.full_name(
        updated.get("first_name"), updated.get("last_name"), updated.get("email")
    )
    # Absent pre-010: the wire shape stays stable so the UI reads "not set"
    # rather than undefined.
    updated.setdefault("speaker_status", None)
    return {"speaker": updated}
