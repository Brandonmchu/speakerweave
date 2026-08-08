"""Calendar invite orchestration: DB ledger -> ICS -> mailer.

The ledger (`calendar_invites`, one row per (session, contact)) is what makes
"Send invites" safe to press twice:

  * UID is derived, never random — dais-{session_id}-{contact_id}@dais.events —
    so the same pair always addresses the same calendar entry.
  * SEQUENCE is bumped only when something calendar-relevant actually changed
    (start, end, title, location). Clients ignore an update whose SEQUENCE did
    not advance, and they get confused by one that advances for no reason.
  * last_payload_hash records what the attendee was last told, so a resend with
    no material change is a no-op instead of a duplicate mail.

Every query carries the org predicate: the service-role client bypasses RLS.
"""

from __future__ import annotations

import hashlib
import html
import logging
import os
from datetime import datetime, timezone

from postgrest.exceptions import APIError

from app.core.settings import settings
from services.ics import (
    METHOD_CANCEL,
    METHOD_REQUEST,
    build_google_calendar_url,
    build_invite,
    build_outlook_url,
    zone,
)
from services.mailer import send_email
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

UID_DOMAIN = "dais.events"
# Roles that belong on stage and therefore get a calendar hold. 'submitter' is
# deliberately absent — whoever filed the CFP is not necessarily speaking.
SPEAKER_ROLES = ("speaker", "moderator", "chairperson")


class InviteTargetNotFound(LookupError):
    """Session/invite missing, or owned by another org. Routes answer 404."""


class SessionNotScheduled(ValueError):
    """No room+time yet — there is nothing to put in a calendar. Routes answer 409."""


def invite_uid(session_id: str, contact_id: str) -> str:
    return f"dais-{session_id}-{contact_id}@{UID_DOMAIN}"


def payload_hash(
    starts_at: object, ends_at: object, title: object, location: object
) -> str:
    """Fingerprint of the calendar-relevant fields only.

    Description/agenda copy changes on their own must NOT trigger a re-invite:
    every resend is a notification in someone's inbox.
    """
    parts = [str(starts_at or ""), str(ends_at or ""), str(title or ""), str(location or "")]
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        logger.warning("invites: unparseable timestamp %r", value)
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _organizer(event: dict | None) -> tuple[str, str]:
    """(name, email) for ORGANIZER. Event settings win, then env, then default."""
    conf = (event or {}).get("settings") or {}
    email = (
        conf.get("organizer_email")
        or os.getenv("INVITE_ORGANIZER_EMAIL")
        or os.getenv("MAIL_FROM_EMAIL")
        or "invites@dais.events"
    )
    name = conf.get("organizer_name") or (event or {}).get("name") or "dais"
    return str(name), str(email)


def _contact_name(contact: dict) -> str:
    name = f"{contact.get('first_name') or ''} {contact.get('last_name') or ''}".strip()
    return name or str(contact.get("email") or "")


def _location(session: dict, room: dict | None, event: dict | None) -> str:
    bits = [room.get("name") if room else None, (event or {}).get("location")]
    return " — ".join([b for b in bits if b])


async def _load_context(session_id: str, org_id: str) -> dict:
    """session + event + room, all org-scoped. Raises InviteTargetNotFound."""
    session = first(
        await db(
            lambda: supabase.table("sessions")
            .select("*")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "invites_session_lookup",
        )
    )
    if not session or session.get("org_id") != org_id:
        raise InviteTargetNotFound("Session not found")

    event = first(
        await db(
            lambda: supabase.table("events")
            .select("id, name, slug, timezone, location, settings")
            .eq("id", session["event_id"])
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "invites_event_lookup",
        )
    )

    room = None
    if session.get("room_id"):
        room = first(
            await db(
                lambda: supabase.table("rooms")
                .select("id, name, capacity")
                .eq("id", session["room_id"])
                .eq("org_id", org_id)
                .limit(1)
                .execute(),
                "invites_room_lookup",
            )
        )

    return {"session": session, "event": event, "room": room}


async def _load_attendees(session: dict, org_id: str) -> list[dict]:
    """Speaker contacts for a session, primary first.

    Falls back to the submitter when no speaker role has been assigned yet —
    an accepted CFP submission is a talk with exactly one known human on it,
    and refusing to invite them would be pedantry.
    """
    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("contact_id, role, is_primary")
            .eq("session_id", session["id"])
            .eq("org_id", org_id)
            .execute(),
            "invites_participants",
        )
    )

    speakers = [p for p in participants if p.get("role") in SPEAKER_ROLES]
    if not speakers:
        speakers = [p for p in participants if p.get("role") == "submitter"]
    contact_ids = list(dict.fromkeys(p["contact_id"] for p in speakers if p.get("contact_id")))
    if not contact_ids and session.get("submitter_contact_id"):
        contact_ids = [session["submitter_contact_id"]]
    if not contact_ids:
        return []

    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select("id, email, first_name, last_name")
            .in_("id", contact_ids)
            .eq("org_id", org_id)
            .execute(),
            "invites_contacts",
        )
    )
    primary = {p["contact_id"] for p in speakers if p.get("is_primary")}
    contacts = [c for c in contacts if c.get("email")]
    contacts.sort(key=lambda c: (0 if c["id"] in primary else 1, str(c.get("email"))))
    return contacts


