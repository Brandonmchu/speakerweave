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
from services import crm, submitter_selfservice
from services.forms import (
    abstract_from_answers,
    apply_live_choices,
    classify_taxonomy_fields,
    live_choice_map,
    load_form_layout,
    load_live_taxonomy,
    load_question_rules,
    resolve_taxonomy_ids,
    sanitize_html,
    taxonomy_names,
    to_public_field,
    with_live_rule_values,
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

# A talk can be co-presented. Three is the practical ceiling for a conference
# session and, more to the point, a bound on how many contacts one anonymous
# POST can create.
MAX_CO_SPEAKERS = 3


class CoSpeakerInput(BaseModel):
    """A co-presenter named by the submitter on the public form.

    Email is the identity: it is what the contact is upserted on, so a
    co-speaker who later submits their own talk (or is imported by the
    organizer) resolves to the same person rather than a duplicate.
    """

    email: EmailStr
    first_name: str = Field(default="", max_length=120)
    last_name: str = Field(default="", max_length=120)


class SubmissionRequest(BaseModel):
    email: EmailStr
    first_name: str = Field(default="", max_length=120)
    last_name: str = Field(default="", max_length=120)
    answers: dict[str, Any] = Field(default_factory=dict)
    title: str = Field(..., min_length=1, max_length=300)
    description: str = Field(default="", max_length=10000)
    # Optional co-presenters. Unbounded here on purpose so an over-long list
    # gets a readable 400 from _clean_co_speakers instead of a raw 422.
    co_speakers: list[CoSpeakerInput] = Field(default_factory=list)


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


def _clean_co_speakers(
    co_speakers: list[CoSpeakerInput], submitter_email: str
) -> list[CoSpeakerInput]:
    """Validate the co-speaker list, or 400 with something a speaker can act on.

    Three rules, all of which the browser also enforces but none of which it is
    trusted for: at most ``MAX_CO_SPEAKERS``, nobody listed twice, and nobody
    listed who is the submitter. The last two matter beyond tidiness — the
    contact upsert is keyed on (event, email), so a repeat would resolve to a
    contact already on the session and try to add them as a participant twice.
    """
    if len(co_speakers) > MAX_CO_SPEAKERS:
        raise HTTPException(
            status_code=400,
            detail=f"You can add up to {MAX_CO_SPEAKERS} co-speakers.",
        )

    submitter = submitter_email.strip().lower()
    seen: set[str] = set()
    for co_speaker in co_speakers:
        email = str(co_speaker.email).strip().lower()
        if email == submitter:
            raise HTTPException(
                status_code=400,
                detail="A co-speaker needs a different email address than yours.",
            )
        if email in seen:
            raise HTTPException(
                status_code=400,
                detail=f"{email} is listed as a co-speaker more than once.",
            )
        seen.add(email)
    return co_speakers


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


async def _fields_and_taxonomy(
    form: dict,
) -> tuple[list[dict], dict[str, str], list[dict], list[dict], dict[str, list[str]]]:
    """The form's public fields plus the live taxonomy they are resolved against.

    One place decides which questions are the Track and Session format ones, so
    the choices the renderer shows, the operands its conditional rules compare
    against, and the rows a submission maps to all come from the same verdict.
    """
    fields = await _public_fields(form)
    tracks, formats = await load_live_taxonomy(form["org_id"], form["event_id"])
    track_names, format_names = taxonomy_names(tracks), taxonomy_names(formats)
    classified = classify_taxonomy_fields(fields, track_names, format_names)
    choices = live_choice_map(fields, classified, track_names, format_names)
    return fields, classified, tracks, formats, choices


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

    # Track / Session format choices come from the event's tables, not from the
    # snapshot the question was built with: an organizer who renames a track in
    # Settings must see the new name on the very next load of this form.
    fields, _classified, _tracks, _formats, choices = await _fields_and_taxonomy(form)
    fields = apply_live_choices(fields, choices)

    # ...and so must the CONDITIONAL LOGIC keyed off those choices. A rule saved
    # as `Session format equals "Workshop"` is comparing against a name this page
    # no longer offers, so it could never fire again; re-pointing the operand at
    # the live name is what makes "show when format is Workshop" survive the
    # rename that produced "Workshop (120 min)".
    rules = with_live_rule_values(
        await load_question_rules(form["id"], form["org_id"]), choices
    )

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
        "fields": fields,
        "question_rules": rules,
    }


