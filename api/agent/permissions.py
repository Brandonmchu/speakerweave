"""Interactive approval policy and in-memory pending-request registry."""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from services.speaker_crm import full_name
from services.supabase_helpers import db, first
from supabase_client import supabase

PERMISSION_APPROVAL_TIMEOUT_SECONDS = 180.0

INTERACTIVE_APPROVAL_TOOL_GUIDANCE = (
    " This action uses SpeakerWeave's interactive Approve/Deny card. Call the tool "
    "when the user asks for the action; never ask them to type a confirmation."
)

PERMISSION_REQUIRED_TOOLS: dict[str, str] = {
    "decide_submission": "DECIDE_SUBMISSION",
    "publish_schedule": "PUBLISH_SCHEDULE",
    "set_event_branding": "UPDATE_BRANDING",
    "queue_portal_invite": "SEND_EMAIL",
    "invite_speaker_to_portal": "SEND_EMAIL",
    "remind_outstanding_content": "SEND_EMAIL",
    "send_communication": "SEND_EMAIL",
    "send_session_invites": "SEND_EMAIL",
}

_EXTERNAL_READ_PREFIXES = (
    "list_",
    "get_",
    "view_",
    "search_",
    "read_",
    "find_",
)


@dataclass
class PendingPermission:
    request_id: str
    org_id: str
    user_id: str
    thread_id: str
    turn_id: str
    tool_name: str
    description: str
    tool_input: dict[str, Any]
    expires_at: datetime
    future: asyncio.Future[bool]

    def public(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "tool_name": self.tool_name,
            "description": self.description,
            "tool_input": self.tool_input,
            "expires_at": self.expires_at.isoformat(),
        }


_PENDING: dict[str, PendingPermission] = {}
_PENDING_LOCK = asyncio.Lock()


def permission_action_for_tool(tool_name: str) -> str | None:
    action = PERMISSION_REQUIRED_TOOLS.get(tool_name)
    if action:
        return action
    normalized = tool_name.casefold()
    if normalized.startswith("delete_") or "_delete_" in normalized:
        return "DELETE"
    if "email" in normalized and (
        normalized.startswith(("send_", "queue_")) or "_send_" in normalized
    ):
        return "SEND_EMAIL"
    if normalized.startswith("mcp__") and "__" in normalized.removeprefix("mcp__"):
        external_name = normalized.split("__", 2)[-1]
        if not external_name.startswith(_EXTERNAL_READ_PREFIXES):
            return "EXTERNAL_MCP_ACTION"
    return None


def with_permission_guidance(definition: dict[str, Any]) -> dict[str, Any]:
    if not permission_action_for_tool(str(definition.get("name") or "")):
        return definition
    return {
        **definition,
        "description": (
            str(definition.get("description") or "")
            + INTERACTIVE_APPROVAL_TOOL_GUIDANCE
        ),
    }


def strip_display_fields(tool_input: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in tool_input.items() if not key.startswith("_")}


async def _resolve_submission_label(
    org_id: str, tool_input: dict[str, Any]
) -> dict[str, Any]:
    submission_id = str(tool_input.get("id") or "")
    if not submission_id:
        return tool_input
    row = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id, friendly_id, title")
            .eq("id", submission_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "agent_permission_submission_label",
        )
    )
    if not row:
        return tool_input
    display = " — ".join(
        part for part in (str(row.get("friendly_id") or ""), str(row.get("title") or "")) if part
    )
    return {**tool_input, "_submission_display": display or submission_id}


async def _resolve_person_label(
    org_id: str, tool_input: dict[str, Any]
) -> dict[str, Any]:
    person_id = str(tool_input.get("person_id") or tool_input.get("contact_id") or "")
    if not person_id:
        return tool_input
    row = first(
        await db(
            lambda: supabase.table("directory_people")
            .select("id, org_id, first_name, last_name, email")
            .eq("id", person_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "agent_permission_person_label",
        )
    )
    if not row:
        return tool_input
    return {
        **tool_input,
        "_person_display": full_name(
            row.get("first_name"), row.get("last_name"), row.get("email")
        ),
    }


async def resolve_display_fields(
    org_id: str,
    tool_name: str,
    tool_input: dict[str, Any],
) -> dict[str, Any]:
    if tool_name == "decide_submission":
        return await _resolve_submission_label(org_id, tool_input)
    if any(key in tool_input for key in ("person_id", "contact_id")):
        return await _resolve_person_label(org_id, tool_input)
    if "speaker_id" in tool_input:
        return await _resolve_speaker_label(org_id, tool_input)
    return dict(tool_input)


async def _resolve_speaker_label(
    org_id: str, tool_input: dict[str, Any]
) -> dict[str, Any]:
    speaker_id = str(tool_input.get("speaker_id") or "")
    if not speaker_id:
        return dict(tool_input)
    row = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id, org_id, first_name, last_name, email")
            .eq("id", speaker_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "agent_permission_speaker_label",
        )
    )
    if not row:
        return dict(tool_input)
    name = " ".join(
        part for part in (row.get("first_name"), row.get("last_name")) if part
    ).strip()
    return {
        **tool_input,
        "_person_display": name or row.get("email") or speaker_id,
    }


