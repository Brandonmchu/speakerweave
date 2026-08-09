"""Submitter self-service: a CFP author manages their own submissions.

The public CFP form is submit-only — a speaker fills it in and never sees the
result again. This module adds the other half: after submitting, a speaker can
ask for a link to their email, then view / edit / withdraw their submissions
while the call for papers is still open.

There is no Clerk account here. The credential is a magic-link token
(``magic_link_tokens.purpose = 'submitter'``) that scopes every read and write
to one contact — and, because a contact belongs to exactly one event
(``contacts`` is UNIQUE on ``event_id, email``), to one event's submissions.
Unlike the portal/reviewer links this token is NOT single-use: it is the bearer
credential the manage page carries on every call, valid until it expires, so we
validate it without consuming ``used_at``.

Cross-tenant safety is the same three-step every id-taking route owes: read the
row WITH the org predicate, verify it belongs to this submitter's contact, 404
otherwise. A submission id from another event can never be reached.
"""

from __future__ import annotations

import html as html_module
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from app.core.settings import settings
from services.magic_links import generate_token, hash_token
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

# The magic-link purpose this feature mints. Kept distinct from 'portal' and
# 'review' so a submitter token can never be exchanged for a portal cookie.
SUBMITTER_SCOPE = "submitter"

# A manage link outlives a single sitting: the submitter edits across days while
# the CFP is open, and the same link opens the page each time.
SUBMITTER_LINK_TTL_HOURS = 24 * 14

# The final verdicts a submitter should see. accept_queue / decline_queue are
# internal organizer staging states, not a decision to surface.
DECIDED_STATUSES = {"accepted", "declined"}

# Decision emails carry the organizer's feedback; we read it back by template.
DECISION_TEMPLATE_KEYS = {"accept", "decline", "maybe"}

# Generic response for the manage-link request — identical whether or not the
# email has any submissions, so the endpoint never confirms an address exists.
MANAGE_LINK_MESSAGE = (
    "If that email has any submissions for this event, we've sent a link to "
    "manage them. Check your inbox."
)


class InvalidSubmitterToken(Exception):
    """The supplied submitter token cannot be used."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: Any) -> datetime | None:
    """An aware datetime from an ISO string, or None. Naive input is read UTC."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ── token: mint (on request) and validate (on every call) ──────────────────


async def _mint_token(org_id: str, contact_id: str) -> str:
    """Persist a submitter token hash and return the raw token for the email."""
    raw = generate_token()
    await db(
        lambda: supabase.table("magic_link_tokens")
        .insert(
            {
                "org_id": org_id,
                "token_hash": hash_token(raw),
                "purpose": SUBMITTER_SCOPE,
                "contact_id": contact_id,
                "expires_at": (_now() + timedelta(hours=SUBMITTER_LINK_TTL_HOURS)).isoformat(),
            }
        )
        .execute(),
        "submitter_token_mint",
    )
    return raw


async def validate_token(raw: str) -> tuple[str, str]:
    """Resolve a submitter token to ``(org_id, contact_id)`` without consuming it.

    Raises :class:`InvalidSubmitterToken` for anything unusable — unknown hash,
    wrong purpose, revoked, or expired. The token is a bearer credential, so we
    never set ``used_at``; it stays good until it expires.
    """
    if not raw:
        raise InvalidSubmitterToken("Missing submitter token")
    row = first(
        await db(
            lambda: supabase.table("magic_link_tokens")
            .select("id, org_id, purpose, contact_id, expires_at, revoked_at")
            .eq("token_hash", hash_token(raw))
            .limit(1)
            .execute(),
            "submitter_token_lookup",
        )
    )
    if not row or row.get("purpose") != SUBMITTER_SCOPE or row.get("revoked_at") is not None:
        raise InvalidSubmitterToken("Submitter token is invalid or revoked")
    expires_at = _parse_dt(row.get("expires_at"))
    if expires_at is None or expires_at <= _now():
        raise InvalidSubmitterToken("Submitter token has expired")
    org_id = row.get("org_id")
    contact_id = row.get("contact_id")
    if not isinstance(org_id, str) or not org_id or not isinstance(contact_id, str) or not contact_id:
        raise InvalidSubmitterToken("Submitter token is malformed")
    return org_id, contact_id


# ── in-app manage link (issued at submit time, no email round-trip) ─────────


