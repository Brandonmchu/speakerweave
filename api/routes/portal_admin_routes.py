"""Organizer side of the speaker portal (requirement #2, admin surface).

JWT-authed and org-scoped, the mirror image of routes/portal_routes.py: the
organizer sees who their speakers are and how far along onboarding is, invites
them into the portal, authors the tasks the portal shows, and reviews the files
that come back.

The one thing Other Conference/CFP Software is missing that this adds: a denied file review
notifies the speaker. Both an approval and a denial queue a short email, so a
speaker never has to guess why their upload is still outstanding.
"""

from __future__ import annotations

import html as html_module
import logging
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from app.core.settings import settings
from auth import (
    get_current_user_and_org,
    get_current_user_or_api_org,
    get_display_name,
    verify_org_access,
)
from services import content_pipeline
from services.magic_links import mint
from services.org_scope import fetch_event
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/api", tags=["portal-admin"])
logger = logging.getLogger(__name__)

# Who owes a headshot and a bio: the people on stage or who filed the talk.
SPEAKER_ROLES = ("speaker", "submitter")
# task_assignments.status that count as finished work (mirrors dashboard).
DONE_STATUSES = frozenset({"approved", "done"})
# The kinds a minimal task author can create. `form` needs a form builder that
# is out of scope here.
TASK_KINDS = ("todo", "file_request")
PORTAL_INVITE_TTL_HOURS = 24 * 30  # a portal link is a season pass, not a OTP


class TaskCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    kind: str = Field(default="todo")
    link_url: str | None = Field(default=None, max_length=500)
    due_at: datetime | None = None
    required: bool = False
    contact_ids: list[str] = Field(default_factory=list)


class ReviewRequest(BaseModel):
    decision: str  # 'approved' | 'denied'


class CommentRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)
    # queue the speaker a heads-up email that new feedback is waiting
    notify: bool = True


class RestoreRequest(BaseModel):
    # which version of the item's history to make current again
    version: int = Field(..., ge=1)


class RemindRequest(BaseModel):
    # by default only nudge speakers missing REQUIRED content
    required_only: bool = True
    item_type: str | None = Field(default=None, max_length=40)


def _contact_name(contact: dict) -> str:
    name = " ".join(
        part for part in (contact.get("first_name"), contact.get("last_name")) if part
    ).strip()
    return name or str(contact.get("email") or "Speaker")


async def _queue_email(
    org_id: str,
    event_id: str | None,
    contact_id: str | None,
    template_key: str,
    subject: str,
    html: str,
    *,
    dedupe_key: str | None = None,
) -> bool:
    """Drop a message onto the email_outbox for the sender worker to pick up.

    Best-effort: a notification that fails to enqueue must not fail the review or
    invite it accompanies. Returns True iff a new row was queued.

    When ``dedupe_key`` is set, a matching (event_id, dedupe_key) row already in
    the outbox short-circuits the insert — a coarse-window key (e.g. per day) is
    how bulk reminders stay idempotent under repeated clicks/retries, backing up
    the ``unique(event_id, dedupe_key)`` constraint the DB also enforces."""
    if dedupe_key:
        existing = rows(
            await db(
                lambda: supabase.table("email_outbox")
                .select("id")
                .eq("event_id", event_id)
                .eq("dedupe_key", dedupe_key)
                .limit(1)
                .execute(),
                "portal_queue_dedupe_check",
            )
        )
        if existing:
            return False

    record: dict = {
        "org_id": org_id,
        "event_id": event_id,
        "contact_id": contact_id,
        "template_key": template_key,
        "payload": {"subject": subject, "html": html},
        "status": "queued",
    }
    if dedupe_key:
        record["dedupe_key"] = dedupe_key
    try:
        await db(
            lambda: supabase.table("email_outbox").insert(record).execute(),
            "portal_queue_email",
        )
        return True
    except Exception:
        logger.warning("portal: could not queue %s email contact=%s", template_key, contact_id, exc_info=True)
        return False


# ── speaker roster ──────────────────────────────────────────────────────────


