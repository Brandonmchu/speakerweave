"""Organization-scoped thread and message persistence."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from auth import verify_org_access
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

DEFAULT_THREAD_NAME = "Chat"
HISTORY_LIMIT = 40
THREAD_LIST_LIMIT = 50

THREAD_COLUMNS = "id, org_id, user_id, name, status, visibility, last_message_at, created_at"
MESSAGE_COLUMNS = (
    "id, thread_id, org_id, user_id, sender_type, content, metadata, "
    "response_type, turn_id, created_at, reasoning_context"
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return utc_now().isoformat()


def _thread_public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "name": row.get("name") or DEFAULT_THREAD_NAME,
        "status": row.get("status") or "active",
        "last_message_at": row.get("last_message_at"),
        "created_at": row.get("created_at"),
    }


async def create_thread(org_id: str, user_id: str) -> dict[str, Any]:
    now = _iso_now()
    record = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "user_id": user_id,
        "name": DEFAULT_THREAD_NAME,
        "status": "active",
        "visibility": "org",
        "last_message_at": now,
        "created_at": now,
        "updated_at": now,
    }
    created = first(
        await db(
            lambda: supabase.table("agent_threads").insert(record).execute(),
            "agent_thread_create",
        )
    )
    if not created:
        raise RuntimeError("Could not create agent thread")
    return _thread_public(created)


async def fetch_thread(thread_id: str, org_id: str) -> dict[str, Any]:
    row = first(
        await db(
            lambda: supabase.table("agent_threads")
            .select(THREAD_COLUMNS)
            .eq("id", thread_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "agent_thread_fetch",
        )
    )
    return verify_org_access(row, org_id, "Thread")


async def list_threads(org_id: str) -> list[dict[str, Any]]:
    result = await db(
        lambda: supabase.table("agent_threads")
        .select(THREAD_COLUMNS)
        .eq("org_id", org_id)
        .order("last_message_at", desc=True)
        .order("id", desc=True)
        .limit(THREAD_LIST_LIMIT)
        .execute(),
        "agent_threads_list",
    )
    found = rows(result)
    found.sort(
        key=lambda row: (str(row.get("last_message_at") or ""), str(row.get("id") or "")),
        reverse=True,
    )
    return [_thread_public(row) for row in found[:THREAD_LIST_LIMIT]]


async def rename_thread(thread_id: str, org_id: str, name: str) -> dict[str, Any]:
    await fetch_thread(thread_id, org_id)
    updated = first(
        await db(
            lambda: supabase.table("agent_threads")
            .update({"name": name, "updated_at": _iso_now()})
            .eq("id", thread_id)
            .eq("org_id", org_id)
            .execute(),
            "agent_thread_rename",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Thread not found")
    return _thread_public(updated)


async def delete_thread(thread_id: str, org_id: str) -> None:
    await fetch_thread(thread_id, org_id)
    await db(
        lambda: supabase.table("agent_messages")
        .delete()
        .eq("thread_id", thread_id)
        .eq("org_id", org_id)
        .execute(),
        "agent_thread_messages_delete",
    )
    deleted = first(
        await db(
            lambda: supabase.table("agent_threads")
            .delete()
            .eq("id", thread_id)
            .eq("org_id", org_id)
            .execute(),
            "agent_thread_delete",
        )
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Thread not found")


async def list_messages(
    thread_id: str,
    org_id: str,
    *,
    limit: int,
    offset: int,
) -> tuple[list[dict[str, Any]], bool]:
    await fetch_thread(thread_id, org_id)
    result = await db(
        lambda: supabase.table("agent_messages")
        .select(MESSAGE_COLUMNS)
        .eq("thread_id", thread_id)
        .eq("org_id", org_id)
        .order("created_at", desc=True)
        .order("id", desc=True)
        .range(offset, offset + limit)
        .execute(),
        "agent_messages_list",
    )
    newest_first = rows(result)
    newest_first.sort(
        key=lambda row: (str(row.get("created_at") or ""), str(row.get("id") or "")),
        reverse=True,
    )
    page = newest_first[:limit]
    return list(reversed(page)), len(newest_first) > limit


async def load_history(thread_id: str, org_id: str) -> list[dict[str, str]]:
    """Load the newest bounded page, then restore chronological prompt order."""
    result = await db(
        lambda: supabase.table("agent_messages")
        .select("id, sender_type, content, created_at")
        .eq("thread_id", thread_id)
        .eq("org_id", org_id)
        .order("created_at", desc=True)
        .order("id", desc=True)
        .limit(HISTORY_LIMIT)
        .execute(),
        "agent_history_load",
    )
    newest_first = rows(result)
    newest_first.sort(
        key=lambda row: (str(row.get("created_at") or ""), str(row.get("id") or "")),
        reverse=True,
    )
    history: list[dict[str, str]] = []
    for row in reversed(newest_first[:HISTORY_LIMIT]):
        sender = str(row.get("sender_type") or "")
        role = "assistant" if sender == "agent" else sender
        if role not in {"user", "assistant", "system"}:
            continue
        history.append({"role": role, "content": str(row.get("content") or "")})
    return history


def format_history(history: list[dict[str, str]], user_message: str) -> str:
    lines = ["<conversation_history>"]
    for message in history:
        lines.append(
            f'<message role="{message["role"]}">{message["content"]}</message>'
        )
    lines.append("</conversation_history>")
    return f"{'\n'.join(lines)}\n\n{user_message}"


async def persist_user_message(
    *,
    thread_id: str,
    org_id: str,
    user_id: str,
    turn_id: str,
    content: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    now = _iso_now()
    record = {
        "id": str(uuid.uuid4()),
        "thread_id": thread_id,
        "org_id": org_id,
        "user_id": user_id,
        "sender_type": "user",
        "content": content,
        "metadata": {**metadata, "turn_started_at": now},
        "response_type": "completion",
        "turn_id": turn_id,
        "reasoning_context": {},
        "created_at": now,
    }
    created = first(
        await db(
            lambda: supabase.table("agent_messages").insert(record).execute(),
            "agent_user_message_insert",
        )
    )
    if not created:
        raise RuntimeError("Could not persist user message")
    await _touch_thread(thread_id, org_id, now)
    return created


async def persist_agent_message(
    *,
    thread_id: str,
    org_id: str,
    turn_id: str,
    content: str,
    metadata: dict[str, Any],
    reasoning_context: dict[str, Any],
    response_type: str = "completion",
) -> dict[str, Any]:
    now = _iso_now()
    record = {
        "id": str(uuid.uuid4()),
        "thread_id": thread_id,
        "org_id": org_id,
        "user_id": None,
        "sender_type": "agent",
        "content": content,
        "metadata": {**metadata, "turn_completed_at": now},
        "response_type": response_type,
        "turn_id": turn_id,
        "reasoning_context": reasoning_context,
        "created_at": now,
    }
    created = first(
        await db(
            lambda: supabase.table("agent_messages").insert(record).execute(),
            "agent_reply_insert",
        )
    )
    if not created:
        raise RuntimeError("Could not persist agent message")
    await _touch_thread(thread_id, org_id, now)
    return created


async def _touch_thread(thread_id: str, org_id: str, timestamp: str) -> None:
    try:
        await db(
            lambda: supabase.table("agent_threads")
            .update({"last_message_at": timestamp, "updated_at": timestamp})
            .eq("id", thread_id)
            .eq("org_id", org_id)
            .execute(),
            "agent_thread_touch",
        )
    except Exception:
        logger.warning("Could not update agent thread timestamp", exc_info=True)


async def current_event_context(org_id: str) -> dict[str, Any] | None:
    result = await db(
        lambda: supabase.table("events")
        .select("id, org_id, name, starts_at, ends_at, timezone")
        .eq("org_id", org_id)
        .order("starts_at", desc=True)
        .limit(1)
        .execute(),
        "agent_current_event",
    )
    return first(result)
