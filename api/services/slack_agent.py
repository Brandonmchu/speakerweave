"""One-turn Slack conference agent backed by the same services as MCP.

Slack workspace-to-organization mapping is intentionally temporary: events use
``SLACK_DEFAULT_ORG`` until workspace installation records move into
``org_integrations``. Tool execution itself is already tenant-safe because only
that resolved organization id reaches :mod:`services.integration_api`.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import httpx
from fastapi import HTTPException

from services import integration_api

logger = logging.getLogger(__name__)

MODEL = "claude-haiku-4-5"
MAX_OUTPUT_TOKENS = 1600
MAX_TOOL_ROUNDS = 5
SLACK_API_URL = "https://slack.com/api"

SYSTEM_PROMPT = (
    "You are SpeakerWeave, a concise conference operations assistant in Slack. "
    "Use the supplied tools for factual questions; never invent conference data. "
    "Only use decide_submission when the user's message explicitly asks you to "
    "accept, decline, or queue a submission. Keep the final answer practical and "
    "short enough for Slack. Format for Slack mrkdwn, NOT standard Markdown: "
    "*single asterisks* for bold, _underscores_ for italic, plain '-' bullets, "
    "and never use ** or ## — Slack renders those literally."
)

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

NO_KEY_REPLY = (
    "SpeakerWeave's Slack agent is installed, but ANTHROPIC_API_KEY is not "
    "configured yet. Add it to the API environment and try again."
)
MODEL_FAILURE_REPLY = (
    "I couldn't reach the conference assistant just now. Please try again in a moment."
)


def configured_status() -> dict[str, Any]:
    signing = bool((os.getenv("SLACK_SIGNING_SECRET") or "").strip())
    bot = bool((os.getenv("SLACK_BOT_TOKEN") or "").strip())
    anthropic = bool((os.getenv("ANTHROPIC_API_KEY") or "").strip())
    return {
        "configured": signing and bot,
        "signing_secret_configured": signing,
        "bot_token_configured": bot,
        "anthropic_configured": anthropic,
        "default_org": (os.getenv("SLACK_DEFAULT_ORG") or "org_dev").strip() or "org_dev",
        "source": "environment",
    }


async def _call_anthropic(messages: list[dict[str, Any]], *, key: str) -> Any:
    """One model turn. Tests patch this boundary; it never networks in the suite."""
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=key)
    return await client.messages.create(
        model=MODEL,
        max_tokens=MAX_OUTPUT_TOKENS,
        system=SYSTEM_PROMPT,
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
            event_id = await _event_id(org_id, arguments.get("event")) if arguments.get("event") else None
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
            event_id = await _event_id(org_id, arguments.get("event")) if arguments.get("event") else None
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


async def answer(text: str, org_id: str) -> str:
    key = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
    if not key:
        return NO_KEY_REPLY

    clean_text = re.sub(r"<@[A-Z0-9]+>", "", text, flags=re.IGNORECASE).strip()
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": clean_text or "Help me with this conference."}
    ]
    tool_rounds = 0
    try:
        while True:
            response = await _call_anthropic(messages, key=key)
            blocks = list(_value(response, "content", []) or [])
            text_parts = [
                str(_value(block, "text", "")).strip()
                for block in blocks
                if _value(block, "type") == "text" and str(_value(block, "text", "")).strip()
            ]
            tool_uses = [block for block in blocks if _value(block, "type") == "tool_use"]
            if not tool_uses:
                return "\n".join(text_parts).strip() or MODEL_FAILURE_REPLY
            if tool_rounds >= MAX_TOOL_ROUNDS:
                return "\n".join(text_parts).strip() or (
                    "I reached the tool-use limit before I could finish that request. "
                    "Try asking for a smaller slice of the conference data."
                )

            messages.append(
                {"role": "assistant", "content": [_serializable_block(block) for block in blocks]}
            )
            results: list[dict[str, Any]] = []
            for block in tool_uses:
                tool_name = str(_value(block, "name", ""))
                tool_input = _value(block, "input", {})
                if not isinstance(tool_input, dict):
                    tool_input = {}
                result = await run_tool(org_id, tool_name, tool_input)
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": str(_value(block, "id", "")),
                        "content": json.dumps(result, default=str, separators=(",", ":")),
                    }
                )
            messages.append({"role": "user", "content": results})
            tool_rounds += 1
    except Exception:
        logger.warning("slack agent: Anthropic call failed", exc_info=True)
        return MODEL_FAILURE_REPLY


_MD_BOLD = re.compile(r"\*\*(.+?)\*\*")
_MD_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.+)$", re.MULTILINE)
_MD_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")


def to_mrkdwn(text: str) -> str:
    """Best-effort standard-Markdown → Slack mrkdwn.

    The model is prompted to emit mrkdwn, but a slip into **bold**, ## headings,
    or [text](url) renders literally in Slack — this converter is the backstop.
    Code fences are left untouched (Slack renders triple-backtick blocks)."""
    parts = text.split("```")
    for i in range(0, len(parts), 2):  # even indexes are outside code fences
        chunk = parts[i]
        chunk = _MD_HEADING.sub(lambda m: f"*{m.group(1).strip()}*", chunk)
        chunk = _MD_BOLD.sub(r"*\1*", chunk)
        chunk = _MD_LINK.sub(r"<\2|\1>", chunk)
        parts[i] = chunk
    return "```".join(parts)


async def post_message(channel: str, thread_ts: str, text: str) -> None:
    token = (os.getenv("SLACK_BOT_TOKEN") or "").strip()
    if not token:
        logger.warning("slack agent: SLACK_BOT_TOKEN is not configured; reply not posted")
        return
    text = to_mrkdwn(text)
    try:
        async with httpx.AsyncClient(
            base_url=SLACK_API_URL,
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(8.0, connect=3.0),
        ) as client:
            response = await client.post(
                "/chat.postMessage",
                json={"channel": channel, "thread_ts": thread_ts, "text": text},
            )
            response.raise_for_status()
            payload = response.json()
            if not payload.get("ok"):
                raise RuntimeError(payload.get("error") or "Slack rejected chat.postMessage")
    except Exception:
        logger.warning("slack agent: could not post reply", exc_info=True)


async def handle_event(event: dict[str, Any], org_id: str) -> None:
    channel = str(event.get("channel") or "")
    timestamp = str(event.get("thread_ts") or event.get("ts") or "")
    if not channel or not timestamp:
        return
    reply = await answer(str(event.get("text") or ""), org_id)
    await post_message(channel, timestamp, reply)