@router.get("/events/{event_id}/speakers")
async def list_speakers(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """The event's whole speaker roster, with sessions + onboarding progress.

    The roster is every CONTACT on the event, not only the ones already booked
    onto a session. A speaker added by hand or imported from a CSV has no
    session and no task yet; keying the roster off session_participants made
    those people invisible, so "Add speaker" and "Import CSV" both reported
    success onto a list that never changed. Contacts are event-scoped rows, so
    the event's contacts ARE its roster; sessions and tasks are progress
    columns on top, and read as zeros for someone who has neither yet.

    A flat handful of grouped queries — never one per speaker — so the roster
    stays cheap as the event grows.
    """
    _user_id, org_id = auth
    event = await fetch_event(event_id, org_id, columns="id, org_id, name")

    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select(
                "id, first_name, last_name, email, company_name, title, photo_url, "
                "last_portal_access_at"
            )
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "speakers_contacts",
        )
    )
    contact_ids = sorted({c["id"] for c in contacts if c.get("id")})
    roster_ids = set(contact_ids)

    sessions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "speakers_sessions",
        )
    )
    session_ids = sorted({s["id"] for s in sessions if s.get("id")})

    participants: list[dict] = []
    if session_ids and contact_ids:
        participants = rows(
            await db(
                lambda: supabase.table("session_participants")
                .select("contact_id, session_id, role")
                .eq("org_id", org_id)
                .in_("session_id", session_ids)
                .in_("role", list(SPEAKER_ROLES))
                .execute(),
                "speakers_participants",
            )
        )

    sessions_by_contact: dict[str, set[str]] = defaultdict(set)
    for participant in participants:
        contact_id = participant.get("contact_id")
        session_id = participant.get("session_id")
        if contact_id in roster_ids and session_id:
            sessions_by_contact[contact_id].add(session_id)

    # task progress: the event's tasks, then those tasks' assignments to these
    # contacts — two grouped queries, aggregated in memory.
    task_ids: list[str] = []
    tasks_by_id: dict[str, dict] = {}
    if contact_ids:
        tasks_by_id = {
            str(task["id"]): task
            for task in rows(
                await db(
                    lambda: supabase.table("tasks")
                    .select("id, name, due_at, required")
                    .eq("org_id", org_id)
                    .eq("event_id", event_id)
                    .execute(),
                    "speakers_tasks",
                )
            )
            if task.get("id")
        }
        task_ids = sorted(tasks_by_id)

    assignments: list[dict] = []
    if task_ids and contact_ids:
        assignments = rows(
            await db(
                lambda: supabase.table("task_assignments")
                .select("id, task_id, contact_id, status")
                .eq("org_id", org_id)
                .in_("task_id", task_ids)
                .in_("contact_id", contact_ids)
                .execute(),
                "speakers_assignments",
            )
        )
    total_by_contact: dict[str, int] = defaultdict(int)
    done_by_contact: dict[str, int] = defaultdict(int)
    tasks_by_contact: dict[str, list[dict]] = defaultdict(list)
    for assignment in assignments:
        contact_id = assignment.get("contact_id")
        if contact_id not in roster_ids:
            continue
        task = tasks_by_id.get(str(assignment.get("task_id") or ""), {})
        done = assignment.get("status") in DONE_STATUSES
        total_by_contact[contact_id] += 1
        if done:
            done_by_contact[contact_id] += 1
        tasks_by_contact[contact_id].append(
            {
                "assignment_id": assignment.get("id"),
                "task_id": assignment.get("task_id"),
                "name": task.get("name") or "Task",
                "status": assignment.get("status"),
                "done": done,
                "due_at": task.get("due_at"),
                "required": bool(task.get("required")),
            }
        )

    for task_list in tasks_by_contact.values():
        task_list.sort(key=lambda task: (task["done"], str(task["name"]).casefold()))

    invited: set[str] = set()
    if contact_ids:
        invited = {
            link["contact_id"]
            for link in rows(
                await db(
                    lambda: supabase.table("magic_link_tokens")
                    .select("contact_id")
                    .eq("org_id", org_id)
                    .eq("purpose", "portal")
                    .in_("contact_id", contact_ids)
                    .execute(),
                    "speakers_invites",
                )
            )
            if link.get("contact_id")
        }

    speakers: list[dict] = []
    for contact in contacts:
        contact_id = contact.get("id")
        total = total_by_contact.get(contact_id, 0)
        done = done_by_contact.get(contact_id, 0)
        speakers.append(
            {
                "contact_id": contact_id,
                "name": _contact_name(contact),
                "email": contact.get("email"),
                "company_name": contact.get("company_name"),
                "title": contact.get("title"),
                "photo_url": contact.get("photo_url"),
                "session_count": len(sessions_by_contact.get(contact_id, set())),
                "last_portal_access_at": contact.get("last_portal_access_at"),
                "tasks_total": total,
                "tasks_done": done,
                "tasks_outstanding": max(total - done, 0),
                "tasks": tasks_by_contact.get(contact_id, []),
                "invited": contact_id in invited,
            }
        )

    # Most outstanding work first — the chase list an organizer actually works.
    speakers.sort(key=lambda s: (-s["tasks_outstanding"], str(s["name"]).lower()))
    return {"event": {"id": event["id"], "name": event.get("name")}, "speakers": speakers}


