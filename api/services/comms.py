"""Organizer communications: templates, audience resolution, delivery, and log.

The service-role Supabase client bypasses RLS.  Every lookup and mutation in
this module is therefore scoped with the JWT-derived ``org_id``; inserts carry
that same value in their record.  Recipient resolution deliberately uses
separate scoped queries instead of an embedded PostgREST relationship.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from auth import verify_org_access
from services import mailer
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

MERGE_TAGS = (
    "first_name",
    "last_name",
    "full_name",
    "email",
    "event_name",
    "session_title",
)
_MERGE_TAG_RE = re.compile(r"{{\s*(first_name|last_name|full_name|email|event_name|session_title)\s*}}")

DEFAULT_TEMPLATES: tuple[dict[str, str], ...] = (
    {
        "key": "accept",
        "subject": "You're speaking at {{event_name}}",
        "body_html": (
            "<p>Hi {{first_name}},</p>"
            "<p>We're delighted to accept <strong>{{session_title}}</strong> "
            "for {{event_name}}. We'll follow up soon with schedule details.</p>"
            "<p>Best,<br>The {{event_name}} team</p>"
        ),
    },
    {
        "key": "decline",
        "subject": "An update on your {{event_name}} submission",
        "body_html": (
            "<p>Hi {{first_name}},</p>"
            "<p>Thank you for submitting <strong>{{session_title}}</strong> to "
            "{{event_name}}. We weren't able to include it in this year's program.</p>"
            "<p>We appreciate the time and care you put into your proposal.</p>"
        ),
    },
    {
        "key": "reminder",
        "subject": "Reminder for {{session_title}} at {{event_name}}",
        "body_html": (
            "<p>Hi {{first_name}},</p>"
            "<p>This is a quick reminder about your session, "
            "<strong>{{session_title}}</strong>, at {{event_name}}.</p>"
            "<p>Please reply if anything has changed or if you need help.</p>"
        ),
    },
    {
        "key": "portal_invite",
        "subject": "Your {{event_name}} speaker portal",
        "body_html": (
            "<p>Hi {{first_name}},</p>"
            "<p>Your speaker portal for {{event_name}} is ready. Use it to review "
            "your profile and the details for <strong>{{session_title}}</strong>.</p>"
            "<p>This invitation was sent to {{email}}.</p>"
        ),
    },
)


def render_template(text: str, context: dict[str, Any]) -> str:
    """Substitute supported merge tags, leaving every unknown tag untouched."""

    def replace(match: re.Match[str]) -> str:
        value = context.get(match.group(1), "")
        return "" if value is None else str(value)

    return _MERGE_TAG_RE.sub(replace, text or "")


async def get_scoped_event(event_id: str, org_id: str) -> dict:
    event = first(
        await db(
            lambda: supabase.table("events")
            .select("id, org_id, name")
            .eq("id", event_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "comms_event_lookup",
        )
    )
    return verify_org_access(event, org_id, "Event")


async def list_templates(event_id: str, org_id: str) -> list[dict]:
    """List event templates, seeding the four defaults on first access."""
    await get_scoped_event(event_id, org_id)
    templates = rows(
        await db(
            lambda: supabase.table("email_templates")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "comms_templates_list",
        )
    )
    if not templates:
        records = [
            {"org_id": org_id, "event_id": event_id, **template}
            for template in DEFAULT_TEMPLATES
        ]
        await db(
            lambda: supabase.table("email_templates")
            .upsert(records, on_conflict="event_id,key")
            .execute(),
            "comms_templates_seed",
        )
        templates = rows(
            await db(
                lambda: supabase.table("email_templates")
                .select("*")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .execute(),
                "comms_templates_list_seeded",
            )
        )
    return sorted(templates, key=lambda row: str(row.get("key") or ""))


async def upsert_template(
    event_id: str,
    org_id: str,
    *,
    key: str,
    subject: str,
    body_html: str,
) -> dict:
    await get_scoped_event(event_id, org_id)
    record = {
        "org_id": org_id,
        "event_id": event_id,
        "key": key,
        "subject": subject,
        "body_html": body_html,
    }
    template = first(
        await db(
            lambda: supabase.table("email_templates")
            .upsert(record, on_conflict="event_id,key")
            .execute(),
            "comms_template_upsert",
        )
    )
    if not template:
        raise HTTPException(status_code=500, detail="Could not save email template")
    return template


async def get_scoped_template(template_id: str, org_id: str) -> dict:
    template = first(
        await db(
            lambda: supabase.table("email_templates")
            .select("*")
            .eq("id", template_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "comms_template_lookup",
        )
    )
    return verify_org_access(template, org_id, "Email template")


async def patch_template(template_id: str, org_id: str, patch: dict[str, str]) -> dict:
    await get_scoped_template(template_id, org_id)
    updated = first(
        await db(
            lambda: supabase.table("email_templates")
            .update(patch)
            .eq("id", template_id)
            .eq("org_id", org_id)
            .execute(),
            "comms_template_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Email template not found")
    return updated


async def delete_template(template_id: str, org_id: str) -> None:
    await get_scoped_template(template_id, org_id)
    deleted = first(
        await db(
            lambda: supabase.table("email_templates")
            .delete()
            .eq("id", template_id)
            .eq("org_id", org_id)
            .execute(),
            "comms_template_delete",
        )
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Email template not found")


async def resolve_recipients(
    event_id: str,
    org_id: str,
    *,
    roles: list[str] | None = None,
    statuses: list[str] | None = None,
) -> tuple[dict, list[dict]]:
    """Resolve distinct contacts and the first matching session for each."""
    event = await get_scoped_event(event_id, org_id)

    def session_query():
        query = (
            supabase.table("sessions")
            .select("id, org_id, event_id, title, status, created_at")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
        )
        if statuses:
            query = query.in_("status", statuses)
        return query.order("created_at").execute()

    sessions = rows(await db(session_query, "comms_recipient_sessions"))
    session_by_id = {str(row["id"]): row for row in sessions}
    session_rank = {str(row["id"]): index for index, row in enumerate(sessions)}
    if not session_by_id:
        return event, []

    def participant_query():
        query = (
            supabase.table("session_participants")
            .select("id, org_id, session_id, contact_id, role")
            .eq("org_id", org_id)
            .in_("session_id", list(session_by_id))
        )
        if roles:
            query = query.in_("role", roles)
        return query.execute()

    participants = rows(await db(participant_query, "comms_recipient_participants"))
    contact_to_participant: dict[str, dict] = {}
    for participant in participants:
        contact_id = str(participant.get("contact_id") or "")
        session_id = str(participant.get("session_id") or "")
        current = contact_to_participant.get(contact_id)
        if (
            contact_id
            and session_id in session_by_id
            and (
                current is None
                or session_rank[session_id] < session_rank[str(current["session_id"])]
            )
        ):
            contact_to_participant[contact_id] = participant
    if not contact_to_participant:
        return event, []

    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select("id, org_id, event_id, email, first_name, last_name")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .in_("id", list(contact_to_participant))
            .execute(),
            "comms_recipient_contacts",
        )
    )

    recipients: list[dict] = []
    for contact in contacts:
        participant = contact_to_participant.get(str(contact.get("id") or ""))
        if not participant:
            continue
        session = session_by_id[str(participant["session_id"])]
        first_name = str(contact.get("first_name") or "")
        last_name = str(contact.get("last_name") or "")
        full_name = " ".join(part for part in (first_name, last_name) if part).strip()
        recipients.append(
            {
                **contact,
                "role": participant.get("role"),
                "session_id": session.get("id"),
                "session_title": session.get("title") or "",
                "session_status": session.get("status"),
                "full_name": full_name or str(contact.get("email") or ""),
            }
        )

    recipients.sort(key=lambda row: (str(row.get("full_name") or "").casefold(), str(row["id"])))
    return event, recipients


def merge_context(recipient: dict, event: dict) -> dict[str, str]:
    return {
        "first_name": str(recipient.get("first_name") or ""),
        "last_name": str(recipient.get("last_name") or ""),
        "full_name": str(recipient.get("full_name") or recipient.get("email") or ""),
        "email": str(recipient.get("email") or ""),
        "event_name": str(event.get("name") or ""),
        "session_title": str(recipient.get("session_title") or ""),
    }


async def _template_by_key(event_id: str, org_id: str, template_key: str) -> dict:
    template = first(
        await db(
            lambda: supabase.table("email_templates")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("key", template_key)
            .limit(1)
            .execute(),
            "comms_send_template_lookup",
        )
    )
    if not template:
        raise HTTPException(status_code=404, detail="Email template not found")
    return template


async def send_communication(
    event_id: str,
    org_id: str,
    *,
    roles: list[str] | None,
    statuses: list[str] | None,
    template_key: str | None = None,
    subject: str | None = None,
    body_html: str | None = None,
) -> dict[str, int]:
    """Render, deliver, and write one truthful outbox row per recipient."""
    event, recipients = await resolve_recipients(
        event_id,
        org_id,
        roles=roles,
        statuses=statuses,
    )
    if template_key:
        template = await _template_by_key(event_id, org_id, template_key)
        subject_source = str(template.get("subject") or "")
        body_source = str(template.get("body_html") or "")
        outbox_template_key = template_key
    else:
        subject_source = subject or ""
        body_source = body_html or ""
        outbox_template_key = "custom"

    sent = 0
    failed = 0
    for recipient in recipients:
        context = merge_context(recipient, event)
        rendered_subject = render_template(subject_source, context)
        rendered_body = render_template(body_source, context)
        now = datetime.now(timezone.utc).isoformat()
        delivery: dict[str, Any] | None = None
        error: str | None = None
        status = "sent"
        try:
            delivery = await mailer.send_email(
                to=str(recipient.get("email") or ""),
                subject=rendered_subject,
                html=rendered_body,
            )
            sent += 1
        except Exception as exc:  # one bad recipient must not stop the batch
            logger.exception(
                "comms: send failed event=%s contact=%s",
                event_id,
                recipient.get("id"),
            )
            status = "failed"
            error = str(exc)
            failed += 1

        payload: dict[str, Any] = {
            "to": recipient.get("email"),
            "subject": rendered_subject,
            "body_html": rendered_body,
            "context": context,
        }
        if delivery is not None:
            payload["delivery"] = delivery
        await db(
            lambda recipient=recipient, payload=payload, status=status, error=error, now=now: (
                supabase.table("email_outbox")
                .insert(
                    {
                        "org_id": org_id,
                        "event_id": event_id,
                        "contact_id": recipient["id"],
                        "template_key": outbox_template_key,
                        "payload": payload,
                        "attempts": 1,
                        "last_error": error,
                        "status": status,
                        "sent_at": now if status == "sent" else None,
                        "created_at": now,
                    }
                )
                .execute()
            ),
            "comms_outbox_insert",
        )

    return {"sent": sent, "failed": failed, "total": len(recipients)}


async def communication_log(event_id: str, org_id: str, *, limit: int) -> list[dict]:
    await get_scoped_event(event_id, org_id)
    entries = rows(
        await db(
            lambda: supabase.table("email_outbox")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute(),
            "comms_log_list",
        )
    )
    contact_ids = sorted({str(row["contact_id"]) for row in entries if row.get("contact_id")})
    contacts_by_id: dict[str, dict] = {}
    if contact_ids:
        contacts = rows(
            await db(
                lambda: supabase.table("contacts")
                .select("id, first_name, last_name, email")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .in_("id", contact_ids)
                .execute(),
                "comms_log_contacts",
            )
        )
        contacts_by_id = {str(contact["id"]): contact for contact in contacts}

    result: list[dict] = []
    for entry in entries:
        contact = contacts_by_id.get(str(entry.get("contact_id") or ""))
        payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
        name = ""
        if contact:
            name = " ".join(
                part
                for part in (
                    str(contact.get("first_name") or ""),
                    str(contact.get("last_name") or ""),
                )
                if part
            ).strip()
        result.append(
            {
                **entry,
                "subject": payload.get("subject") or "",
                "recipient_name": name or (contact or {}).get("email") or payload.get("to") or "",
                "recipient_email": (contact or {}).get("email") or payload.get("to") or "",
            }
        )
    return result