def _links(session: dict, event: dict | None, uid: str) -> dict[str, str]:
    slug = (event or {}).get("slug")
    return {
        "ics": f"{settings.public_api_url}/public/invites/{uid}.ics",
        "agenda": f"{settings.frontend_url.rstrip('/')}/agenda/{slug}" if slug else "",
    }


def _when(session: dict, event: dict | None) -> str:
    starts = _parse_ts(session.get("starts_at"))
    ends = _parse_ts(session.get("ends_at"))
    if not starts or not ends:
        return "Time to be confirmed"
    tz = zone((event or {}).get("timezone"))
    local_start, local_end = starts.astimezone(tz), ends.astimezone(tz)
    return (
        f"{local_start.strftime('%a, %b %-d, %Y')} · "
        f"{local_start.strftime('%-I:%M %p')} – {local_end.strftime('%-I:%M %p')} "
        f"{local_end.strftime('%Z') or ''}".strip()
    )


def _description(session: dict, event: dict | None, links: dict[str, str]) -> str:
    blocks = [session.get("description") or ""]
    tail = [b for b in [(event or {}).get("name"), links.get("agenda")] if b]
    if tail:
        blocks.append("\n".join(tail))
    return "\n\n".join(b.strip() for b in blocks if b.strip())


def _html_body(
    *,
    session: dict,
    event: dict | None,
    contact: dict,
    location: str,
    when: str,
    links: dict[str, str],
    cancelled: bool,
) -> str:
    esc = html.escape
    title = esc(session.get("title") or "Your session")
    greeting = esc((contact.get("first_name") or "").strip() or "there")
    event_name = esc((event or {}).get("name") or "the event")

    if cancelled:
        lead = f"Your session at {event_name} has been cancelled and removed from your calendar."
        extras = ""
    else:
        lead = f"You're confirmed to speak at {event_name}. The invite is attached."
        starts = _parse_ts(session.get("starts_at"))
        ends = _parse_ts(session.get("ends_at"))
        tz_id = (event or {}).get("timezone") or "UTC"
        buttons = []
        if starts and ends:
            description = _description(session, event, links)
            google = build_google_calendar_url(
                session.get("title") or "", description, starts, ends, tz_id, location
            )
            outlook = build_outlook_url(
                session.get("title") or "", description, starts, ends, tz_id, location
            )
            buttons = [
                f'<a href="{esc(google)}">Add to Google Calendar</a>',
                f'<a href="{esc(outlook)}">Add to Outlook</a>',
                f'<a href="{esc(links["ics"])}">Download .ics</a>',
            ]
        extras = f'<p style="margin:16px 0">{" &nbsp;·&nbsp; ".join(buttons)}</p>' if buttons else ""

    return (
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
        'font-size:15px;line-height:1.5;color:#111">'
        f"<p>Hi {greeting},</p>"
        f"<p>{lead}</p>"
        f'<p style="margin:16px 0"><strong>{title}</strong><br>'
        f"{esc(when)}<br>{esc(location or 'Location to be confirmed')}</p>"
        f"{extras}"
        f'<p style="color:#666;font-size:13px">Sent by {event_name} via dais.</p>'
        "</div>"
    )


def _render_ics(
    *,
    method: str,
    uid: str,
    sequence: int,
    session: dict,
    event: dict | None,
    room: dict | None,
    contact: dict,
    now: datetime | None = None,
) -> str:
    location = _location(session, room, event)
    links = _links(session, event, uid)
    organizer_name, organizer_email = _organizer(event)
    return build_invite(
        method,
        uid,
        sequence,
        session.get("title") or "Session",
        _description(session, event, links),
        _parse_ts(session.get("starts_at")),
        _parse_ts(session.get("ends_at")),
        (event or {}).get("timezone") or "UTC",
        location,
        organizer_email,
        organizer_name,
        str(contact.get("email") or ""),
        _contact_name(contact),
        url=links.get("agenda") or links["ics"],
        now=now,
    )