# ── portal invite ───────────────────────────────────────────────────────────


@router.post("/contacts/{contact_id}/portal-invite")
async def send_portal_invite(contact_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """Mint a portal magic link for a speaker, queue the invite email, and hand
    the minted URL back so the organizer can share it directly while email
    delivery is still pending a mail provider."""
    _user_id, org_id = auth
    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id, org_id, event_id, first_name, last_name, email")
            .eq("id", contact_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "invite_contact_lookup",
        )
    )
    verify_org_access(contact, org_id, "Speaker")
    if not contact.get("email"):
        raise HTTPException(status_code=400, detail="This speaker has no email address.")

    event = first(
        await db(
            lambda: supabase.table("events")
            .select("id, name")
            .eq("id", contact["event_id"])
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "invite_event_lookup",
        )
    )
    event_name = (event or {}).get("name") or "the event"

    token = await mint(
        org_id, "portal", contact_id=contact_id, ttl_hours=PORTAL_INVITE_TTL_HOURS
    )
    link = f"{settings.frontend_url.rstrip('/')}/portal/{token}"

    greeting = html_module.escape((contact.get("first_name") or "").strip() or "there")
    subject = f"[{event_name}] Your speaker portal"
    body = (
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
        'font-size:15px;line-height:1.5;color:#111">'
        f"<p>Hi {greeting},</p>"
        f"<p>You're speaking at {html_module.escape(event_name)}. Your speaker portal is where you"
        " confirm your details, upload your headshot and slides, and check off your"
        " onboarding tasks.</p>"
        f'<p style="margin:20px 0"><a href="{html_module.escape(link)}" '
        'style="background:#4962E2;color:#fff;text-decoration:none;padding:10px 18px;'
        'border-radius:8px;display:inline-block;font-weight:600">Open your portal</a></p>'
        f'<p style="color:#666;font-size:13px">Or paste this link into your browser:<br>'
        f'{html_module.escape(link)}</p>'
        "</div>"
    )
    await _queue_email(org_id, contact["event_id"], contact_id, "portal_invite", subject, body)
    return {"ok": True, "invited": True, "invite_url": link}


# ── task authoring ──────────────────────────────────────────────────────────


