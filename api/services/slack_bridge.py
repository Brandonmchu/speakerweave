"""Slack transport for the shared SpeakerWeave agent runtime."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from agent import threads
from agent.router import resolve_provider
from agent.service import TurnResult, run_turn
from services.slack_mrkdwn import markdown_to_slack_mrkdwn
from services.supabase_helpers import db, first
from supabase_client import supabase

logger = logging.getLogger(__name__)

SLACK_API_URL = "https://slack.com/api"
EVENT_DEDUPE_TTL_SECONDS = 15 * 60
EVENT_DEDUPE_MAX = 1_000
PERMISSION_TIMEOUT_SECONDS = 300.0

ERROR_REPLY = "Sorry, something went wrong processing your message. Please try again."
BUSY_REPLY = (
    "I'm still working on your previous message in this thread — give me a moment "
    "and try again."
)

_LEADING_MENTION_RE = re.compile(r"^\s*<@[A-Z0-9]+>\s*", re.IGNORECASE)
_SEEN_EVENTS: OrderedDict[str, float] = OrderedDict()
_SEEN_EVENTS_LOCK = asyncio.Lock()
_DISPLAY_NAME_CACHE: dict[str, str] = {}


@dataclass(frozen=True)
class SlackThread:
    agent_thread_id: str
    mapping_thread_ts: str
    reply_thread_ts: str | None


def default_org_id() -> str:
    return (os.getenv("SLACK_DEFAULT_ORG") or "org_dev").strip() or "org_dev"


def expected_provider() -> str:
    return resolve_provider() or "anthropic"


def model_key_configured(provider: str | None = None) -> bool:
    selected = provider or expected_provider()
    key_name = "OPENAI_API_KEY" if selected == "openai" else "ANTHROPIC_API_KEY"
    return bool((os.getenv(key_name) or "").strip())


def no_key_reply(provider: str | None = None) -> str:
    selected = provider or expected_provider()
    key_name = "OPENAI_API_KEY" if selected == "openai" else "ANTHROPIC_API_KEY"
    return (
        "SpeakerWeave's Slack agent is installed, but "
        f"{key_name} is not configured yet. Add it to the API environment and try again."
    )


def configured_status() -> dict[str, Any]:
    signing = bool((os.getenv("SLACK_SIGNING_SECRET") or "").strip())
    bot = bool((os.getenv("SLACK_BOT_TOKEN") or "").strip())
    anthropic = bool((os.getenv("ANTHROPIC_API_KEY") or "").strip())
    openai = bool((os.getenv("OPENAI_API_KEY") or "").strip())
    provider = resolve_provider()
    return {
        "configured": signing and bot,
        "signing_secret_configured": signing,
        "bot_token_configured": bot,
        "anthropic_configured": anthropic,
        "openai_configured": openai,
        "default_org": default_org_id(),
        "source": "environment",
        "provider": provider,
        "agent_backed": True,
        "model_key_configured": model_key_configured(provider),
    }


async def claim_event(event_id: str | None) -> bool:
    """Return False for a live duplicate; retain at most 1,000 IDs."""
    if not event_id:
        return True
    now = time.monotonic()
    async with _SEEN_EVENTS_LOCK:
        while _SEEN_EVENTS:
            oldest_id, seen_at = next(iter(_SEEN_EVENTS.items()))
            if now - seen_at <= EVENT_DEDUPE_TTL_SECONDS:
                break
            _SEEN_EVENTS.pop(oldest_id, None)
        if event_id in _SEEN_EVENTS:
            return False
        _SEEN_EVENTS[event_id] = now
        while len(_SEEN_EVENTS) > EVENT_DEDUPE_MAX:
            _SEEN_EVENTS.popitem(last=False)
    return True


def strip_leading_mention(text: str) -> str:
    cleaned = _LEADING_MENTION_RE.sub("", text, count=1).strip()
    return cleaned or "What can you help me with?"


def _is_unique_violation(exc: Exception) -> bool:
    if getattr(exc, "code", None) == "23505":
        return True
    message = f"{getattr(exc, 'message', '') or ''} {exc}".casefold()
    return "23505" in message or "duplicate key value violates unique constraint" in message


async def _find_exact_mapping(
    org_id: str, channel_id: str, thread_ts: str
) -> dict[str, Any] | None:
    return first(
        await db(
            lambda: supabase.table("slack_agent_threads")
            .select("id, org_id, channel_id, thread_ts, channel_type, agent_thread_id, created_at")
            .eq("org_id", org_id)
            .eq("channel_id", channel_id)
            .eq("thread_ts", thread_ts)
            .limit(1)
            .execute(),
            "slack_agent_thread_exact",
        )
    )


async def _find_latest_dm_mapping(
    org_id: str, channel_id: str
) -> dict[str, Any] | None:
    return first(
        await db(
            lambda: supabase.table("slack_agent_threads")
            .select("id, org_id, channel_id, thread_ts, channel_type, agent_thread_id, created_at")
            .eq("org_id", org_id)
            .eq("channel_id", channel_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute(),
            "slack_agent_thread_latest_dm",
        )
    )


async def _create_mapping(
    *,
    org_id: str,
    user_id: str,
    channel_id: str,
    thread_ts: str,
    channel_type: str,
) -> str:
    thread = await threads.create_thread(org_id, user_id)
    agent_thread_id = str(thread["id"])
    await threads.rename_thread(agent_thread_id, org_id, "Slack")
    record = {
        "org_id": org_id,
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "channel_type": channel_type,
        "agent_thread_id": agent_thread_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await db(
            lambda: supabase.table("slack_agent_threads").insert(record).execute(),
            "slack_agent_thread_create",
        )
    except Exception as exc:
        if _is_unique_violation(exc):
            winner = await _find_exact_mapping(org_id, channel_id, thread_ts)
            if winner:
                return str(winner["agent_thread_id"])
        raise
    return agent_thread_id


async def resolve_thread(event: dict[str, Any], org_id: str) -> SlackThread:
    channel_id = str(event.get("channel") or "")
    message_ts = str(event.get("ts") or "")
    inbound_thread_ts = str(event.get("thread_ts") or "")
    channel_type = str(event.get("channel_type") or "channel")
    slack_user_id = str(event.get("user") or "")
    if not channel_id or not message_ts or not slack_user_id:
        raise ValueError("Slack event is missing channel, timestamp, or user")

    user_id = f"slack:{slack_user_id}"
    if channel_type == "im" and not inbound_thread_ts:
        existing = await _find_latest_dm_mapping(org_id, channel_id)
        mapping_thread_ts = str(existing.get("thread_ts") or "") if existing else message_ts
        agent_thread_id = (
            str(existing["agent_thread_id"])
            if existing
            else await _create_mapping(
                org_id=org_id,
                user_id=user_id,
                channel_id=channel_id,
                thread_ts=mapping_thread_ts,
                channel_type=channel_type,
            )
        )
    else:
        mapping_thread_ts = inbound_thread_ts or message_ts
        existing = await _find_exact_mapping(org_id, channel_id, mapping_thread_ts)
        agent_thread_id = (
            str(existing["agent_thread_id"])
            if existing
            else await _create_mapping(
                org_id=org_id,
                user_id=user_id,
                channel_id=channel_id,
                thread_ts=mapping_thread_ts,
                channel_type=channel_type,
            )
        )

    # Only a TOP-LEVEL DM replies unthreaded; a threaded DM (including the
    # AI-app assistant pane, whose messages always carry thread_ts) must reply
    # into its thread or the answer lands outside the conversation.
    is_top_level_dm = channel_type == "im" and not inbound_thread_ts
    return SlackThread(
        agent_thread_id=agent_thread_id,
        mapping_thread_ts=mapping_thread_ts,
        reply_thread_ts=None if is_top_level_dm else mapping_thread_ts,
    )


async def _slack_api_post(
    path: str,
    payload: dict[str, Any],
    *,
    timeout_seconds: float,
) -> dict[str, Any]:
    token = (os.getenv("SLACK_BOT_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("SLACK_BOT_TOKEN is not configured")
    async with httpx.AsyncClient(
        base_url=SLACK_API_URL,
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout_seconds,
    ) as client:
        response = await client.post(path, json=payload)
        response.raise_for_status()
        result = response.json()
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or f"Slack rejected {path}")
    return result


async def set_thinking_status(channel_id: str, thread_ts: str | None) -> None:
    """Show Slack's native assistant 'thinking' status. UX polish only —
    valid solely in AI-app DM threads, so failures are expected and ignored."""
    if not thread_ts:
        return
    try:
        await _slack_api_post(
            "/assistant.threads.setStatus",
            {"channel_id": channel_id, "thread_ts": thread_ts, "status": "is thinking..."},
            timeout_seconds=5.0,
        )
    except Exception:
        logger.debug("slack bridge: setStatus unavailable", exc_info=True)


async def handle_assistant_thread_started(event: dict[str, Any], org_id: str) -> None:
    """New-conversation boundary: insert a fresh mapping so the next DM in the
    assistant pane starts a new agent thread instead of resuming the last one."""
    thread = event.get("assistant_thread") or {}
    channel_id = str(thread.get("channel_id") or "")
    thread_ts = str(thread.get("thread_ts") or "")
    slack_user_id = str(thread.get("user_id") or "")
    if not channel_id or not thread_ts or not slack_user_id:
        return
    try:
        await _create_mapping(
            org_id=org_id,
            user_id=f"slack:{slack_user_id}",
            channel_id=channel_id,
            thread_ts=thread_ts,
            channel_type="im",
        )
    except Exception:
        logger.warning("slack bridge: assistant thread reset failed", exc_info=True)


async def slack_display_name(slack_user_id: str) -> str | None:
    cached = _DISPLAY_NAME_CACHE.get(slack_user_id)
    if cached:
        return cached
    try:
        result = await _slack_api_post(
            "/users.info",
            {"user": slack_user_id},
            timeout_seconds=5.0,
        )
        user = result.get("user") or {}
        profile = user.get("profile") or {}
        display = str(
            profile.get("display_name")
            or profile.get("real_name")
            or user.get("real_name")
            or user.get("name")
            or ""
        ).strip()
        if display:
            _DISPLAY_NAME_CACHE[slack_user_id] = display
            return display
    except Exception:
        logger.warning("slack bridge: could not resolve speaker name", exc_info=True)
    return None


def permission_blocks(event: dict[str, Any]) -> list[dict[str, Any]]:
    request_id = str(event.get("request_id") or "")
    description = str(event.get("description") or "Allow this action?")
    lines = ["*Approval needed*", description]
    tool_input = event.get("tool_input") or {}
    if isinstance(tool_input, dict):
        for key in ("_submission_display", "_person_display", "_connector_name"):
            value = str(tool_input.get(key) or "").strip()
            if value:
                lines.append(f"• {value}")
    return [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": "\n".join(lines)},
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "action_id": "permission_approve",
                    "text": {"type": "plain_text", "text": "Approve"},
                    "style": "primary",
                    "value": request_id,
                },
                {
                    "type": "button",
                    "action_id": "permission_deny",
                    "text": {"type": "plain_text", "text": "Deny"},
                    "style": "danger",
                    "value": request_id,
                },
            ],
        },
    ]


async def post_message(
    *,
    channel_id: str,
    thread_ts: str | None,
    text: str,
    blocks: list[dict[str, Any]] | None = None,
) -> None:
    token = (os.getenv("SLACK_BOT_TOKEN") or "").strip()
    if not token:
        logger.warning("slack bridge: SLACK_BOT_TOKEN is not configured; message not posted")
        return
    payload: dict[str, Any] = {
        "channel": channel_id,
        "text": markdown_to_slack_mrkdwn(text),
        "unfurl_links": False,
        "unfurl_media": False,
    }
    if thread_ts:
        payload["thread_ts"] = thread_ts
    if blocks is not None:
        payload["blocks"] = blocks
    try:
        await _slack_api_post("/chat.postMessage", payload, timeout_seconds=15.0)
    except Exception:
        logger.warning("slack bridge: could not post message", exc_info=True)


async def replace_permission_card(response_url: str, text: str) -> None:
    if not response_url:
        return
    payload = {
        "replace_original": True,
        "text": text,
        "blocks": [
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": text},
            }
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(response_url, json=payload)
            response.raise_for_status()
    except Exception:
        logger.warning("slack bridge: could not replace permission card", exc_info=True)


def _reply_for_result(result: TurnResult) -> str:
    if result.status == "complete":
        return result.message_to_user
    if result.status == "busy":
        return BUSY_REPLY
    return ERROR_REPLY


async def handle_event(
    event: dict[str, Any],
    org_id: str,
    event_id: str | None = None,
) -> None:
    if not await claim_event(event_id):
        return
    channel_id = str(event.get("channel") or "")
    message_ts = str(event.get("ts") or "")
    slack_user_id = str(event.get("user") or "")
    channel_type = str(event.get("channel_type") or "channel")
    if not channel_id or not message_ts or not slack_user_id:
        return

    inbound_thread_ts = str(event.get("thread_ts") or "")
    reply_thread_ts = (
        None
        if channel_type == "im" and not inbound_thread_ts
        else inbound_thread_ts or message_ts
    )
    provider = expected_provider()
    if not model_key_configured(provider):
        await post_message(
            channel_id=channel_id,
            thread_ts=reply_thread_ts,
            text=no_key_reply(provider),
        )
        return

    try:
        if channel_type == "im":
            await set_thinking_status(
                channel_id, str(event.get("thread_ts") or message_ts)
            )
        resolved = await resolve_thread(event, org_id)
        text = str(event.get("text") or "")
        if event.get("type") == "app_mention":
            text = strip_leading_mention(text)
        else:
            text = text.strip() or "What can you help me with?"
        if channel_type != "im":
            display_name = await slack_display_name(slack_user_id)
            if display_name:
                text = f"{display_name}: {text}"

        async def on_event(event_item: dict[str, Any]) -> None:
            if event_item.get("type") != "permission_request":
                return
            description = str(event_item.get("description") or "Allow this action?")
            await post_message(
                channel_id=channel_id,
                thread_ts=resolved.reply_thread_ts,
                text=f"Approval needed: {description}",
                blocks=permission_blocks(event_item),
            )

        result = await run_turn(
            org_id=org_id,
            user_id=f"slack:{slack_user_id}",
            thread_id=resolved.agent_thread_id,
            message=text,
            metadata={
                "source": "slack",
                "slack_channel_id": channel_id,
                "slack_event_id": event_id,
            },
            permission_timeout_seconds=PERMISSION_TIMEOUT_SECONDS,
            on_event=on_event,
        )
        await post_message(
            channel_id=channel_id,
            thread_ts=resolved.reply_thread_ts,
            text=_reply_for_result(result),
        )
    except Exception:
        logger.warning("slack bridge: agent turn failed", exc_info=True)
        await post_message(
            channel_id=channel_id,
            thread_ts=reply_thread_ts,
            text=ERROR_REPLY,
        )
