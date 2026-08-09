"""Public (unauthenticated) CFP surface: render a form, accept a submission.

No JWT here — the form slug is the only credential. Org/event context is
derived from the form row itself, never from the request, so a submission can
only ever land in the org that owns the slug.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from postgrest.exceptions import APIError
from pydantic import BaseModel, EmailStr, Field

from security.rate_limiting import RATE_PUBLIC_DEFAULT, RATE_PUBLIC_WRITE, limiter
from services.forms import (
    load_form_layout,
    load_question_rules,
    sanitize_html,
    to_public_field,
)
from services.question_rules import validate_submission
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/public", tags=["public"])
logger = logging.getLogger(__name__)

# Guardrails on a public, unauthenticated write. Answers are keyed by field id
# and must be scalar: a nested object/array is not a form answer, and an
# unbounded string is a cheap way to fill the sessions table.
MAX_ANSWER_KEYS = 100
MAX_ANSWER_STR_LEN = 10000

# Only a choice question can name a track. Matching every free-text answer
# against the track list would turn an abstract that mentions "Platform" into a
# track assignment.
TRACK_ANSWER_FIELD_TYPES = {"dropdown", "multi_select"}


class SubmissionRequest(BaseModel):
    email: EmailStr
    first_name: str = Field(default="", max_length=120)
    last_name: str = Field(default="", max_length=120)
    answers: dict[str, Any] = Field(default_factory=dict)
    title: str = Field(..., min_length=1, max_length=300)
    description: str = Field(default="", max_length=10000)


def _parse_iso(value: Any) -> datetime | None:
    """An aware datetime from an ISO string, or None. Naive input is read UTC."""
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _clean_answers(raw: dict[str, Any], field_ids: set[str]) -> dict[str, Any]:
    """Validate a raw answer map, then drop everything not a current field id.

    The renderer only ever posts answers to fields it showed, but this endpoint
    is public and cannot trust that. We reject an answer set that is oversized,
    holds a non-scalar value, or carries an over-long string; then we whitelist
    to the form's own field ids so a hand-rolled POST can't stuff arbitrary keys
    into form_answers. (Hidden-field answers are dropped later, after rules.)
    """
    if len(raw) > MAX_ANSWER_KEYS:
        raise HTTPException(status_code=400, detail="Too many answers submitted.")
    cleaned: dict[str, Any] = {}
    for key, value in raw.items():
        if value is not None and not isinstance(value, (str, bool, int, float)):
            raise HTTPException(
                status_code=400, detail="Answers must be text, numbers, or true/false."
            )
        if isinstance(value, str) and len(value) > MAX_ANSWER_STR_LEN:
            raise HTTPException(status_code=400, detail="An answer is too long.")
        if key in field_ids:
            cleaned[key] = value
    return cleaned


def _choice_values(value: Any) -> list[str]:
    """A choice answer as a list. A multi_select posts its picks as one
    comma-separated string (the answer map is scalar-only by design)."""
    if value is None or isinstance(value, bool):
        return []
    text = str(value).strip()
    if not text:
        return []
    return [part.strip() for part in text.split(",") if part.strip()]


async def _tracks_from_answers(
    org_id: str, event_id: str, fields: list[dict], answers: dict[str, Any]
) -> list[str]:
    """Track ids this submission selected, in the order the speaker chose them.

    A talk is submitted to one or more tracks: a choice answer that matches a
    track's name (or carries its id outright) selects it, and a multi_select
    can select several at once. The first is the session's PRIMARY track and
    goes on `sessions.track_id` exactly as a single-track submission always
    did; the rest join it in `session_tracks`. No match = no track, which is
    also what happened before this existed.
    """
    answered = [
        field
        for field in fields
        if field.get("type") in TRACK_ANSWER_FIELD_TYPES and answers.get(field["id"]) is not None
    ]
    if not answered:
        return []

    tracks = rows(
        await db(
            lambda: supabase.table("tracks")
            .select("id, name")
            .eq("event_id", event_id)
            .eq("org_id", org_id)
            .execute(),
            "public_submission_tracks",
        )
    )
    if not tracks:
        return []
    by_key: dict[str, str] = {}
    for track in tracks:
        by_key.setdefault(str(track["id"]).casefold(), track["id"])
        name = str(track.get("name") or "").strip().casefold()
        if name:
            by_key.setdefault(name, track["id"])

    # `fields` is already in page/order order, so "first" is the first choice
    # on the form, not whatever order the browser serialized.
    chosen: list[str] = []
    for field in answered:
        for value in _choice_values(answers.get(field["id"])):
            track_id = by_key.get(value.casefold())
            if track_id and track_id not in chosen:
                chosen.append(track_id)
    return chosen


async def _get_form_by_slug(slug: str) -> dict:
    res = await db(
        lambda: supabase.table("forms").select("*").eq("slug", slug).limit(1).execute(),
        "public_form_by_slug",
    )
    form = first(res)
    if not form:
        raise HTTPException(status_code=404, detail="Form not found")
    return form


async def _public_fields(form: dict) -> list[dict]:
    layout = await load_form_layout(form["id"], form["org_id"])
    return [to_public_field(entry) for entry in layout]


@router.get("/forms/{slug}")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def get_public_form(request: Request, slug: str):
    """Form + its ordered fields + its conditional logic — everything the
    public renderer needs to show the same form the server will validate."""
    form = await _get_form_by_slug(slug)

    event_res = await db(
        lambda: supabase.table("events")
        .select("id, name, slug, starts_at, ends_at, timezone, location")
        .eq("id", form["event_id"])
        .eq("org_id", form["org_id"])
        .limit(1)
        .execute(),
        "public_form_event",
    )
    event = first(event_res)

    # Defense in depth: sanitize on the way out too, so a row written before the
    # server-side sanitizer existed (or by some other path) can't fire in a
    # speaker's browser via dangerouslySetInnerHTML.
    settings = dict(form.get("settings") or {})
    if settings.get("confirmation_html"):
        settings["confirmation_html"] = sanitize_html(settings["confirmation_html"])

    return {
        "form": {
            "id": form["id"],
            "slug": form["slug"],
            "name": form["name"],
            "kind": form.get("kind"),
            "welcome_html": sanitize_html(form.get("welcome_html")),
            "settings": settings,
        },
        "event": event,
        "fields": await _public_fields(form),
        "question_rules": await load_question_rules(form["id"], form["org_id"]),
    }


async def _upsert_contact(org_id: str, event_id: str, payload: SubmissionRequest) -> dict:
    """Get-or-create the contact for (event_id, lower(email)).

    contacts.email is citext with UNIQUE (event_id, email), so the DB is the
    arbiter: on a lost insert race (23505) we re-read the winner's row.
    """
    email = str(payload.email).strip().lower()

    def _select():
        return (
            supabase.table("contacts")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("email", email)
            .limit(1)
            .execute()
        )

    existing = first(await db(_select, "public_contact_lookup"))
    if existing and existing.get("org_id") == org_id:
        # Fill blanks only — never clobber an organizer-curated name.
        patch = {}
        if payload.first_name and not existing.get("first_name"):
            patch["first_name"] = payload.first_name
        if payload.last_name and not existing.get("last_name"):
            patch["last_name"] = payload.last_name
        if patch:
            updated = first(
                await db(
                    lambda: supabase.table("contacts")
                    .update(patch)
                    .eq("id", existing["id"])
                    .eq("org_id", org_id)
                    .execute(),
                    "public_contact_fill",
                )
            )
            return updated or existing
        return existing

    insert_payload = {
        "org_id": org_id,
        "event_id": event_id,
        "email": email,
        "first_name": payload.first_name,
        "last_name": payload.last_name,
    }
    try:
        created = first(
            await db(
                lambda: supabase.table("contacts").insert(insert_payload).execute(),
                "public_contact_create",
            )
        )
        if created:
            return created
    except APIError as exc:
        if getattr(exc, "code", None) != "23505":
            raise
        logger.info("public: lost contact insert race event_id=%s", event_id)

    raced = first(await db(_select, "public_contact_relookup"))
    if not raced or raced.get("org_id") != org_id:
        raise HTTPException(status_code=500, detail="Could not create contact")
    return raced


@router.post("/forms/{slug}/submissions", status_code=201)
@limiter.limit(RATE_PUBLIC_WRITE)
async def create_submission(request: Request, slug: str, payload: SubmissionRequest):
    """Public CFP submission -> contact + pending session + submitter participant."""
    form = await _get_form_by_slug(slug)
    org_id, event_id = form["org_id"], form["event_id"]
    settings = form.get("settings") or {}

    # A closed CFP stops accepting server-side, not just in the browser: the
    # public GET may be cached, and a hand-rolled POST ignores the UI entirely.
    close_at = _parse_iso(settings.get("close_at"))
    if close_at is not None and close_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=403, detail="This call for papers is closed.")

    # Whitelist the answer set to the form's own fields before it touches rule
    # evaluation, and reject an oversized/non-scalar payload outright.
    fields = await _public_fields(form)
    field_ids = {field["id"] for field in fields}
    answers_in = _clean_answers(payload.answers, field_ids)

    # Re-run the renderer's own validation server-side, rules included: the
    # browser is not a trusted validator, and a hidden branch's leftover answers
    # must not be stored as if the speaker had given them.
    rules = await load_question_rules(form["id"], org_id)
    answers, problem = validate_submission(fields, rules, answers_in)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    contact = await _upsert_contact(org_id, event_id, payload)

    # Per-submitter cap on this form. Best-effort by design: the count-then-check
    # is not transactional, so two concurrent submissions can both pass and land
    # one over the limit. That is an acceptable slack for a CFP guardrail; a hard
    # cap would need a DB constraint or a serializable transaction.
    limit = settings.get("submission_limit")
    if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0:
        prior = rows(
            await db(
                lambda: supabase.table("sessions")
                .select("id, status")
                .eq("org_id", org_id)
                .eq("source_form_id", form["id"])
                .eq("submitter_contact_id", contact["id"])
                .execute(),
                "public_submission_limit_count",
            )
        )
        live = [row for row in prior if row.get("status") != "withdrawn"]
        if len(live) >= limit:
            raise HTTPException(status_code=403, detail="Submission limit reached.")

    # friendly_id_raw comes from a DB counter (migration 001): atomic upsert,
    # no read-modify-write race. sessions.friendly_id is GENERATED from it.
    counter = await db(
        lambda: supabase.rpc("next_friendly_id", {"p_event_id": event_id}).execute(),
        "next_friendly_id",
    )
    friendly_id_raw = getattr(counter, "data", None)
    if isinstance(friendly_id_raw, list) and friendly_id_raw:
        friendly_id_raw = friendly_id_raw[0]
    if friendly_id_raw is None:
        raise HTTPException(status_code=500, detail="Could not allocate submission id")

    track_ids = await _tracks_from_answers(org_id, event_id, fields, answers)

    session_payload = {
        "org_id": org_id,
        "event_id": event_id,
        "friendly_id_raw": int(friendly_id_raw),
        "title": payload.title.strip(),
        "description": payload.description,
        "status": "pending",
        "is_abstract": True,
        "source_form_id": form["id"],
        "form_answers": answers,
        "submitter_contact_id": contact["id"],
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    if track_ids:
        # The primary track keeps living on the session, so every reader that
        # already knows about track_id (schedule, program, v1, dashboard) sees
        # this submission exactly as it would have seen a single-track one.
        session_payload["track_id"] = track_ids[0]
    session = first(
        await db(
            lambda: supabase.table("sessions")
            .insert(session_payload)
            .execute(),
            "public_session_create",
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
        "public_session_participant_create",
    )

    if track_ids:
        # Best-effort by design: the submission is already accepted and its
        # primary track is already on the row, so a failure here costs the
        # extra track memberships, not the speaker's talk.
        memberships = [
            {"org_id": org_id, "session_id": session["id"], "track_id": track_id}
            for track_id in track_ids
        ]
        try:
            await db(
                lambda: supabase.table("session_tracks")
                .upsert(memberships, on_conflict="session_id,track_id")
                .execute(),
                "public_session_tracks_create",
            )
        except APIError:
            logger.warning(
                "public: could not persist session tracks session_id=%s", session["id"]
            )

    return {"id": session["id"], "friendly_id": session.get("friendly_id")}
