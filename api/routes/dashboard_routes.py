"""The onboarding dashboard (requirement #6).

One screen that answers "which speakers still have outstanding onboarding
tasks", plus the submission funnel above it for context. The web client polls
this endpoint every few seconds (PLAN §3: "polling that works beats a broken
subscription"), so the cost has to be flat: the whole payload is assembled from
a fixed handful of grouped queries and aggregated in memory, never one query
per speaker.

Nothing here writes. Every query carries the JWT-derived org predicate — the
service-role client bypasses RLS, so a missing predicate is a cross-org leak.
"""

from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends

from auth import get_current_user_and_org
from services.org_scope import fetch_event
from services.supabase_helpers import db, rows
from supabase_client import supabase

router = APIRouter(prefix="/api", tags=["dashboard"])

# The funnel the organizer reads left to right. `draft` is deliberately absent:
# a draft is not yet in anyone's queue. It still counts toward `total`, which
# means "every session on this event" — see _submission_funnel.
FUNNEL_STATUSES = (
    "pending",
    "accept_queue",
    "accepted",
    "decline_queue",
    "declined",
    "withdrawn",
)

# Who counts as a speaker for onboarding purposes. `chairperson`/`moderator`
# run the room; they are not the people who owe a headshot and a bio.
SPEAKER_ROLES = ("speaker", "submitter")

# task_assignments.status ∈ (todo, submitted, approved, denied, done).
# Only these two are finished work. `submitted` is waiting on an organizer's
# approval and `denied` has to be redone — both are still outstanding, which is
# precisely what this dashboard exists to surface.
DONE_STATUSES = frozenset({"approved", "done"})


def _contact_name(contact: dict) -> str:
    """"First Last", falling back to the email we always have."""
    name = " ".join(
        part for part in (contact.get("first_name"), contact.get("last_name")) if part
    ).strip()
    return name or str(contact.get("email") or "Unknown speaker")


def _sent_key(row: dict) -> str:
    """Recency of an outbox row. ISO-8601 text sorts chronologically; a queued
    mail has no sent_at yet, so created_at stands in."""
    return str(row.get("sent_at") or row.get("created_at") or "")


def _submission_funnel(sessions: list[dict]) -> dict[str, int]:
    funnel = {status: 0 for status in FUNNEL_STATUSES}
    for session in sessions:
        status = session.get("status")
        if status in funnel:
            funnel[status] += 1
    # Every session on the event, drafts included — the denominator, not the
    # sum of the six columns above it.
    funnel["total"] = len(sessions)
    return funnel


