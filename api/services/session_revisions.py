"""Best-effort, org-scoped session title/description revision history."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import HTTPException

from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

REVISION_FIELDS = ("title", "description")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: object) -> str:
    return "" if value is None else str(value)


async def record_changes(
    org_id: str,
    session_id: str,
    before: dict,
    after: dict,
    *,
    actor: str,
) -> list[dict]:
    """Append one row per changed editable field without blocking the edit."""
    created_at = _now_iso()
    records = [
        {
            "org_id": org_id,
            "session_id": session_id,
            "field": field,
            "old_value": _text(before.get(field)),
            "new_value": _text(after.get(field)),
            "actor": actor,
            "created_at": created_at,
        }
        for field in REVISION_FIELDS
        if field in after and _text(before.get(field)) != _text(after.get(field))
    ]
    if not records:
        return []
    try:
        return rows(
            await db(
                lambda: supabase.table("session_revisions").insert(records).execute(),
                "session_revisions_insert",
            )
        )
    except Exception:
        logger.warning(
            "sessions: revision history unavailable; edit kept session_id=%s",
            session_id,
            exc_info=True,
        )
        return []


async def list_revisions(org_id: str, session_id: str) -> list[dict]:
    """Newest-first history, or an empty list before migration 013 is applied."""
    try:
        return rows(
            await db(
                lambda: supabase.table("session_revisions")
                .select("id, session_id, field, old_value, new_value, actor, created_at")
                .eq("org_id", org_id)
                .eq("session_id", session_id)
                .order("created_at", desc=True)
                .execute(),
                "session_revisions_list",
            )
        )
    except Exception:
        logger.warning(
            "sessions: revision history unavailable; returning empty session_id=%s",
            session_id,
            exc_info=True,
        )
        return []


async def restore_revision(
    org_id: str,
    session_id: str,
    revision_id: str,
    *,
    actor: str,
) -> dict:
    """Restore a revision's old value and record that restore as a new edit."""
    try:
        revision = first(
            await db(
                lambda: supabase.table("session_revisions")
                .select("id, org_id, session_id, field, old_value")
                .eq("id", revision_id)
                .eq("org_id", org_id)
                .eq("session_id", session_id)
                .limit(1)
                .execute(),
                "session_revision_restore_lookup",
            )
        )
    except Exception as exc:
        logger.warning(
            "sessions: revision history unavailable; restore skipped session_id=%s",
            session_id,
            exc_info=True,
        )
        raise HTTPException(status_code=404, detail="Revision not found") from exc

    field = (revision or {}).get("field")
    if not revision or field not in REVISION_FIELDS:
        raise HTTPException(status_code=404, detail="Revision not found")

    session = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id, title, description")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "session_revision_session_lookup",
        )
    )
    if not session or session.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail="Session not found")

    restored_value = _text(revision.get("old_value"))
    if field == "title" and not restored_value.strip():
        raise HTTPException(status_code=409, detail="This revision cannot restore an empty title")

    updated = first(
        await db(
            lambda: supabase.table("sessions")
            .update({field: restored_value, "updated_at": _now_iso()})
            .eq("id", session_id)
            .eq("org_id", org_id)
            .execute(),
            "session_revision_restore_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")

    await record_changes(
        org_id,
        session_id,
        session,
        {field: restored_value},
        actor=actor,
    )
    return updated
