"""Canonical speaker onboarding, provisioned when a submission is accepted.

The six tasks are event-level so a speaker with more than one accepted session
sees one checklist rather than duplicate work per talk.  ``kind`` documents how
the portal should treat each item: travel forms are linked todos (so speakers
can mark an external form complete), profile photos request a file, and the
remaining work is a linked or plain todo.

The service-role client bypasses RLS, so every lookup is explicitly scoped by
``org_id`` (and by ``event_id`` where the table carries it).
"""

from __future__ import annotations

from fastapi import HTTPException

from services.org_scope import fetch_event
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

CANONICAL_TASKS: tuple[dict[str, object], ...] = (
    {
        "name": "Hotel stay requirement form",
        "description": "Tell us whether you need a hotel room and the dates of your stay.",
        "kind": "todo",
        "link_url": "/speaker/forms/hotel-stay",
    },
    {
        "name": "Flight reimbursement form",
        "description": "Share your itinerary and the details needed for flight reimbursement.",
        "kind": "todo",
        "link_url": "/speaker/forms/flight-reimbursement",
    },
    {
        "name": "Finalize talk description",
        "description": "Review and finalize the talk title and description attendees will see.",
        "kind": "todo",
        "link_url": None,
    },
    {
        "name": "Finalize bio/photos",
        "description": "Finalize your speaker bio and upload a high-resolution headshot.",
        "kind": "file_request",
        "link_url": None,
    },
    {
        "name": "Announce participation",
        "description": "Share that you're speaking using the event announcement kit.",
        "kind": "todo",
        "link_url": "/speaker/announcement-kit",
    },
    {
        "name": "Invite colleagues with speaker discount",
        "description": "Invite colleagues using your personal speaker discount link.",
        "kind": "todo",
        "link_url": "/speaker/discount",
    },
)


async def _default_speaker_portal(org_id: str, event_id: str) -> dict:
    portals = rows(
        await db(
            lambda: supabase.table("portals")
            .select("id, name")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "onboarding_portal_lookup",
        )
    )
    if portals:
        # Prefer the conventionally named portal, while still reusing an
        # organizer's existing event portal instead of creating a duplicate.
        return next(
            (portal for portal in portals if portal.get("name") == "Speakers"),
            portals[0],
        )

    portal = first(
        await db(
            lambda: supabase.table("portals")
            .insert(
                {
                    "org_id": org_id,
                    "event_id": event_id,
                    "name": "Speakers",
                    "filter": {"roles": ["speaker", "submitter"]},
                    "accent_color": "#4962E2",
                }
            )
            .execute(),
            "onboarding_portal_create",
        )
    )
    if not portal:
        raise HTTPException(status_code=500, detail="Could not create the speaker portal")
    return portal


async def ensure_event_onboarding_tasks(org_id: str, event_id: str) -> list[str]:
    """Ensure the six event-level tasks exist and return ids in canonical order.

    Idempotency is keyed by ``(event_id, name)`` as requested. Existing tasks
    retain organizer-authored descriptions and kinds; only a missing portal
    attachment is repaired.
    """
    await fetch_event(event_id, org_id)
    portal = await _default_speaker_portal(org_id, event_id)
    canonical_names = [str(task["name"]) for task in CANONICAL_TASKS]

    existing = rows(
        await db(
            lambda: supabase.table("tasks")
            .select("id, name, portal_id")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .in_("name", canonical_names)
            .execute(),
            "onboarding_tasks_lookup",
        )
    )
    by_name: dict[str, dict] = {}
    for task in existing:
        name = str(task.get("name") or "")
        if name in canonical_names and name not in by_name:
            by_name[name] = task

    unattached_ids = [
        str(task["id"])
        for task in by_name.values()
        if task.get("id") and not task.get("portal_id")
    ]
    if unattached_ids:
        await db(
            lambda: supabase.table("tasks")
            .update({"portal_id": portal["id"]})
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .in_("id", unattached_ids)
            .execute(),
            "onboarding_tasks_attach_portal",
        )

    missing = [task for task in CANONICAL_TASKS if str(task["name"]) not in by_name]
    if missing:
        records = [
            {
                "org_id": org_id,
                "event_id": event_id,
                "portal_id": portal["id"],
                "session_id": None,
                "name": task["name"],
                "description": task["description"],
                "kind": task["kind"],
                "link_url": task["link_url"],
                "required": True,
                "order": canonical_names.index(str(task["name"])) + 1,
            }
            for task in missing
        ]
        created = rows(
            await db(
                lambda: supabase.table("tasks").insert(records).execute(),
                "onboarding_tasks_create",
            )
        )
        for task in created:
            if task.get("name"):
                by_name[str(task["name"])] = task

    task_ids = [
        str(by_name[name]["id"])
        for name in canonical_names
        if name in by_name and by_name[name].get("id")
    ]
    if len(task_ids) != len(CANONICAL_TASKS):
        raise HTTPException(status_code=500, detail="Could not create speaker onboarding tasks")
    return task_ids


async def provision_speaker_onboarding(org_id: str, event_id: str, session_id: str) -> int:
    """Assign every canonical task to this session's speakers, idempotently.

    Explicit ``speaker`` participants win. If none exist yet (the normal state
    of a just-accepted CFP submission), its ``submitter`` participants are the
    speakers for onboarding. The session's submitter field is a final fallback
    for legacy rows created before participant records were required.

    Returns the number of new task assignments created by this call.
    """
    session = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id, event_id, submitter_contact_id")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .limit(1)
            .execute(),
            "onboarding_session_lookup",
        )
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("contact_id, role")
            .eq("org_id", org_id)
            .eq("session_id", session_id)
            .in_("role", ["speaker", "submitter"])
            .execute(),
            "onboarding_participants_lookup",
        )
    )
    speakers = [row for row in participants if row.get("role") == "speaker"]
    chosen = speakers or [row for row in participants if row.get("role") == "submitter"]
    contact_ids = list(
        dict.fromkeys(str(row["contact_id"]) for row in chosen if row.get("contact_id"))
    )
    if not contact_ids and session.get("submitter_contact_id"):
        contact_ids = [str(session["submitter_contact_id"])]
    if not contact_ids:
        return 0

    # Validate the participant hop too: a corrupt/cross-event FK must not turn
    # service-role access into a foreign task assignment.
    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select("id")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .in_("id", contact_ids)
            .execute(),
            "onboarding_contacts_lookup",
        )
    )
    contact_ids = [str(contact["id"]) for contact in contacts if contact.get("id")]
    if not contact_ids:
        return 0

    task_ids = await ensure_event_onboarding_tasks(org_id, event_id)
    existing = rows(
        await db(
            lambda: supabase.table("task_assignments")
            .select("task_id, contact_id")
            .eq("org_id", org_id)
            .in_("task_id", task_ids)
            .in_("contact_id", contact_ids)
            .execute(),
            "onboarding_assignments_lookup",
        )
    )
    existing_pairs = {
        (str(row.get("task_id") or ""), str(row.get("contact_id") or ""))
        for row in existing
    }
    missing = [
        {
            "org_id": org_id,
            "task_id": task_id,
            "contact_id": contact_id,
            "status": "todo",
        }
        for contact_id in contact_ids
        for task_id in task_ids
        if (task_id, contact_id) not in existing_pairs
    ]
    if missing:
        await db(
            lambda: supabase.table("task_assignments")
            .upsert(missing, on_conflict="task_id,contact_id")
            .execute(),
            "onboarding_assignments_create",
        )
    return len(missing)
