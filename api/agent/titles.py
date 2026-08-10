"""Cheap first-exchange thread title generation."""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any

from agent import threads
from services import assistant

DEFAULT_THREAD_NAMES = frozenset({"", "Chat", "New chat"})


def should_generate_title(
    thread_name: str | None, prior_history: list[dict[str, str]]
) -> bool:
    return (thread_name or "") in DEFAULT_THREAD_NAMES and not any(
        message.get("role") == "assistant" for message in prior_history
    )


def _clean_title(value: str) -> str | None:
    title = re.sub(r"\s+", " ", value).strip().strip('"\'`#*- ')
    if not title:
        return None
    return title[:100].rstrip()


async def _openai_title(user_message: str, assistant_reply: str) -> str | None:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=(os.getenv("OPENAI_API_KEY") or "").strip())
    response = await client.responses.create(
        model=(os.getenv("ASSISTANT_OPENAI_MODEL") or "gpt-5.6-luna").strip(),
        input=(
            "Write a specific 3-7 word title for this conference-operations chat. "
            "Return only the title.\n\n"
            f"User: {user_message}\nAssistant: {assistant_reply}"
        ),
        reasoning={"effort": "minimal"},
        max_output_tokens=40,
        store=False,
    )
    return _clean_title(str(getattr(response, "output_text", "") or ""))


async def _anthropic_title(user_message: str, assistant_reply: str) -> str | None:
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=(os.getenv("ANTHROPIC_API_KEY") or "").strip())
    response = await client.messages.create(
        model=assistant.MODEL,
        max_tokens=40,
        messages=[
            {
                "role": "user",
                "content": (
                    "Write a specific 3-7 word title for this conference-operations "
                    "chat. Return only the title.\n\n"
                    f"User: {user_message}\nAssistant: {assistant_reply}"
                ),
            }
        ],
    )
    text = " ".join(
        str(getattr(block, "text", ""))
        for block in list(getattr(response, "content", []) or [])
        if getattr(block, "type", "") == "text"
    )
    return _clean_title(text)


async def generate_title(
    provider: str, user_message: str, assistant_reply: str
) -> str | None:
    if provider == "openai" and (os.getenv("OPENAI_API_KEY") or "").strip():
        return await _openai_title(user_message, assistant_reply)
    if provider == "anthropic" and (os.getenv("ANTHROPIC_API_KEY") or "").strip():
        return await _anthropic_title(user_message, assistant_reply)
    return None


async def maybe_generate_title(
    *,
    provider: str,
    thread_id: str,
    org_id: str,
    user_message: str,
    assistant_reply: str,
    prior_history: list[dict[str, str]],
    progress_queue: asyncio.Queue[dict[str, Any]],
    stream_open: asyncio.Event,
) -> None:
    """Update a still-default first-turn title; failures never affect the turn."""
    try:
        current = await threads.fetch_thread(thread_id, org_id)
        if not should_generate_title(str(current.get("name") or ""), prior_history):
            return
        title = await generate_title(provider, user_message, assistant_reply)
        if not title:
            return
        current = await threads.fetch_thread(thread_id, org_id)
        if str(current.get("name") or "") not in DEFAULT_THREAD_NAMES:
            return
        updated = await threads.rename_thread(thread_id, org_id, title)
        if stream_open.is_set():
            await progress_queue.put(
                {
                    "type": "thread_update",
                    "thread_id": thread_id,
                    "name": updated["name"],
                }
            )
    except Exception:  # noqa: BLE001 - title generation is explicitly best-effort
        # Title generation is intentionally best-effort and fire-and-forget.
        return
