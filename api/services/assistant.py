"""Shared conference-assistant engine for the organizer app and Slack.

The model can only reach conference data through :mod:`services.integration_api`.
Every tool dispatch receives the organization id resolved by its transport
boundary; no tool accepts an organization id from model-generated arguments.
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from services import integration_api

logger = logging.getLogger(__name__)

MODEL = "claude-haiku-4-5"
MAX_OUTPUT_TOKENS = 1600
MAX_TOOL_ROUNDS = 5

TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_submissions",
        "description": "List conference submissions, optionally filtered by event, status, or track.",
        "input_schema": {
            "type": "object",
            "properties": {
                "event": {"type": "string"},
                "status": {"type": "string"},
                "track": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_submission",
        "description": "Get one submission and its speaker, track, format, and schedule details.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_speakers",
        "description": "List or search speakers, optionally within one event.",
        "input_schema": {
            "type": "object",
            "properties": {
                "event": {"type": "string"},
                "filter": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "schedule_summary",
        "description": "Summarize scheduled and unscheduled sessions for an event.",
        "input_schema": {
            "type": "object",
            "properties": {"event": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "content_status",
        "description": "Show content deliverable counts and outstanding speakers for an event.",
        "input_schema": {
            "type": "object",
            "properties": {"event": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "decide_submission",
        "description": "Accept, decline, or queue a submission and optionally record feedback.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "decision": {
                    "type": "string",
                    "enum": ["accept", "maybe", "decline"],
                },
                "feedback": {"type": "string"},
            },
            "required": ["id", "decision"],
            "additionalProperties": False,
        },
    },
]

WEB_SYSTEM_PROMPT = (
    "You are Ask SpeakerWeave, a concise conference operations assistant inside the "
    "organizer app. Use the supplied tools for factual questions; never invent "
    "conference data. Only use decide_submission when the organizer's latest message "
    "explicitly asks you to accept, decline, or queue a submission. Human decisions "
    "remain authoritative. Give practical, concise answers in standard Markdown with "
    "short paragraphs and lists where useful."
)
WEB_NO_KEY_REPLY = (
    "Ask SpeakerWeave isn't available yet because ANTHROPIC_API_KEY is not configured. "
    "Ask an administrator to add it, then try again."
)
MODEL_FAILURE_REPLY = (
    "I couldn't reach the conference assistant just now. Please try again in a moment."
)
TOOL_LIMIT_REPLY = (
    "I reached the tool-use limit before I could finish that request. "
    "Try asking for a smaller slice of the conference data."
)

ModelCall = Callable[..., Awaitable[Any]]
ToolExecutor = Callable[[str, str, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class AssistantResult:
    reply: str
    tool_calls: list[dict[str, str]]


async def _call_anthropic(
    messages: list[dict[str, Any]],
    *,
    key: str,
    system_prompt: str,
) -> Any:
    """Run one model turn. Tests patch this boundary and never use the network."""
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=key)
    return await client.messages.create(
        model=MODEL,
        max_tokens=MAX_OUTPUT_TOKENS,
        system=system_prompt,
        tools=TOOLS,
        messages=messages,
    )


def _value(block: Any, name: str, default: Any = None) -> Any:
    if isinstance(block, dict):
        return block.get(name, default)
    return getattr(block, name, default)


def _serializable_block(block: Any) -> dict[str, Any]:
    block_type = _value(block, "type", "")
    if block_type == "text":
        return {"type": "text", "text": str(_value(block, "text", ""))}
    if block_type == "tool_use":
        return {
            "type": "tool_use",
            "id": str(_value(block, "id", "")),
            "name": str(_value(block, "name", "")),
            "input": _value(block, "input", {}) or {},
        }
    return {"type": str(block_type)}


async def _event_id(org_id: str, reference: str | None) -> str:
    event = await integration_api.resolve_event(org_id, reference)
    return str(event["id"])


async def run_tool(org_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Dispatch only to the org-scoped service layer shared with MCP."""
    try:
        if name == "list_submissions":
            event_id = (
                await _event_id(org_id, arguments.get("event"))
                if arguments.get("event")
                else None
            )
            return await integration_api.list_submissions(
                org_id,
                event_id=event_id,
                status=arguments.get("status"),
                track=arguments.get("track"),
                page=1,
                page_size=integration_api.MAX_PAGE_SIZE,
            )
        if name == "get_submission":
            return {"data": await integration_api.get_submission(org_id, str(arguments["id"]))}
        if name == "list_speakers":
            event_id = (
                await _event_id(org_id, arguments.get("event"))
                if arguments.get("event")
                else None
            )
            return await integration_api.list_speakers(
                org_id,
                event_id=event_id,
                filter_text=arguments.get("filter"),
                page=1,
                page_size=integration_api.MAX_PAGE_SIZE,
            )
        if name == "schedule_summary":
            event_id = await _event_id(org_id, arguments.get("event"))
            schedule = await integration_api.list_schedule(org_id, event_id)
            sessions = schedule.get("sessions") or []
            scheduled = [item for item in sessions if item.get("starts_at")]
            return {
                "event": schedule.get("event"),
                "scheduled": len(scheduled),
                "unscheduled": len(sessions) - len(scheduled),
                "rooms": len(schedule.get("rooms") or []),
                "sessions": sessions,
            }
        if name == "content_status":
            event_id = await _event_id(org_id, arguments.get("event"))
            return {"data": await integration_api.content_status(org_id, event_id)}
        if name == "decide_submission":
            return {
                "data": await integration_api.decide_submission(
                    org_id,
                    str(arguments["id"]),
                    str(arguments["decision"]),
                    arguments.get("feedback"),
                )
            }
        return {"error": f"Unknown tool: {name}"}
    except HTTPException as exc:
        return {"error": str(exc.detail), "status": exc.status_code}
    except (KeyError, TypeError, ValueError) as exc:
        return {"error": f"Invalid arguments for {name}: {exc}"}