async def mint_manage_link(org_id: str, slug: str, contact_id: str) -> dict[str, str]:
    """Mint a submitter token for a contact who JUST created a submission.

    Returns ``{"token": raw, "url": manage_url}`` for the confirmation screen.

    This is the in-app counterpart to :func:`issue_manage_link`. The submitter
    proved ownership of the email by submitting from it, so we hand them a manage
    link on the confirmation screen immediately — with no email round-trip and no
    dependence on a verified sending domain. The token is scoped EXACTLY as the
    emailed one: purpose ``'submitter'`` bound to this ``contact_id``, so it can
    read / edit / withdraw only this contact's submissions — and, because a
    contact belongs to exactly one event, only that one event's talks — nothing
    else. It never carries or exposes another submitter's contact.
    """
    raw = await _mint_token(org_id, contact_id)
    url = f"{settings.frontend_url.rstrip('/')}/submit/{slug}/manage?token={raw}"
    return {"token": raw, "url": url}


# ── manage-link request (never leaks whether the email exists) ──────────────


async def issue_manage_link(org_id: str, event_id: str, slug: str, email: str) -> bool:
    """Mint + queue a manage link IF this email owns ≥1 submission for the event.

    Returns whether a link was actually issued — for logging and tests only. The
    caller ALWAYS returns the same generic 200, so the boolean never reaches a
    response body and the endpoint can't be used to probe for addresses.
    """
    email_norm = (email or "").strip().lower()
    if not email_norm:
        return False

    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id, first_name, email, org_id, event_id")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("email", email_norm)
            .limit(1)
            .execute(),
            "submitter_manage_contact",
        )
    )
    if not contact or contact.get("org_id") != org_id:
        return False

    submissions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id")
            .eq("org_id", org_id)
            .eq("submitter_contact_id", contact["id"])
            .execute(),
            "submitter_manage_count",
        )
    )
    if not submissions:
        return False

    raw = await _mint_token(org_id, contact["id"])
    await _queue_manage_email(org_id, event_id, contact, slug, raw)
    return True


async def _queue_manage_email(
    org_id: str, event_id: str, contact: dict, slug: str, raw_token: str
) -> None:
    """Drop the manage-link email onto email_outbox for the drain worker.

    Best-effort: a queue failure must not turn the generic 200 into an error and
    thereby leak that the address exists."""
    link = f"{settings.frontend_url.rstrip('/')}/submit/{slug}/manage?token={raw_token}"
    to = str(contact.get("email") or "")
    greeting = html_module.escape((contact.get("first_name") or "").strip() or "there")
    safe_link = html_module.escape(link)
    subject = "Manage your submissions"
    body = (
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
        'font-size:15px;line-height:1.5;color:#111">'
        f"<p>Hi {greeting},</p>"
        "<p>Here's your private link to view, edit, or withdraw the talks you've "
        "submitted. It works until the call for papers closes.</p>"
        f'<p style="margin:20px 0"><a href="{safe_link}" '
        'style="background:#4962E2;color:#fff;text-decoration:none;padding:10px 18px;'
        'border-radius:8px;display:inline-block;font-weight:600">Manage my submissions</a></p>'
        '<p style="color:#666;font-size:13px">Or paste this link into your browser:<br>'
        f"{safe_link}</p>"
        '<p style="color:#666;font-size:13px">If you didn\'t request this, you can '
        "ignore this email.</p>"
        "</div>"
    )
    record = {
        "org_id": org_id,
        "event_id": event_id,
        "contact_id": contact["id"],
        "template_key": "submitter_manage_link",
        "payload": {"to": to, "subject": subject, "html": body},
        "status": "queued",
    }
    try:
        await db(
            lambda: supabase.table("email_outbox").insert(record).execute(),
            "submitter_manage_queue",
        )
    except Exception:  # enqueue is best-effort, see docstring
        logger.warning(
            "submitter: could not queue manage link contact=%s", contact["id"], exc_info=True
        )


# ── read: this submitter's submissions ──────────────────────────────────────