@router.post("/events/{event_id}/tasks", status_code=201)
async def create_task(
    event_id: str,
    payload: TaskCreateRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Create one onboarding task and assign it to the given speakers."""
    _user_id, org_id = auth
    await fetch_event(event_id, org_id)

    if payload.kind not in TASK_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"kind must be one of {', '.join(TASK_KINDS)}",
        )

    # Attach to the event's portal if it has one (nullable otherwise).
    portal_row = first(
        await db(
            lambda: supabase.table("portals")
            .select("id")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .limit(1)
            .execute(),
            "task_portal_lookup",
        )
    )

    task_record = {
        "org_id": org_id,
        "event_id": event_id,
        "portal_id": (portal_row or {}).get("id"),
        "kind": payload.kind,
        "name": payload.name.strip(),
        "description": payload.description,
        "link_url": payload.link_url,
        "due_at": payload.due_at.isoformat() if payload.due_at else None,
        "required": payload.required,
    }
    task = first(
        await db(
            lambda: supabase.table("tasks").insert(task_record).execute(),
            "task_create",
        )
    )
    if not task:
        raise HTTPException(status_code=500, detail="Could not create task")

    # Only assign to contacts that actually belong to this org+event — a
    # hand-picked id list from the client is not trusted.
    requested = [cid for cid in dict.fromkeys(payload.contact_ids) if cid]
    valid_ids: list[str] = []
    if requested:
        valid_ids = [
            c["id"]
            for c in rows(
                await db(
                    lambda: supabase.table("contacts")
                    .select("id")
                    .eq("org_id", org_id)
                    .eq("event_id", event_id)
                    .in_("id", requested)
                    .execute(),
                    "task_assign_contacts",
                )
            )
            if c.get("id")
        ]

    if valid_ids:
        await db(
            lambda: supabase.table("task_assignments")
            .insert(
                [
                    {"org_id": org_id, "task_id": task["id"], "contact_id": cid, "status": "todo"}
                    for cid in valid_ids
                ]
            )
            .execute(),
            "task_assignments_create",
        )

    return {"task": task, "assignments_created": len(valid_ids)}


# ── file review ─────────────────────────────────────────────────────────────


@router.patch("/task-assignments/{assignment_id}/review")
async def review_assignment(
    assignment_id: str,
    payload: ReviewRequest,
    request: Request,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Approve or deny a submitted file. Both outcomes notify the speaker; a
    denial leaves the assignment re-submittable."""
    _user_id, org_id = auth
    if payload.decision not in ("approved", "denied"):
        raise HTTPException(status_code=400, detail="decision must be 'approved' or 'denied'")

    assignment = first(
        await db(
            lambda: supabase.table("task_assignments")
            .select("id, org_id, task_id, contact_id, status")
            .eq("id", assignment_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_assignment_lookup",
        )
    )
    verify_org_access(assignment, org_id, "Task assignment")

    updated = first(
        await db(
            lambda: supabase.table("task_assignments")
            .update({"status": payload.decision})
            .eq("id", assignment_id)
            .eq("org_id", org_id)
            .execute(),
            "review_assignment_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Task assignment not found")

    await content_pipeline.record_review_status_event(
        org_id,
        assignment,
        payload.decision,
        author_label=get_display_name(request),
    )
    await _notify_review(org_id, assignment, payload.decision)
    return {"assignment": updated}


async def _notify_review(org_id: str, assignment: dict, decision: str) -> None:
    """Queue the approve/deny notification the speaker gets either way."""
    task = first(
        await db(
            lambda: supabase.table("tasks")
            .select("id, name, event_id")
            .eq("id", assignment.get("task_id"))
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_task_lookup",
        )
    )
    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id, first_name, email")
            .eq("id", assignment.get("contact_id"))
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_contact_lookup",
        )
    )
    if not contact or not contact.get("email"):
        return

    task_name = html_module.escape((task or {}).get("name") or "your file")
    greeting = html_module.escape((contact.get("first_name") or "").strip() or "there")
    if decision == "approved":
        subject = f"Approved: {(task or {}).get('name') or 'your submission'}"
        lead = f"Your submission for <strong>{task_name}</strong> has been approved. Nothing more to do here — thank you!"
    else:
        subject = f"Please resubmit: {(task or {}).get('name') or 'your submission'}"
        lead = (
            f"Your submission for <strong>{task_name}</strong> needs another look. "
            "Head back to your speaker portal to upload a new version."
        )
    body = (
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
        'font-size:15px;line-height:1.5;color:#111">'
        f"<p>Hi {greeting},</p><p>{lead}</p></div>"
    )
    await _queue_email(
        org_id, (task or {}).get("event_id"), contact.get("id"), f"task_{decision}", subject, body
    )


# ── content library (cross-speaker) ──────────────────────────────────────────


@router.get("/events/{event_id}/content")
async def list_content(
    event_id: str,
    type: str | None = Query(default=None, description="slides|headshot|bio|other|all"),
    status: str | None = Query(default=None, description="received|missing|needs_changes|all"),
    auth: tuple = Depends(get_current_user_and_org),
):
    """Every collected deliverable across the event's speakers, filterable by item
    type and status, plus who is still outstanding on required content."""
    _user_id, org_id = auth
    return await content_pipeline.list_content(org_id, event_id, item_type=type, status=status)


@router.get("/task-assignments/{assignment_id}/content")
async def get_content_item(assignment_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """One content item's version history + comment thread (org-scoped)."""
    _user_id, org_id = auth
    return await content_pipeline.content_item(org_id, assignment_id)


@router.post("/task-assignments/{assignment_id}/restore")
async def restore_content_version(
    assignment_id: str,
    payload: RestoreRequest,
    request: Request,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Roll a content item back to one of its earlier versions.

    The version history IS the change log, and this is its undo: the prior
    upload becomes current again while every version row stays on disk, so the
    move is auditable and reversible. Returns the item's refreshed detail
    (versions + thread) so the caller re-renders from one response.
    """
    _user_id, org_id = auth
    return await content_pipeline.restore_version(
        org_id,
        assignment_id,
        payload.version,
        author_label=get_display_name(request),
    )


@router.post("/task-assignments/{assignment_id}/comments", status_code=201)
async def add_content_comment(
    assignment_id: str,
    payload: CommentRequest,
    request: Request,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Organizer leaves feedback on a speaker's content item. The speaker sees it
    in their portal, and (by default) gets an email nudge that feedback is waiting."""
    _user_id, org_id = auth
    result = await content_pipeline.add_organizer_comment(
        org_id,
        assignment_id,
        payload.body,
        author_label=get_display_name(request),
    )
    if payload.notify:
        await _notify_comment(org_id, result)
    return {"comment": result["comment"]}


async def _notify_comment(org_id: str, result: dict) -> None:
    """Queue the 'new feedback on your content' email the speaker gets."""
    contact = result.get("contact") or {}
    task = result.get("task") or {}
    if not contact.get("email"):
        return
    item_name = html_module.escape(task.get("name") or "your content")
    greeting = html_module.escape((contact.get("first_name") or "").strip() or "there")
    subject = f"New feedback: {task.get('name') or 'your content'}"
    body = (
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
        'font-size:15px;line-height:1.5;color:#111">'
        f"<p>Hi {greeting},</p>"
        f"<p>An organizer left feedback on <strong>{item_name}</strong>. "
        "Open your speaker portal to read it and reply or upload a new version.</p></div>"
    )
    await _queue_email(org_id, task.get("event_id"), contact.get("id"), "content_feedback", subject, body)


# ── bulk reminders ───────────────────────────────────────────────────────────


@router.post("/events/{event_id}/content/remind")
async def remind_outstanding(
    event_id: str,
    payload: RemindRequest,
    auth: tuple = Depends(get_current_user_or_api_org),
):
    """Queue one reminder email to each speaker missing required content. Returns
    how many were reminded."""
    _user_id, org_id = auth
    # `org_id` MUST be in the projection: fetch_event verifies the row's org
    # against the caller's, so leaving it out 404s an event you own. That typo
    # is what made this endpoint answer "Event not found" for every valid id.
    event = await fetch_event(event_id, org_id, columns="id, org_id, name")
    groups = await content_pipeline.outstanding_by_contact(
        org_id, event_id, required_only=payload.required_only, item_type=payload.item_type
    )
    event_name = html_module.escape(event.get("name") or "the event")
    # Coarse per-day window: a second "remind" click the same day is a no-op, so
    # a jumpy organizer (or a retry) can't flood a speaker's inbox.
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    reminded = 0
    for group in groups:
        greeting = html_module.escape((group.get("first_name") or "").strip() or "there")
        items = "".join(
            f"<li>{html_module.escape(str(name))}</li>" for name in group.get("missing", [])
        )
        subject = f"[{event.get('name') or 'Reminder'}] Content still needed"
        body = (
            '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
            'font-size:15px;line-height:1.5;color:#111">'
            f"<p>Hi {greeting},</p>"
            f"<p>We're still missing some content from you for {event_name}:</p>"
            f"<ul>{items}</ul>"
            "<p>Please open your speaker portal to upload it. Thank you!</p></div>"
        )
        queued = await _queue_email(
            org_id,
            event["id"],
            group.get("contact_id"),
            "content_reminder",
            subject,
            body,
            dedupe_key=f"content-reminder:{group.get('contact_id')}:{day}",
        )
        if queued:
            reminded += 1

    return {
        "reminded": reminded,
        "outstanding": len(groups),
        "contacts": [g.get("contact_id") for g in groups],
    }


# ── bundle export ────────────────────────────────────────────────────────────


@router.get("/events/{event_id}/content/export")
async def export_content(
    event_id: str,
    format: str = Query(default="zip", description="zip|manifest"),
    assignment_ids: str | None = Query(
        default=None,
        description="comma-separated content item ids; omit to export the whole event",
    ),
    auth: tuple = Depends(get_current_user_and_org),
):
    """Bundle collected files (current version of each) into a ZIP named by
    speaker/item.

    Every item on the event by default; pass ``?assignment_ids=a,b,c`` to bundle
    only the ones an organizer ticked in the library. Ids are intersected with
    the event's own items, so an id from another org contributes nothing.
    ``?format=manifest`` returns a metadata-only JSON listing (filenames, sizes,
    URLs) without downloading a single byte."""
    _user_id, org_id = auth
    selected = [part.strip() for part in (assignment_ids or "").split(",") if part.strip()] or None
    if format == "manifest":
        return await content_pipeline.export_manifest(org_id, event_id, selected)
    zip_bytes = await content_pipeline.build_export_zip(org_id, event_id, selected)
    suffix = f"-{len(selected)}-selected" if selected else ""
    headers = {"Content-Disposition": f'attachment; filename="content-{event_id}{suffix}.zip"'}
    return Response(content=zip_bytes, media_type="application/zip", headers=headers)