@router.get("/events/{event_id}/dashboard")
async def event_dashboard(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """Real-time onboarding state for one event.

    Returns `{submission_funnel, speakers, totals}`. Speakers are the distinct
    contacts attached to this event's sessions as a speaker or submitter, each
    with their task progress, last portal visit and last email.

    Task counts read 0 for everybody until the portal feature starts creating
    `tasks`/`task_assignments` rows; the aggregation is driven entirely off
    those two tables, so the dashboard lights up on its own the moment they
    exist — no change needed here.
    """
    _user_id, org_id = auth
    await fetch_event(event_id, org_id)

    sessions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id, status")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "dashboard_sessions",
        )
    )
    funnel = _submission_funnel(sessions)

    status_by_session = {s["id"]: s.get("status") for s in sessions if s.get("id")}
    session_ids = sorted(status_by_session)

    # ── who the speakers are ────────────────────────────────────────────────
    # session_participants has no event_id of its own, so it is scoped through
    # the session ids we just read (which were themselves org+event scoped).
    participants: list[dict] = []
    if session_ids:
        participants = rows(
            await db(
                lambda: supabase.table("session_participants")
                .select("contact_id, session_id, role")
                .eq("org_id", org_id)
                .in_("session_id", session_ids)
                .in_("role", list(SPEAKER_ROLES))
                .execute(),
                "dashboard_participants",
            )
        )

    # A contact can be both submitter and speaker on the same session, and can
    # hold several sessions — a set per contact collapses both into "how many
    # sessions is this person on".
    sessions_by_contact: dict[str, set[str]] = defaultdict(set)
    for participant in participants:
        contact_id = participant.get("contact_id")
        session_id = participant.get("session_id")
        if contact_id and session_id in status_by_session:
            sessions_by_contact[contact_id].add(session_id)

    contact_ids = sorted(sessions_by_contact)

    contacts: list[dict] = []
    if contact_ids:
        contacts = rows(
            await db(
                lambda: supabase.table("contacts")
                .select("id, first_name, last_name, email, last_portal_access_at")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .in_("id", contact_ids)
                .execute(),
                "dashboard_contacts",
            )
        )

    # ── task progress ───────────────────────────────────────────────────────
    # Two grouped queries, not one per speaker: the event's tasks, then every
    # assignment of those tasks to these contacts.
    tasks: list[dict] = []
    if contact_ids:
        tasks = rows(
            await db(
                lambda: supabase.table("tasks")
                .select("id")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .execute(),
                "dashboard_tasks",
            )
        )
    task_ids = sorted({t["id"] for t in tasks if t.get("id")})

    assignments: list[dict] = []
    if task_ids and contact_ids:
        assignments = rows(
            await db(
                lambda: supabase.table("task_assignments")
                .select("task_id, contact_id, status")
                .eq("org_id", org_id)
                .in_("task_id", task_ids)
                .in_("contact_id", contact_ids)
                .execute(),
                "dashboard_task_assignments",
            )
        )

    assigned: dict[str, int] = defaultdict(int)
    completed: dict[str, int] = defaultdict(int)
    for assignment in assignments:
        contact_id = assignment.get("contact_id")
        if contact_id not in sessions_by_contact:
            continue
        assigned[contact_id] += 1
        if assignment.get("status") in DONE_STATUSES:
            completed[contact_id] += 1

    # ── last touch ──────────────────────────────────────────────────────────
    last_email: dict[str, dict] = {}
    if contact_ids:
        for row in rows(
            await db(
                lambda: supabase.table("email_outbox")
                .select("contact_id, template_key, status, sent_at, created_at")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .in_("contact_id", contact_ids)
                .execute(),
                "dashboard_emails",
            )
        ):
            contact_id = row.get("contact_id")
            if not contact_id:
                continue
            current = last_email.get(contact_id)
            if current is None or _sent_key(row) >= _sent_key(current):
                last_email[contact_id] = row

    # ── assemble ────────────────────────────────────────────────────────────
    speakers: list[dict] = []
    for contact in contacts:
        contact_id = contact.get("id")
        their_sessions = sessions_by_contact.get(contact_id, set())

        summary: dict[str, int] = defaultdict(int)
        for session_id in their_sessions:
            status = status_by_session.get(session_id)
            if status:
                summary[status] += 1

        tasks_total = assigned.get(contact_id, 0)
        tasks_done = completed.get(contact_id, 0)
        tasks_outstanding = max(tasks_total - tasks_done, 0)
        email = last_email.get(contact_id)

        # ONBOARDING_COMPLETE: signed into the portal at least once, has been
        # given something to do, and owes nothing back.
        #
        # Zero outstanding *assignments* is stricter than the "no outstanding
        # required tasks" the requirement asks for, and deliberately so:
        # tasks.required defaults to false (migration 001), so gating on that
        # column alone would mark every speaker complete the instant they
        # opened the portal — the opposite of what this screen is for.
        #
        # No tasks assigned yet reads as not-started, not complete: an
        # organizer who hasn't set up the portal has not onboarded anybody.
        onboarding_complete = (
            bool(contact.get("last_portal_access_at"))
            and tasks_total > 0
            and tasks_outstanding == 0
        )

        speakers.append(
            {
                "contact_id": contact_id,
                "name": _contact_name(contact),
                "email": contact.get("email"),
                "session_count": len(their_sessions),
                "status_summary": dict(sorted(summary.items())),
                "tasks_total": tasks_total,
                "tasks_done": tasks_done,
                "tasks_outstanding": tasks_outstanding,
                "last_portal_access_at": contact.get("last_portal_access_at"),
                "last_email": (
                    {
                        "template_key": email.get("template_key"),
                        "status": email.get("status"),
                        "sent_at": email.get("sent_at"),
                    }
                    if email
                    else None
                ),
                "onboarding_complete": onboarding_complete,
            }
        )

    # The point of the dashboard is the chase list: most outstanding work
    # first, then not-yet-started, then the people already done.
    speakers.sort(
        key=lambda s: (
            s["onboarding_complete"],
            -s["tasks_outstanding"],
            str(s["name"]).lower(),
        )
    )

    return {
        "submission_funnel": funnel,
        "speakers": speakers,
        "totals": {
            "speakers": len(speakers),
            "onboarded": sum(1 for s in speakers if s["onboarding_complete"]),
            "outstanding_tasks": sum(s["tasks_outstanding"] for s in speakers),
        },
    }