async def _existing_invites(session_id: str, org_id: str) -> dict[str, dict]:
    found = rows(
        await db(
            lambda: supabase.table("calendar_invites")
            .select("*")
            .eq("session_id", session_id)
            .eq("org_id", org_id)
            .execute(),
            "invites_ledger_lookup",
        )
    )
    return {row["contact_id"]: row for row in found}


def _is_missing_hash_column(exc: APIError) -> bool:
    """True when migration 003 has not been applied to this database yet."""
    blob = f"{getattr(exc, 'code', '')} {getattr(exc, 'message', '')} {exc}".lower()
    return "last_payload_hash" in blob or "pgrst204" in blob


async def _persist_invite(existing: dict | None, values: dict, org_id: str) -> dict | None:
    """Insert or update the ledger row, tolerating a pre-003 schema."""

    async def _write(payload: dict) -> dict | None:
        if existing:
            return first(
                await db(
                    lambda: supabase.table("calendar_invites")
                    .update(payload)
                    .eq("id", existing["id"])
                    .eq("org_id", org_id)
                    .execute(),
                    "invites_ledger_update",
                )
            )
        return first(
            await db(
                lambda: supabase.table("calendar_invites").insert(payload).execute(),
                "invites_ledger_insert",
            )
        )

    try:
        return await _write(values)
    except APIError as exc:
        if not _is_missing_hash_column(exc):
            raise
        logger.warning(
            "invites: calendar_invites.last_payload_hash is missing — apply "
            "migrations/003_invites_hash.sql. Idempotency is degraded until then."
        )
        return await _write({k: v for k, v in values.items() if k != "last_payload_hash"})


async def send_session_invites(session_id: str, org_id: str, *, dry_run: bool = False) -> dict:
    """Send (or refresh) METHOD:REQUEST invites to a session's speakers."""
    context = await _load_context(session_id, org_id)
    session, event, room = context["session"], context["event"], context["room"]

    starts_at, ends_at = _parse_ts(session.get("starts_at")), _parse_ts(session.get("ends_at"))
    if not starts_at or not ends_at:
        raise SessionNotScheduled("Session has no start/end time yet — schedule it before inviting")

    location = _location(session, room, event)
    current_hash = payload_hash(
        session.get("starts_at"), session.get("ends_at"), session.get("title"), location
    )
    when = _when(session, event)
    attendees = await _load_attendees(session, org_id)
    # Read the ledger even for a dry run: the preview should report what WOULD
    # happen ("2 unchanged, 1 would send"), not pretend every invite is new.
    ledger = await _existing_invites(session_id, org_id)

    results: list[dict] = []
    for contact in attendees:
        uid = invite_uid(session_id, contact["id"])
        existing = ledger.get(contact["id"])
        result: dict = {
            "contact_id": contact["id"],
            "email": contact.get("email"),
            "name": _contact_name(contact),
            "ics_uid": uid,
        }

        if existing:
            unchanged = bool(
                existing.get("last_payload_hash") == current_hash
                and existing.get("last_method") == METHOD_REQUEST
                and existing.get("last_sent_at")
            )
            if unchanged:
                results.append(
                    {**result, "status": "unchanged", "sequence": existing.get("sequence")}
                )
                continue
            sequence = int(existing.get("sequence") or 0) + 1
        else:
            sequence = 0

        ics = _render_ics(
            method=METHOD_REQUEST,
            uid=uid,
            sequence=sequence,
            session=session,
            event=event,
            room=room,
            contact=contact,
        )
        result["sequence"] = sequence

        if dry_run:
            results.append({**result, "status": "dry_run", "ics": ics})
            continue

        subject = f"Invite: {session.get('title') or 'Your session'} — {when}"
        body = _html_body(
            session=session,
            event=event,
            contact=contact,
            location=location,
            when=when,
            links=_links(session, event, uid),
            cancelled=False,
        )
        try:
            delivery = await send_email(
                to=str(contact["email"]),
                subject=subject,
                html=body,
                ics_content=ics,
                ics_method=METHOD_REQUEST,
            )
        except Exception as exc:  # one bad address must not sink the batch
            logger.exception("invites: send failed session=%s contact=%s", session_id, contact["id"])
            results.append({**result, "status": "failed", "error": str(exc)})
            continue

        await _persist_invite(
            existing,
            {
                "org_id": org_id,
                "session_id": session_id,
                "contact_id": contact["id"],
                "ics_uid": uid,
                "sequence": sequence,
                "last_method": METHOD_REQUEST,
                "last_sent_at": datetime.now(timezone.utc).isoformat(),
                "last_payload_hash": current_hash,
            },
            org_id,
        )
        results.append({**result, "status": "sent", "delivery": delivery})

    return _summary(session_id, METHOD_REQUEST, results, dry_run=dry_run)