async def _upsert_contact(
    org_id: str,
    event_id: str,
    raw_email: str,
    first_name: str = "",
    last_name: str = "",
) -> dict:
    """Get-or-create the contact for (event_id, lower(email)).

    contacts.email is citext with UNIQUE (event_id, email), so the DB is the
    arbiter: on a lost insert race (23505) we re-read the winner's row. Used for
    the submitter and, identically, for each co-speaker they name.
    """
    email = raw_email.strip().lower()

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
        if first_name and not existing.get("first_name"):
            patch["first_name"] = first_name
        if last_name and not existing.get("last_name"):
            patch["last_name"] = last_name
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
        "first_name": first_name,
        "last_name": last_name,
    }
    try:
        created = first(
            await db(
                lambda: supabase.table("contacts").insert(insert_payload).execute(),
                "public_contact_create",
            )
        )
        if created:
            # Mirror into the org-level speaker directory. Best-effort by
            # contract (services/crm.py): a directory write may never cost the
            # submitter their talk.
            await crm.sync_contact(org_id, created)
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
    fields, classified, tracks, formats, choices = await _fields_and_taxonomy(form)
    field_ids = {field["id"] for field in fields}
    answers_in = _clean_answers(payload.answers, field_ids)

    # Re-run the renderer's own validation server-side, rules included: the
    # browser is not a trusted validator, and a hidden branch's leftover answers
    # must not be stored as if the speaker had given them. The rules are
    # re-pointed at the live taxonomy names from the SAME map the GET used, so
    # the two surfaces cannot disagree about which branch was open.
    rules = with_live_rule_values(await load_question_rules(form["id"], org_id), choices)
    answers, problem = validate_submission(fields, rules, answers_in)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    # Vet the co-presenter list BEFORE anything is written, so a bad one costs a
    # 400 and no rows rather than a half-built submission.
    co_speakers = _clean_co_speakers(payload.co_speakers, str(payload.email))

    contact = await _upsert_contact(
        org_id, event_id, str(payload.email), payload.first_name, payload.last_name
    )

    # Co-speakers become contacts on this event exactly like the submitter did —
    # same (event, email) upsert, so naming someone who already exists reuses
    # their record instead of duplicating it. Done before the session insert:
    # a contact we can't create is a failure worth stopping on, and a stray
    # contact with no session is harmless where a session missing its
    # co-speakers is not.
    co_speaker_contacts = [
        await _upsert_contact(
            org_id, event_id, str(co.email), co.first_name, co.last_name
        )
        for co in co_speakers
    ]

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

    # Track AND format are resolved against the event's live rows by the name
    # the speaker was actually offered — so a renamed track still maps, and the
    # format question stops being answered into a void.
    track_ids = resolve_taxonomy_ids(fields, classified, "track", answers, tracks)
    format_ids = resolve_taxonomy_ids(fields, classified, "format", answers, formats)

    # The public form has no separate description input: the abstract is one of
    # its questions. Fall back to that answer so `sessions.description` holds
    # the prose the speaker wrote — the submitter's edit form, the reviewer
    # scorecard and the organizer drawer all read this column.
    description = payload.description.strip() or abstract_from_answers(fields, answers)

    session_payload = {
        "org_id": org_id,
        "event_id": event_id,
        "friendly_id_raw": int(friendly_id_raw),
        "title": payload.title.strip(),
        "description": description,
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
    if format_ids:
        session_payload["format_id"] = format_ids[0]
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

    # The submitter is written twice on purpose: once as the primary 'speaker'
    # and once as the 'submitter' of record. Consumers that resolve a session's
    # speakers filter role='speaker' first (falling back to the submitter only
    # when there are no speaker rows) — so if the submitter were only a
    # 'submitter' row, adding a co-speaker would silently DROP them from the
    # public program and from speaker double-booking checks. The dual row keeps
    # the submitter a first-class speaker regardless of co-speakers.
    participants = [
        {
            "org_id": org_id,
            "session_id": session["id"],
            "contact_id": contact["id"],
            "role": "speaker",
            "is_primary": True,
        },
        {
            "org_id": org_id,
            "session_id": session["id"],
            "contact_id": contact["id"],
            "role": "submitter",
            "is_primary": False,
        },
    ] + [
        {
            "org_id": org_id,
            "session_id": session["id"],
            "contact_id": co_contact["id"],
            "role": "speaker",
            "is_primary": False,
        }
        for co_contact in co_speaker_contacts
    ]
    await db(
        lambda: supabase.table("session_participants").insert(participants).execute(),
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

    # Hand the submitter an IN-APP manage link on the confirmation screen: they
    # just proved ownership of this email by submitting from it, so mint their
    # own submitter token now — scoped to this contact — and return it. The
    # confirmation screen renders a clickable + copyable manage link with no
    # dependence on email delivery (the emailed link stays as a fallback path).
    # Best-effort: a mint failure must never fail an already-created submission.
    manage_token: str | None = None
    manage_url: str | None = None
    try:
        minted = await submitter_selfservice.mint_manage_link(org_id, slug, contact["id"])
        manage_token, manage_url = minted["token"], minted["url"]
    except Exception:  # never 500 a good submission over a courtesy link
        logger.warning(
            "public: could not mint manage token session_id=%s", session["id"], exc_info=True
        )

    return {
        "id": session["id"],
        "friendly_id": session.get("friendly_id"),
        "manage_token": manage_token,
        "manage_url": manage_url,
    }


# ── submitter self-service ──────────────────────────────────────────────────
# After submitting, a speaker can manage their own submissions. There is no
# Clerk account: a magic-link token (scope 'submitter') is the bearer credential
# every call below carries, scoping it to one contact and one event's talks.


class ManageLinkRequest(BaseModel):
    email: EmailStr


class SubmissionEditRequest(BaseModel):
    # Token in the body OR the X-Submitter-Token header (either works).
    token: str | None = Field(default=None, max_length=400)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    abstract: str | None = Field(default=None, max_length=10000)
    # A track/format id, "" / null to clear. Validated against the event server-side.
    track_id: str | None = Field(default=None, max_length=64)
    format_id: str | None = Field(default=None, max_length=64)


class WithdrawRequest(BaseModel):
    token: str | None = Field(default=None, max_length=400)


async def _require_submitter(token: str | None) -> tuple[str, str]:
    """Resolve a submitter token to ``(org_id, contact_id)`` or 401.

    Never trust an id in the path or body without this: the token is the only
    thing that says which contact — and therefore which event's submissions —
    the caller may touch."""
    try:
        return await submitter_selfservice.validate_token(token or "")
    except submitter_selfservice.InvalidSubmitterToken as exc:
        raise HTTPException(
            status_code=401, detail="This manage link is invalid or has expired."
        ) from exc


@router.post("/forms/{slug}/manage-link")
@limiter.limit(RATE_PUBLIC_WRITE)
async def request_manage_link(request: Request, slug: str, payload: ManageLinkRequest):
    """Email a manage link IF this address owns ≥1 submission for the event.

    ALWAYS returns the same generic 200, whether or not the email exists, so the
    endpoint can't be used to discover who submitted."""
    form = await _get_form_by_slug(slug)
    await submitter_selfservice.issue_manage_link(
        form["org_id"], form["event_id"], slug, str(payload.email)
    )
    return {"ok": True, "message": submitter_selfservice.MANAGE_LINK_MESSAGE}


@router.get("/submissions")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def list_my_submissions(request: Request, token: str = ""):
    """This submitter's submissions + the event's editable taxonomy."""
    org_id, contact_id = await _require_submitter(token)
    return await submitter_selfservice.list_submissions(org_id, contact_id)


@router.patch("/submissions/{submission_id}")
@limiter.limit(RATE_PUBLIC_WRITE)
async def edit_my_submission(
    request: Request, submission_id: str, payload: SubmissionEditRequest
):
    """Edit title/abstract/track/format while the submission is still editable."""
    token = payload.token or request.headers.get("X-Submitter-Token")
    org_id, contact_id = await _require_submitter(token)
    patch = payload.model_dump(exclude_unset=True, exclude={"token"})
    return await submitter_selfservice.edit_submission(org_id, contact_id, submission_id, patch)


@router.post("/submissions/{submission_id}/withdraw")
@limiter.limit(RATE_PUBLIC_WRITE)
async def withdraw_my_submission(
    request: Request, submission_id: str, payload: WithdrawRequest
):
    """Withdraw a still-pending, still-open submission."""
    token = payload.token or request.headers.get("X-Submitter-Token")
    org_id, contact_id = await _require_submitter(token)
    return await submitter_selfservice.withdraw_submission(org_id, contact_id, submission_id)
