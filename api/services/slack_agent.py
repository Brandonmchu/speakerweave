"""Slack transport for the shared SpeakerWeave conference assistant."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import httpx

from services import assistant

logger = logging.getLogger(__name__)

SLACK_API_URL = "https://slack.com/api"
MODEL = assistant.MODEL
MAX_OUTPUT_TOKENS = assistant.MAX_OUTPUT_TOKENS
MAX_TOOL_ROUNDS = assistant.MAX_TOOL_ROUNDS
TOOLS = assistant.TOOLS
MODEL_FAILURE_REPLY = assistant.MODEL_FAILURE_REPLY

SYSTEM_PROMPT = (
    "You are SpeakerWeave, a concise conference operations assistant in Slack. "
    "Use the supplied tools for factual questions; never invent conference data. "
    "Only use decide_submission when the user's message explicitly asks you to "
    "accept, decline, or queue a submission. Keep the final answer practical and "
    "short enough for Slack. Format for Slack mrkdwn, NOT standard Markdown: "
    "*single asterisks* for bold, _underscores_ for italic, plain '-' bullets, "
    "and never use ** or ## — Slack renders those literally."
)
NO_KEY_REPLY = (
    "SpeakerWeave's Slack agent is installed, but ANTHROPIC_API_KEY is not "
    "configured yet. Add it to the API environment and try again."
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
    """Compatibility seam retained for the Slack transport tests."""
    return await assistant._call_anthropic(
        messages,
        key=key,
        system_prompt=SYSTEM_PROMPT,
    )


async def run_tool(org_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Compatibility seam delegating to the shared org-scoped executor."""
    return await assistant.run_tool(org_id, name, arguments)


async def answer(text: str, org_id: str) -> str:
    clean_text = re.sub(r"<@[A-Z0-9]+>", "", text, flags=re.IGNORECASE).strip()
    result = await assistant.run(
        [{"role": "user", "content": clean_text or "Help me with this conference."}],
        org_id,
        system_prompt=SYSTEM_PROMPT,
        no_key_reply=NO_KEY_REPLY,
        model_call=_call_anthropic,
        tool_executor=run_tool,
        log_context="slack agent",
    )
    return result.reply


_MD_BOLD = re.compile(r"\*\*(.+?)\*\*")
_MD_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.+)$", re.MULTILINE)
_MD_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")


def to_mrkdwn(text: str) -> str:
    """Best-effort standard-Markdown to Slack mrkdwn backstop."""
    parts = text.split("```")
    for i in range(0, len(parts), 2):
        chunk = parts[i]
        chunk = _MD_HEADING.sub(lambda match: f"*{match.group(1).strip()}*", chunk)
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
