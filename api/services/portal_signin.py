"""Cross-org speaker sign-in: one email, every conference it appears at.

A speaker has no account. Their identity is an email address, and the same
address can be a `contacts` row at several conferences run by DIFFERENT
organizations — a speaker who did two events for one organizer and one for
another has no way to say which portal they mean.

So this module is the ONE place in the API that reads across the org boundary,
and possession of the emailed token is the only thing that authorises it:

    POST /public/portal/sign-in   mint a `portal_choose` token, email ONE link
    GET  /public/portal/choices   the conferences that token's email is at
    POST /public/portal/choose    exchange it for the normal dais_portal cookie

Three properties are load-bearing:

* **No enumeration.** ``issue_sign_in_link`` returns a plain bool for logging
  and tests; the route always answers with the same body. It also never raises
  — a database failure must not become a response an attacker can tell apart
  from "that address is not here".
* **The token carries the email, not a contact.** It is minted only after the
  address is matched, and it is delivered only TO that address, so holding it
  is proof of the address. Every read below re-derives the contacts from the
  token's email; a `contact_id` from the client is checked against that list
  and never trusted on its own.
* **The token is a bearer credential, not a one-shot.** ``/choices`` and
  ``/choose`` are two calls with one token, mail clients pre-fetch links, and a
  speaker may legitimately enter a second conference from the same email.
  Consuming it on sight would break all three, so it is bounded by a SHORT TTL
  and revocation instead — the same trade already made for reviewer links.
"""

from __future__ import annotations

import html as html_module
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.settings import settings
from services.magic_links import generate_token, hash_token
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

# Distinct from 'portal' on purpose: a choose token names an email, not an org
# + contact, so /public/session/redeem must never accept it for a session.
CHOOSE_PURPOSE = "portal_choose"

# Short: this is a sign-in link, not a manage link. Long enough to survive an
# inbox scanner's pre-fetch and a speaker reading their mail an hour later.
CHOOSE_LINK_TTL_HOURS = 1.0

# The one answer POST /public/portal/sign-in ever gives, matched or not.
SIGN_IN_MESSAGE = (
    "If that email is on any conference we host, we've sent a sign-in link. "
    "Check your inbox."
)