_DIRECT_DECISION_PATTERNS = (
    re.compile(r"^\s*(?:please\s+)?(?:accept|approve|decline|reject|queue)\b", re.IGNORECASE),
    re.compile(
        r"\b(?:can|could|would|will)\s+you\s+(?:please\s+)?"
        r"(?:accept|approve|decline|reject|queue)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:please|kindly|go ahead and)\s+(?:accept|approve|decline|reject|queue)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:i|we)(?:'d|\s+would)?\s+(?:like|want)\s+(?:you\s+to\s+)?"
        r"(?:accept|approve|decline|reject|queue)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:mark|move|set|put)\b.{0,60}\b"
        r"(?:accepted|declined|accept queue|decline queue|maybe queue|in the queue)\b",
        re.IGNORECASE,
    ),
)


def _latest_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user" and isinstance(message.get("content"), str):
            return str(message["content"])
    return ""


def explicitly_requests_decision(messages: list[dict[str, Any]]) -> bool:
    """Defense in depth for the one mutating tool, independent of the prompt."""
    text = _latest_user_text(messages)
    return any(pattern.search(text) for pattern in _DIRECT_DECISION_PATTERNS)


def summarize_arguments(arguments: dict[str, Any]) -> str:
    """Make a compact, one-line audit summary suitable for an organizer UI."""
    if not arguments:
        return "No arguments"
    parts: list[str] = []
    for key, value in sorted(arguments.items()):
        rendered = json.dumps(value, default=str, ensure_ascii=False, separators=(",", ":"))
        rendered = " ".join(rendered.split())
        if len(rendered) > 72:
            rendered = f"{rendered[:69]}..."
        parts.append(f"{key}={rendered}")
    summary = ", ".join(parts)
    return summary if len(summary) <= 180 else f"{summary[:177]}..."


async def run(
    messages: list[dict[str, Any]],
    org_id: str,
    *,
    system_prompt: str = WEB_SYSTEM_PROMPT,
    no_key_reply: str = WEB_NO_KEY_REPLY,
    model_call: ModelCall | None = None,
    tool_executor: ToolExecutor | None = None,
    log_context: str = "in-app assistant",
) -> AssistantResult:
    """Run the bounded model/tool loop over caller-managed chat history."""
    key = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
    if not key:
        return AssistantResult(reply=no_key_reply, tool_calls=[])

    conversation = [dict(message) for message in messages]
    decision_allowed = explicitly_requests_decision(conversation)
    audits: list[dict[str, str]] = []
    execute = tool_executor or run_tool
    tool_rounds = 0

    try:
        while True:
            if model_call is None:
                response = await _call_anthropic(
                    conversation,
                    key=key,
                    system_prompt=system_prompt,
                )
            else:
                response = await model_call(conversation, key=key)

            blocks = list(_value(response, "content", []) or [])
            text_parts = [
                str(_value(block, "text", "")).strip()
                for block in blocks
                if _value(block, "type") == "text"
                and str(_value(block, "text", "")).strip()
            ]
            tool_uses = [block for block in blocks if _value(block, "type") == "tool_use"]
            if not tool_uses:
                reply = "\n".join(text_parts).strip() or MODEL_FAILURE_REPLY
                return AssistantResult(reply=reply, tool_calls=audits)
            if tool_rounds >= MAX_TOOL_ROUNDS:
                reply = "\n".join(text_parts).strip() or TOOL_LIMIT_REPLY
                return AssistantResult(reply=reply, tool_calls=audits)

            conversation.append(
                {"role": "assistant", "content": [_serializable_block(block) for block in blocks]}
            )
            results: list[dict[str, Any]] = []
            for block in tool_uses:
                tool_name = str(_value(block, "name", ""))
                tool_input = _value(block, "input", {})
                if not isinstance(tool_input, dict):
                    tool_input = {}

                if tool_name == "decide_submission" and not decision_allowed:
                    result = {
                        "error": (
                            "decide_submission was blocked because the organizer did not "
                            "explicitly ask to accept, decline, or queue a submission"
                        )
                    }
                else:
                    result = await execute(org_id, tool_name, tool_input)
                    audits.append(
                        {"name": tool_name, "summary": summarize_arguments(tool_input)}
                    )

                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": str(_value(block, "id", "")),
                        "content": json.dumps(result, default=str, separators=(",", ":")),
                    }
                )
            conversation.append({"role": "user", "content": results})
            tool_rounds += 1
    except Exception:
        logger.warning("%s: Anthropic call failed", log_context, exc_info=True)
        return AssistantResult(reply=MODEL_FAILURE_REPLY, tool_calls=audits)