async def list_submissions(org_id: str, contact_id: str) -> dict:
    """Everything the manage page renders: the event, its taxonomy, submissions."""
    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id, event_id, org_id")
            .eq("id", contact_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "submitter_list_contact",
        )
    )
    if not contact or contact.get("org_id") != org_id:
        return {"event": None, "tracks": [], "formats": [], "submissions": []}
    event_id = contact.get("event_id")

    sessions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("*")
            .eq("org_id", org_id)
            .eq("submitter_contact_id", contact_id)
            .order("submitted_at", desc=True)
            .execute(),
            "submitter_list_sessions",
        )
    )

    tracks = await _taxonomy("tracks", org_id, event_id)
    formats = await _taxonomy("formats", org_id, event_id)
    submissions = await _enrich(org_id, event_id, contact_id, sessions, tracks, formats)

    event = first(
        await db(
            lambda: supabase.table("events")
            .select("id, name")
            .eq("id", event_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "submitter_list_event",
        )
    )
    # The deadline the page shows is the newest submission's CFP close date; in
    # practice every submission shares one form, so this is that form's close_at.
    close_at = await _form_close_at(org_id, sessions[0].get("source_form_id")) if sessions else None
    now = _now()
    return {
        "event": {
            "id": event_id,
            "name": (event or {}).get("name"),
            "close_at": close_at.isoformat() if close_at else None,
            "closed": bool(close_at and close_at <= now),
        },
        "tracks": tracks,
        "formats": formats,
        "submissions": submissions,
    }


# ── write: edit / withdraw, close-locked and contact-scoped ─────────────────


async def edit_submission(org_id: str, contact_id: str, submission_id: str, patch: dict) -> dict:
    """Edit title / abstract / track / format while the submission is editable."""
    session = await _load_owned_session(org_id, contact_id, submission_id)
    if not await _is_editable(session):
        raise HTTPException(status_code=403, detail="This submission can no longer be edited.")

    event_id = session.get("event_id")
    update: dict[str, Any] = {}
    if "title" in patch:
        title = str(patch.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title cannot be empty.")
        update["title"] = title
    if "abstract" in patch:
        update["description"] = str(patch.get("abstract") or "").strip()
    if "track_id" in patch:
        update["track_id"] = await _valid_taxonomy_id("tracks", org_id, event_id, patch.get("track_id"))
    if "format_id" in patch:
        update["format_id"] = await _valid_taxonomy_id("formats", org_id, event_id, patch.get("format_id"))

    if update:
        update["updated_at"] = _now().isoformat()
        # Guard the write on status='pending' so a decision an organizer makes
        # between the editable check above and this update can't be clobbered:
        # if the row is no longer pending the update matches nothing and we 403.
        updated = rows(
            await db(
                lambda: supabase.table("sessions")
                .update(update)
                .eq("id", submission_id)
                .eq("org_id", org_id)
                .eq("status", "pending")
                .execute(),
                "submitter_edit_session",
            )
        )
        if not updated:
            raise HTTPException(status_code=403, detail="This submission can no longer be edited.")
        session = updated[0]

    return {"submission": await _serialize_one(org_id, contact_id, session)}


async def withdraw_submission(org_id: str, contact_id: str, submission_id: str) -> dict:
    """Withdraw a still-pending, still-open submission. 403 once decided/closed."""
    session = await _load_owned_session(org_id, contact_id, submission_id)
    if not await _is_editable(session):
        raise HTTPException(status_code=403, detail="This submission can no longer be withdrawn.")

    # Guarded on status='pending' (see edit_submission): a submission an
    # organizer decides on mid-request can't be flipped to withdrawn underneath.
    updated = rows(
        await db(
            lambda: supabase.table("sessions")
            .update({"status": "withdrawn", "updated_at": _now().isoformat()})
            .eq("id", submission_id)
            .eq("org_id", org_id)
            .eq("status", "pending")
            .execute(),
            "submitter_withdraw_session",
        )
    )
    if not updated:
        raise HTTPException(status_code=403, detail="This submission can no longer be withdrawn.")
    session = updated[0]
    return {"submission": await _serialize_one(org_id, contact_id, session)}


# ── internals ───────────────────────────────────────────────────────────────


async def _load_owned_session(org_id: str, contact_id: str, submission_id: str) -> dict:
    """Read a session in this org, verify it's THIS submitter's, else 404.

    The org predicate plus the contact check make a cross-event id unreachable:
    an id owned by another submitter (or another event) 404s rather than leaking
    that it exists.
    """
    session = first(
        await db(
            lambda: supabase.table("sessions")
            .select("*")
            .eq("id", submission_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "submitter_owned_session",
        )
    )
    if not session or session.get("submitter_contact_id") != contact_id:
        raise HTTPException(status_code=404, detail="Submission not found.")
    return session


async def _form_close_at(org_id: str, form_id: str | None) -> datetime | None:
    if not form_id:
        return None
    form = first(
        await db(
            lambda: supabase.table("forms")
            .select("id, settings")
            .eq("id", form_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "submitter_form_close_at",
        )
    )
    settings_obj = (form or {}).get("settings") or {}
    return _parse_dt(settings_obj.get("close_at"))


async def _is_editable(session: dict) -> bool:
    """A submission is editable while it is pending AND its CFP is still open.

    This is the single close-lock enforced server-side for both edit and
    withdraw, so a hand-rolled request can't slip past a closed deadline."""
    if session.get("status") != "pending":
        return False
    close_at = await _form_close_at(session.get("org_id"), session.get("source_form_id"))
    return close_at is None or close_at > _now()


async def _taxonomy(table: str, org_id: str, event_id: str | None) -> list[dict]:
    if not event_id:
        return []
    recs = rows(
        await db(
            lambda: supabase.table(table)
            .select("id, name")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            f"submitter_taxonomy_{table}",
        )
    )
    return [{"id": r.get("id"), "name": r.get("name")} for r in recs if r.get("id")]


async def _valid_taxonomy_id(
    table: str, org_id: str, event_id: str | None, value: Any
) -> str | None:
    """A track/format id that belongs to THIS event, or None to clear it.

    A value that isn't in the event's taxonomy is rejected — a submitter can't
    reassign their talk to another event's track."""
    if value in (None, ""):
        return None
    value = str(value)
    match = first(
        await db(
            lambda: supabase.table(table)
            .select("id")
            .eq("id", value)
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .limit(1)
            .execute(),
            f"submitter_valid_{table}",
        )
    )
    if not match:
        label = "track" if table == "tracks" else "format"
        raise HTTPException(status_code=400, detail=f"That {label} isn't available for this event.")
    return value


async def _decision_feedback(org_id: str, contact_id: str) -> dict[str, str]:
    """Best-effort map of session title → the organizer's decision feedback.

    Decisions record their feedback on the outgoing email, not the session, and
    the outbox row carries the session title in its payload context. We match on
    that title; a submitter with two same-titled talks would see the newer note
    on both, which is an acceptable edge for a courtesy field."""
    recs = rows(
        await db(
            lambda: supabase.table("email_outbox")
            .select("template_key, payload, created_at")
            .eq("org_id", org_id)
            .eq("contact_id", contact_id)
            .execute(),
            "submitter_decision_feedback",
        )
    )
    mapping: dict[str, str] = {}
    for row in sorted(recs, key=lambda r: str(r.get("created_at") or "")):
        if row.get("template_key") not in DECISION_TEMPLATE_KEYS:
            continue
        payload = row.get("payload") or {}
        feedback = payload.get("feedback")
        title = str((payload.get("context") or {}).get("session_title") or "")
        if feedback and title:
            mapping[title] = str(feedback)
    return mapping


async def _enrich(
    org_id: str,
    event_id: str | None,
    contact_id: str,
    sessions: list[dict],
    tracks: list[dict] | None = None,
    formats: list[dict] | None = None,
) -> list[dict]:
    """Turn raw session rows into the manage-page submission shape."""
    now = _now()
    if tracks is None:
        tracks = await _taxonomy("tracks", org_id, event_id)
    if formats is None:
        formats = await _taxonomy("formats", org_id, event_id)
    track_names = {t["id"]: t.get("name") for t in tracks}
    format_names = {f["id"]: f.get("name") for f in formats}

    form_ids = {s.get("source_form_id") for s in sessions if s.get("source_form_id")}
    close_by_form: dict[str, datetime | None] = {}
    if form_ids:
        forms = rows(
            await db(
                lambda: supabase.table("forms")
                .select("id, settings")
                .eq("org_id", org_id)
                .in_("id", list(form_ids))
                .execute(),
                "submitter_enrich_forms",
            )
        )
        for form in forms:
            close_by_form[form["id"]] = _parse_dt((form.get("settings") or {}).get("close_at"))

    feedback_by_title = await _decision_feedback(org_id, contact_id)

    out: list[dict] = []
    for session in sessions:
        status = session.get("status")
        close_at = close_by_form.get(session.get("source_form_id"))
        editable = status == "pending" and (close_at is None or close_at > now)
        decided = status in DECIDED_STATUSES
        out.append(
            {
                "id": session.get("id"),
                "friendly_id": session.get("friendly_id"),
                "title": session.get("title") or "",
                "abstract": session.get("description") or "",
                "track": track_names.get(session.get("track_id")),
                "track_id": session.get("track_id"),
                "format": format_names.get(session.get("format_id")),
                "format_id": session.get("format_id"),
                "status": status,
                "submitted_at": session.get("submitted_at"),
                "editable": editable,
                "decided": decided,
                "decision": status if decided else None,
                "feedback": feedback_by_title.get(session.get("title")) if decided else None,
            }
        )
    return out


async def _serialize_one(org_id: str, contact_id: str, session: dict) -> dict:
    enriched = await _enrich(org_id, session.get("event_id"), contact_id, [session])
    return enriched[0]