def permission_description(
    action: str, tool_name: str, tool_input: dict[str, Any]
) -> str:
    if action == "DECIDE_SUBMISSION":
        display = tool_input.get("_submission_display") or tool_input.get("id")
        decision = str(tool_input.get("decision") or "change the decision for")
        return f"{decision.title()} {display}?"
    if action == "PUBLISH_SCHEDULE":
        return "Publish this event's schedule?"
    if action == "UPDATE_BRANDING":
        return "Update this event's branding?"
    if action == "SEND_EMAIL":
        if tool_name == "remind_outstanding_content":
            return "Queue reminder emails to every speaker with outstanding content?"
        if tool_name == "invite_speaker_to_portal":
            display = tool_input.get("_person_display") or "this speaker"
            return f"Queue a portal invitation email for {display}?"
        display = tool_input.get("_person_display")
        return f"Send or queue this email{f' for {display}' if display else ''}?"
    if action == "DELETE":
        return f"Delete the item requested by {tool_name}?"
    if action == "EXTERNAL_MCP_ACTION":
        connector = str(tool_input.get("_connector_name") or tool_name.split("__", 2)[1])
        external_name = tool_name.split("__", 2)[-1]
        return f"Allow {connector} to run {external_name}?"
    return f"Allow {tool_name}?"


async def request_permission(
    *,
    org_id: str,
    user_id: str,
    thread_id: str,
    turn_id: str,
    tool_name: str,
    tool_input: dict[str, Any],
    progress_queue: asyncio.Queue[dict[str, Any]],
    timeout_seconds: float | None = None,
    context: Any | None = None,
) -> tuple[bool, dict[str, Any]]:
    """Emit an approval card and wait once for approval, denial, or expiry."""
    action = permission_action_for_tool(tool_name)
    if not action:
        return True, strip_display_fields(tool_input)

    if timeout_seconds is None:
        configured_timeout = (
            context.metadata.get("permission_timeout_seconds")
            if context is not None
            else None
        )
        try:
            timeout_seconds = float(configured_timeout)
        except (TypeError, ValueError):
            timeout_seconds = PERMISSION_APPROVAL_TIMEOUT_SECONDS

    resolved_input = await resolve_display_fields(org_id, tool_name, tool_input)
    request_id = str(uuid.uuid4())
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
    future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
    pending = PendingPermission(
        request_id=request_id,
        org_id=org_id,
        user_id=user_id,
        thread_id=thread_id,
        turn_id=turn_id,
        tool_name=tool_name,
        description=permission_description(action, tool_name, resolved_input),
        tool_input=resolved_input,
        expires_at=expires_at,
        future=future,
    )
    async with _PENDING_LOCK:
        _PENDING[request_id] = pending

    await progress_queue.put({"type": "permission_request", **pending.public()})
    approved = False
    try:
        approved = await asyncio.wait_for(asyncio.shield(future), timeout_seconds)
    except TimeoutError:
        approved = False
    finally:
        async with _PENDING_LOCK:
            _PENDING.pop(request_id, None)
        if not future.done():
            future.cancel()

    await progress_queue.put(
        {
            "type": "permission_resolved",
            "request_id": request_id,
            "approved": bool(approved),
        }
    )
    return bool(approved), strip_display_fields(resolved_input)


async def resolve_permission(request_id: str, org_id: str, approved: bool) -> bool:
    async with _PENDING_LOCK:
        pending = _PENDING.get(request_id)
        if not pending or pending.org_id != org_id:
            return False
        if pending.expires_at <= datetime.now(timezone.utc):
            _PENDING.pop(request_id, None)
            return False
        if not pending.future.done():
            pending.future.set_result(bool(approved))
        return True


async def pending_for_thread(thread_id: str, org_id: str) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    async with _PENDING_LOCK:
        expired = [
            request_id
            for request_id, pending in _PENDING.items()
            if pending.expires_at <= now
        ]
        for request_id in expired:
            pending = _PENDING.pop(request_id)
            if not pending.future.done():
                pending.future.set_result(False)
        found = [
            pending.public()
            for pending in _PENDING.values()
            if pending.thread_id == thread_id and pending.org_id == org_id
        ]
    found.sort(key=lambda item: str(item["expires_at"]), reverse=True)
    return found


async def deny_pending_for_turn(thread_id: str, turn_id: str) -> None:
    async with _PENDING_LOCK:
        matching = [
            pending
            for pending in _PENDING.values()
            if pending.thread_id == thread_id and pending.turn_id == turn_id
        ]
        for pending in matching:
            if not pending.future.done():
                pending.future.set_result(False)


def denied_tool_result(tool_name: str) -> str:
    return json.dumps(
        {
            "error": f"Permission to run {tool_name} was denied or expired.",
            "denied": True,
        },
        separators=(",", ":"),
    )
