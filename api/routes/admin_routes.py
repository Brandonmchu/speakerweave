"""Organizer surface. Every query carries the JWT-derived org predicate —
the service-role client bypasses RLS, so a missing predicate is a cross-org
leak, not a bug you notice in testing.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import get_current_user_and_org, verify_org_access
from services.invites import (
    InviteTargetNotFound,
    SessionNotScheduled,
    cancel_session_invites,
    send_session_invites,
)
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


class SessionPatchRequest(BaseModel):
    status: str


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

    for session in sessions:
        session["submitter"] = contacts_by_id.get(session.get("submitter_contact_id"))

    return {"event": event, "submissions": sessions, "count": len(sessions)}


@router.patch("/sessions/{session_id}")
async def update_session(
    session_id: str,
    payload: SessionPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Move a session between status tabs (accept/decline queues)."""
    _user_id, org_id = auth
    if payload.status not in SESSION_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown status '{payload.status}'")

    existing = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "session_lookup",
        )
    )
    verify_org_access(existing, org_id, "Session")

    updated = first(
        await db(
            lambda: supabase.table("sessions")
            .update(
                {
                    "status": payload.status,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("id", session_id)
            .eq("org_id", org_id)
            .execute(),
            "session_update_status",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session": updated}


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