async def cancel_session_invites(session_id: str, org_id: str) -> dict:
    """METHOD:CANCEL every invite previously sent for this session."""
    context = await _load_context(session_id, org_id)
    session, event, room = context["session"], context["event"], context["room"]

    ledger = await _existing_invites(session_id, org_id)
    if not ledger:
        return _summary(session_id, METHOD_CANCEL, [])

    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select("id, email, first_name, last_name")
            .in_("id", list(ledger.keys()))
            .eq("org_id", org_id)
            .execute(),
            "invites_cancel_contacts",
        )
    )
    contacts_by_id = {c["id"]: c for c in contacts}
    location = _location(session, room, event)
    when = _when(session, event)

    results: list[dict] = []
    for contact_id, existing in ledger.items():
        contact = contacts_by_id.get(contact_id)
        result: dict = {"contact_id": contact_id, "ics_uid": existing.get("ics_uid")}
        if not contact or not contact.get("email"):
            results.append({**result, "status": "skipped", "error": "No contact email"})
            continue

        result.update({"email": contact.get("email"), "name": _contact_name(contact)})
        if existing.get("last_method") == METHOD_CANCEL:
            results.append({**result, "status": "unchanged", "sequence": existing.get("sequence")})
            continue

        # A CANCEL is matched on UID + a SEQUENCE higher than the last one seen.
        sequence = int(existing.get("sequence") or 0) + 1
        ics = _render_ics(
            method=METHOD_CANCEL,
            uid=existing.get("ics_uid") or invite_uid(session_id, contact_id),
            sequence=sequence,
            session=session,
            event=event,
            room=room,
            contact=contact,
        )
        body = _html_body(
            session=session,
            event=event,
            contact=contact,
            location=location,
            when=when,
            links=_links(session, event, existing.get("ics_uid") or ""),
            cancelled=True,
        )
        try:
            delivery = await send_email(
                to=str(contact["email"]),
                subject=f"Cancelled: {session.get('title') or 'Your session'}",
                html=body,
                ics_content=ics,
                ics_method=METHOD_CANCEL,
            )
        except Exception as exc:
            logger.exception("invites: cancel failed session=%s contact=%s", session_id, contact_id)
            results.append({**result, "status": "failed", "sequence": sequence, "error": str(exc)})
            continue

        await _persist_invite(
            existing,
            {
                "sequence": sequence,
                "last_method": METHOD_CANCEL,
                "last_sent_at": datetime.now(timezone.utc).isoformat(),
                "last_payload_hash": None,
            },
            org_id,
        )
        results.append({**result, "status": "sent", "sequence": sequence, "delivery": delivery})

    return _summary(session_id, METHOD_CANCEL, results)


def _summary(session_id: str, method: str, results: list[dict], *, dry_run: bool = False) -> dict:
    counts: dict[str, int] = {}
    for row in results:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    return {
        "session_id": session_id,
        "method": method,
        "dry_run": dry_run,
        "attendees": len(results),
        "counts": counts,
        "results": results,
    }


async def build_ics_for_uid(uid: str) -> str:
    """Regenerate the invite for a ledger UID (public download).

    Regenerated from live session data rather than stored bytes: whoever opens
    the link gets today's time and room, not whatever was mailed last week.

    The ledger is authoritative on METHOD, though: once an invite has been
    cancelled (last_method == 'CANCEL'), the download must stay a CANCEL —
    re-deriving a REQUEST from live data would silently resurrect a dead hold on
    the attendee's calendar. A cancellation is matched on UID + SEQUENCE, so a
    session that has since been unscheduled can still hand back its CANCEL.
    """
    invite = first(
        await db(
            lambda: supabase.table("calendar_invites")
            .select("*")
            .eq("ics_uid", uid)
            .limit(1)
            .execute(),
            "invites_by_uid",
        )
    )
    if not invite:
        raise InviteTargetNotFound("Invite not found")

    org_id = invite["org_id"]
    context = await _load_context(invite["session_id"], org_id)
    session, event, room = context["session"], context["event"], context["room"]

    is_cancel = invite.get("last_method") == METHOD_CANCEL
    if not is_cancel and (
        not _parse_ts(session.get("starts_at")) or not _parse_ts(session.get("ends_at"))
    ):
        raise SessionNotScheduled("Session is not scheduled")

    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id, email, first_name, last_name")
            .eq("id", invite["contact_id"])
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "invites_uid_contact",
        )
    )
    if not contact:
        raise InviteTargetNotFound("Invite contact not found")

    return _render_ics(
        method=METHOD_CANCEL if is_cancel else METHOD_REQUEST,
        uid=uid,
        sequence=int(invite.get("sequence") or 0),
        session=session,
        event=event,
        room=room,
        contact=contact,
    )