class InvalidChooseToken(Exception):
    """The supplied sign-in token cannot be used."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def _parse_dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ── the cross-org read ──────────────────────────────────────────────────────


async def _contacts_for_email(email: str) -> list[dict]:
    """Every contact row with this address, in EVERY org.

    Deliberately unscoped — it is the only such query in the system. Two callers
    may reach it: the sign-in mint, whose result goes nowhere but an email to
    that same address, and a request holding a valid `portal_choose` token for
    it. Nothing else may call this.
    """
    if not email:
        return []
    return rows(
        await db(
            lambda: supabase.table("contacts")
            .select("id, org_id, event_id, email, first_name")
            .eq("email", email)
            .execute(),
            "portal_signin_contacts",
        )
    )


async def _build_choices(contacts: list[dict]) -> list[dict]:
    """Turn contact rows into one choice per conference, newest first."""
    event_ids = sorted({str(c["event_id"]) for c in contacts if c.get("event_id")})
    org_ids = sorted({str(c["org_id"]) for c in contacts if c.get("org_id")})
    if not event_ids or not org_ids:
        return []

    events_by_id = {
        str(event["id"]): event
        for event in rows(
            await db(
                lambda: supabase.table("events")
                .select("id, org_id, name, starts_at, ends_at")
                .in_("id", event_ids)
                .execute(),
                "portal_signin_events",
            )
        )
        if event.get("id")
    }
    org_names = {
        str(org["org_id"]): str(org.get("name") or "").strip() or str(org["org_id"])
        for org in rows(
            await db(
                lambda: supabase.table("orgs")
                .select("org_id, name")
                .in_("org_id", org_ids)
                .execute(),
                "portal_signin_orgs",
            )
        )
        if org.get("org_id")
    }

    choices: list[dict] = []
    for contact in contacts:
        org_id = str(contact.get("org_id") or "")
        event = events_by_id.get(str(contact.get("event_id") or ""))
        # A contact whose event belongs to another org is a data error, not a
        # choice: entering it would hand out a session for an org this address
        # has no row in. Drop it rather than trust either side.
        if not org_id or not event or str(event.get("org_id") or "") != org_id:
            continue
        choices.append(
            {
                "contact_id": str(contact.get("id") or ""),
                "org_id": org_id,
                "org_name": org_names.get(org_id, org_id),
                "event_id": str(event.get("id") or ""),
                "event_name": str(event.get("name") or ""),
                "starts_at": event.get("starts_at"),
                "ends_at": event.get("ends_at"),
            }
        )

    # Stable two-pass sort: name breaks ties, start date decides. An event with
    # no date sorts last (its key is ""), not first.
    choices.sort(key=lambda choice: choice["event_name"].casefold())
    choices.sort(key=lambda choice: str(choice["starts_at"] or ""), reverse=True)
    return choices


async def list_choices(email: str) -> list[dict]:
    """Every conference this address appears at, across every org."""
    email_norm = normalize_email(email)
    if not email_norm:
        return []
    return await _build_choices(await _contacts_for_email(email_norm))


async def resolve_choice(email: str, contact_id: str) -> dict | None:
    """The choice this email owns with that id, or None.

    Re-derives the list from the token's verified email every time: the client's
    `contact_id` is only ever checked against it, never used to look a contact
    up directly.
    """
    wanted = str(contact_id or "").strip()
    if not wanted:
        return None
    for choice in await list_choices(email):
        if choice["contact_id"] == wanted:
            return choice
    return None


# ── token: mint on request, validate on every call ──────────────────────────


async def _mint_choose_token(org_id: str, email: str) -> str:
    """Persist a `portal_choose` token hash and return the raw value.

    ``org_id`` is bookkeeping only — the row has to live under some org (the FK
    is NOT NULL) so we file it under the conference the link leads with. It is
    NEVER read back as scope: the token's authority is its email, and the org
    a session is issued for comes from the chosen contact.
    """
    raw = generate_token()
    await db(
        lambda: supabase.table("magic_link_tokens")
        .insert(
            {
                "org_id": org_id,
                "token_hash": hash_token(raw),
                "purpose": CHOOSE_PURPOSE,
                "contact_id": None,
                "email": email,
                "expires_at": (_now() + timedelta(hours=CHOOSE_LINK_TTL_HOURS)).isoformat(),
            }
        )
        .execute(),
        "portal_choose_token_mint",
    )
    return raw


async def validate_choose_token(raw: str) -> str:
    """Resolve a sign-in token to its verified email, without consuming it.

    Raises :class:`InvalidChooseToken` for anything unusable: unknown hash,
    wrong purpose, revoked, expired, or missing its email.
    """
    if not raw:
        raise InvalidChooseToken("Missing sign-in token")
    row = first(
        await db(
            lambda: supabase.table("magic_link_tokens")
            .select("id, purpose, email, expires_at, revoked_at")
            .eq("token_hash", hash_token(raw))
            .limit(1)
            .execute(),
            "portal_choose_token_lookup",
        )
    )
    if not row or row.get("purpose") != CHOOSE_PURPOSE or row.get("revoked_at") is not None:
        raise InvalidChooseToken("Sign-in link is invalid or revoked")
    expires_at = _parse_dt(row.get("expires_at"))
    if expires_at is None or expires_at <= _now():
        raise InvalidChooseToken("Sign-in link has expired")
    email = normalize_email(row.get("email"))
    if not email:
        raise InvalidChooseToken("Sign-in link is malformed")
    return email


# ── sign-in request (never leaks whether the address exists) ────────────────


async def issue_sign_in_link(email: str) -> bool:
    """Mint + queue ONE sign-in email IF this address is a contact anywhere.

    Returns whether a link was issued — for logging and tests only. The caller
    always returns the same 202, so the boolean never reaches a response body
    and the endpoint cannot be used to probe for addresses. Nothing raises, for
    the same reason.
    """
    email_norm = normalize_email(email)
    if not email_norm:
        return False
    try:
        contacts = await _contacts_for_email(email_norm)
        if not contacts:
            return False
        choices = await _build_choices(contacts)
        if not choices:
            return False

        # One email, whatever the number of conferences: the link opens a page
        # that lists them all. It is filed against the newest one because the
        # outbox row is org- and event-scoped.
        anchor = choices[0]
        greeting = next(
            (
                str(contact.get("first_name") or "").strip()
                for contact in contacts
                if str(contact.get("id") or "") == anchor["contact_id"]
            ),
            "",
        )
        raw = await _mint_choose_token(anchor["org_id"], email_norm)
        await _queue_sign_in_email(anchor, email_norm, greeting, raw)
        return True
    except Exception:  # see docstring: an error may not be distinguishable
        logger.warning("portal sign-in: could not issue link", exc_info=True)
        return False


async def _queue_sign_in_email(anchor: dict, email: str, first_name: str, raw_token: str) -> None:
    """Drop the sign-in email onto email_outbox for the drain worker."""
    link = f"{settings.frontend_url.rstrip('/')}/portal/choose?token={raw_token}"
    safe_link = html_module.escape(link)
    greeting = html_module.escape(first_name or "there")
    body = (
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
        'font-size:15px;line-height:1.5;color:#111">'
        f"<p>Hi {greeting},</p>"
        "<p>Here's your link to open your speaker portal. If you're speaking at "
        "more than one conference, you'll be able to pick which one.</p>"
        f'<p style="margin:20px 0"><a href="{safe_link}" '
        'style="background:#4962E2;color:#fff;text-decoration:none;padding:10px 18px;'
        'border-radius:8px;display:inline-block;font-weight:600">Open my portal</a></p>'
        '<p style="color:#666;font-size:13px">Or paste this link into your browser:<br>'
        f"{safe_link}</p>"
        "<p style=\"color:#666;font-size:13px\">This link expires in about an hour. "
        "If you didn't request it, you can ignore this email.</p>"
        "</div>"
    )
    record = {
        "org_id": anchor["org_id"],
        "event_id": anchor["event_id"],
        "contact_id": anchor["contact_id"],
        "template_key": "portal_sign_in",
        "payload": {"to": email, "subject": "Your speaker portal sign-in link", "html": body},
        "status": "queued",
    }
    try:
        await db(
            lambda: supabase.table("email_outbox").insert(record).execute(),
            "portal_signin_queue",
        )
    except Exception:  # enqueue is best-effort, exactly like the manage link
        logger.warning("portal sign-in: could not queue link", exc_info=True)
