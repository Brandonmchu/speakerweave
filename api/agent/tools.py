"""SpeakerWeave tool registry adapters and semantic tool observers."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urlsplit

from fastapi import HTTPException
from postgrest.exceptions import APIError

from agent.permissions import (
    denied_tool_result,
    permission_action_for_tool,
    request_permission,
    with_permission_guidance,
)
from services import assistant, content_pipeline, integration_api
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

ExternalToolHandler = Callable[[str, dict[str, Any]], Awaitable[Any]]

PLAIN_ROUTES = frozenset(
    {
        "/submissions",
        "/speakers",
        "/agenda",
        "/review",
        "/content",
        "/forms",
        "/comms",
        "/settings",
        "/dashboard",
        "/inbox",
        "/evaluation",
        "/pipeline",
    }
)

ROUTE_TABLE = {
    "event": "/settings",
    "submission": "/submissions?open=<id>",
    "speaker": "/speakers?person=<id>",
    "session": "/agenda?session=<id>",
    "form": "/forms/<id>",
    "content": "/content?item=<id>",
    "contact": "/speakers?person=<id>",
}

NEW_TOOLS: list[dict[str, Any]] = [
    {
        "name": "navigate_user_to_page",
        "description": (
            "Navigate the organizer's current browser to a known SpeakerWeave page. "
            "Use only when they explicitly ask to go, open, or show that page."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "route": {"type": "string"},
                "label": {"type": "string"},
            },
            "required": ["route", "label"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_forms",
        "description": "List CFP and speaker-portal forms, optionally for one event.",
        "input_schema": {
            "type": "object",
            "properties": {"event": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "get_form",
        "description": "Get one form's name, kind, settings, and event.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_content_items",
        "description": "List speaker content deliverables for an event.",
        "input_schema": {
            "type": "object",
            "properties": {
                "event": {"type": "string"},
                "status": {"type": "string"},
                "item_type": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_content_item",
        "description": "Get one content deliverable, its speaker, files, and comments.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "publish_schedule",
        "description": (
            "Publish an event's schedule and return its public program URL. "
            "Use only when the organizer asks to publish."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"event": {"type": "string"}},
            "additionalProperties": False,
        },
    },
]

# Keep the original registry as the source of truth. The dictionaries are reused,
# while this lane adds only the quarantined agent tools above.
BASE_TOOLS = assistant.TOOLS
TOOL_REGISTRY = [*BASE_TOOLS, *NEW_TOOLS]


@dataclass
class TurnContext:
    org_id: str
    user_id: str
    thread_id: str
    turn_id: str
    metadata: dict[str, Any]
    progress_queue: asyncio.Queue[dict[str, Any]]
    cancel_event: asyncio.Event
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    activity: list[dict[str, Any]] = field(default_factory=list)
    entity_keys: set[tuple[str, str, str]] = field(default_factory=set)
    producer_task: asyncio.Task[Any] | None = None


def registered_tools() -> list[dict[str, Any]]:
    return [with_permission_guidance(definition) for definition in TOOL_REGISTRY]


def is_valid_navigation_route(route: str) -> bool:
    if not route.startswith("/") or route.startswith("//"):
        return False
    parsed = urlsplit(route)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        return False
    if parsed.path in PLAIN_ROUTES and not parsed.query:
        return True
    query = parse_qs(parsed.query, keep_blank_values=True)
    if parsed.path == "/submissions":
        return set(query) == {"open"} and len(query["open"]) == 1 and bool(query["open"][0])
    if parsed.path == "/speakers":
        return set(query) == {"person"} and len(query["person"]) == 1 and bool(query["person"][0])
    if parsed.path == "/agenda":
        return set(query) == {"session"} and len(query["session"]) == 1 and bool(query["session"][0])
    if parsed.path == "/content":
        return set(query) == {"item"} and len(query["item"]) == 1 and bool(query["item"][0])
    return bool(re.fullmatch(r"/forms/[^/?#]+", parsed.path)) and not parsed.query


async def navigate_user_to_page(
    context: TurnContext, route: str, label: str
) -> dict[str, Any] | str:
    if not is_valid_navigation_route(route):
        return {
            "error": (
                f"Unknown SpeakerWeave route '{route}'. Use one of the documented "
                f"routes: {', '.join(sorted(PLAIN_ROUTES))}, or a supported entity route."
            )
        }
    clean_label = label.strip() or "that page"
    await context.progress_queue.put(
        {"type": "navigate", "route": route, "label": clean_label}
    )
    return f"Navigated user to {clean_label}"


async def _list_forms(org_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    event_id = None
    if arguments.get("event"):
        event = await integration_api.resolve_event(org_id, str(arguments["event"]))
        event_id = str(event["id"])

    def query():
        request = supabase.table("forms").select(
            "id, org_id, event_id, name, slug, kind, settings, created_at"
        ).eq("org_id", org_id)
        if event_id:
            request = request.eq("event_id", event_id)
        return request.order("created_at", desc=True).limit(100).execute()

    return {"data": rows(await db(query, "agent_list_forms"))}


async def _get_form(org_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    row = first(
        await db(
            lambda: supabase.table("forms")
            .select("id, org_id, event_id, name, slug, kind, settings, created_at")
            .eq("id", str(arguments["id"]))
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "agent_get_form",
        )
    )
    if not row or row.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail="Form not found")
    return {"data": row}


async def _list_content_items(
    org_id: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    event = await integration_api.resolve_event(org_id, arguments.get("event"))
    return await integration_api.list_content_items(
        org_id,
        str(event["id"]),
        status=arguments.get("status"),
        item_type=arguments.get("item_type"),
        page=1,
        page_size=integration_api.MAX_PAGE_SIZE,
    )


async def _get_content_item(
    org_id: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    return {"data": await content_pipeline.content_item(org_id, str(arguments["id"]))}


async def _publish_schedule(
    org_id: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    event = await integration_api.resolve_event(org_id, arguments.get("event"))
    published_at = datetime.now(timezone.utc).isoformat()
    try:
        updated = first(
            await db(
                lambda: supabase.table("events")
                .update({"program_published_at": published_at})
                .eq("id", str(event["id"]))
                .eq("org_id", org_id)
                .execute(),
                "agent_publish_schedule",
            )
        )
        if updated and updated.get("program_published_at"):
            published_at = str(updated["program_published_at"])
    except APIError:
        # Preserve the existing schedule endpoint's best-effort timestamp
        # semantics when an adopter has not applied migration 005 yet.
        pass
    slug = event.get("slug")
    return {
        "data": {
            "id": event.get("id"),
            "name": event.get("name"),
            "slug": slug,
            "published_at": published_at,
            "public_url": f"/e/{slug}/schedule" if slug else None,
        }
    }


LOCAL_TOOL_HANDLERS: dict[
    str, Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
] = {
    "list_forms": _list_forms,
    "get_form": _get_form,
    "list_content_items": _list_content_items,
    "get_content_item": _get_content_item,
    "publish_schedule": _publish_schedule,
}


_TOOL_MESSAGES: dict[str, tuple[str, str]] = {
    "list_submissions": ("Working with list_submissions", "Looking at submissions…"),
    "get_submission": ("Working with get_submission", "Opening the submission…"),
    "list_speakers": ("Working with list_speakers", "Looking at speakers…"),
    "schedule_summary": ("Working with schedule_summary", "Reviewing the agenda…"),
    "content_status": ("Working with content_status", "Checking content status…"),
    "decide_submission": (
        "Working with decide_submission",
        "Drafting the submission decision…",
    ),
    "navigate_user_to_page": (
        "Working with navigate_user_to_page",
        "Opening that page…",
    ),
    "list_forms": ("Working with list_forms", "Looking at forms…"),
    "get_form": ("Working with get_form", "Opening the form…"),
    "list_content_items": (
        "Working with list_content_items",
        "Looking at content deliverables…",
    ),
    "get_content_item": (
        "Working with get_content_item",
        "Opening the content item…",
    ),
    "publish_schedule": (
        "Working with publish_schedule",
        "Preparing the schedule to publish…",
    ),
}


def tool_messages(tool_name: str) -> tuple[str, str]:
    return _TOOL_MESSAGES.get(
        tool_name,
        (f"Working with {tool_name}", "Working on that…"),
    )


def _json_result(result: Any) -> str:
    if isinstance(result, str):
        return result
    return json.dumps(result, default=str, ensure_ascii=False, separators=(",", ":"))


def _successful(result: Any) -> bool:
    if isinstance(result, dict):
        return not result.get("error")
    if isinstance(result, str):
        try:
            decoded = json.loads(result)
        except ValueError:
            return True
        return not (isinstance(decoded, dict) and decoded.get("error"))
    return True


def _submission_entity(
    arguments: dict[str, Any], result: Any
) -> dict[str, Any] | None:
    data = result.get("data") if isinstance(result, dict) else None
    data = data if isinstance(data, dict) else {}
    entity_id = str(data.get("id") or arguments.get("id") or "")
    if not entity_id:
        return None
    friendly = str(data.get("friendly_id") or "")
    title = str(data.get("title") or "")
    display = " — ".join(part for part in (friendly, title) if part) or entity_id
    return {
        "entity_type": "submission",
        "entity_id": entity_id,
        "change_type": "updated",
        "display": display,
    }


def _event_entity(
    arguments: dict[str, Any], result: Any
) -> dict[str, Any] | None:
    data = result.get("data") if isinstance(result, dict) else None
    data = data if isinstance(data, dict) else {}
    entity_id = str(data.get("id") or arguments.get("event") or "")
    if not entity_id:
        return None
    return {
        "entity_type": "event",
        "entity_id": entity_id,
        "change_type": "updated",
        "display": str(data.get("name") or "Event schedule"),
    }


_ENTITY_TOOL_SPECS: dict[
    str, Callable[[dict[str, Any], Any], dict[str, Any] | None]
] = {
    "decide_submission": _submission_entity,
    "publish_schedule": _event_entity,
}


async def _emit_entity_update(
    context: TurnContext,
    tool_name: str,
    arguments: dict[str, Any],
    result: Any,
) -> None:
    extractor = _ENTITY_TOOL_SPECS.get(tool_name)
    if not extractor or not _successful(result):
        return
    event = extractor(arguments, result)
    if not event:
        return
    key = (
        str(event["entity_type"]),
        str(event["entity_id"]),
        str(event["change_type"]),
    )
    if key in context.entity_keys:
        return
    context.entity_keys.add(key)
    context.activity.append(dict(event))
    await context.progress_queue.put({"type": "entity_update", **event})


async def invoke_tool(
    context: TurnContext,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    external_handler: ExternalToolHandler | None = None,
) -> str:
    """Permission gate -> org-scoped handler -> observer/audit events."""
    clean_arguments = dict(arguments)
    if permission_action_for_tool(tool_name):
        approved, clean_arguments = await request_permission(
            org_id=context.org_id,
            user_id=context.user_id,
            thread_id=context.thread_id,
            turn_id=context.turn_id,
            tool_name=tool_name,
            tool_input=clean_arguments,
            progress_queue=context.progress_queue,
        )
        if not approved:
            result_text = denied_tool_result(tool_name)
            context.tool_calls.append(
                {
                    "function_name": tool_name,
                    "input": clean_arguments,
                    "result": result_text[:4000],
                }
            )
            return result_text

    reasoning, progress = tool_messages(tool_name)
    await context.progress_queue.put({"type": "reasoning", "message": reasoning})
    await context.progress_queue.put({"type": "progress", "message": progress})

    try:
        if tool_name == "navigate_user_to_page":
            result: Any = await navigate_user_to_page(
                context,
                str(clean_arguments.get("route") or ""),
                str(clean_arguments.get("label") or ""),
            )
        elif tool_name in LOCAL_TOOL_HANDLERS:
            result = await LOCAL_TOOL_HANDLERS[tool_name](context.org_id, clean_arguments)
        elif tool_name.startswith("every_") and external_handler is not None:
            result = await external_handler(tool_name.removeprefix("every_"), clean_arguments)
        else:
            result = await assistant.run_tool(context.org_id, tool_name, clean_arguments)
    except HTTPException as exc:
        result = {"error": str(exc.detail), "status": exc.status_code}
    except (KeyError, TypeError, ValueError) as exc:
        result = {"error": f"Invalid arguments for {tool_name}: {exc}"}

    result_text = _json_result(result)
    context.tool_calls.append(
        {
            "function_name": tool_name,
            "input": clean_arguments,
            "result": result_text[:4000],
        }
    )
    if _successful(result):
        await _emit_entity_update(context, tool_name, clean_arguments, result)
        await context.progress_queue.put(
            {"type": "reasoning", "message": f"Finished {tool_name}"}
        )
    else:
        await context.progress_queue.put(
            {"type": "reasoning", "message": f"{tool_name} returned an error"}
        )
    return result_text
