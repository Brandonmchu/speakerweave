"""Streaming Anthropic fallback translated to the shared semantic vocabulary."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from typing import Any

from agent import every_mcp
from agent.events import semantic_event
from agent.permissions import with_permission_guidance
from agent.tools import TurnContext, invoke_tool, registered_tools
from services import assistant

MAX_ITERATIONS = 30
_QUEUE_DONE = object()


def _value(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _serialize_block(block: Any) -> dict[str, Any]:
    block_type = str(_value(block, "type", ""))
    if block_type == "text":
        return {"type": "text", "text": str(_value(block, "text", ""))}
    if block_type == "tool_use":
        return {
            "type": "tool_use",
            "id": str(_value(block, "id", "")),
            "name": str(_value(block, "name", "")),
            "input": _value(block, "input", {}) or {},
        }
    return {"type": block_type}


def _merge_usage(total: dict[str, int], message: Any) -> None:
    usage = _value(message, "usage")
    for field in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
        value = _value(usage, field, 0)
        if isinstance(value, int):
            total[field] = total.get(field, 0) + value


async def stream_response(
    *,
    context: TurnContext,
    system_prompt: str,
    full_prompt: str,
) -> AsyncIterator[dict[str, Any]]:
    queue: asyncio.Queue[dict[str, Any] | object] = asyncio.Queue()

    async def producer() -> None:
        usage: dict[str, int] = {}
        try:
            # Lazy: disabled/OpenAI-only deployments never import Anthropic here.
            from anthropic import AsyncAnthropic

            client = AsyncAnthropic(api_key=(os.getenv("ANTHROPIC_API_KEY") or "").strip())
            conversation: list[dict[str, Any]] = [
                {"role": "user", "content": full_prompt}
            ]
            async with AsyncExitStack() as stack:
                external_definitions, external_handler = await every_mcp.anthropic_tools(
                    stack, context.org_id, context.progress_queue
                )
                definitions = [
                    *registered_tools(),
                    *(with_permission_guidance(item) for item in external_definitions),
                ]
                for _iteration in range(MAX_ITERATIONS):
                    if context.cancel_event.is_set():
                        raise asyncio.CancelledError
                    async with client.messages.stream(
                        model=assistant.MODEL,
                        max_tokens=assistant.MAX_OUTPUT_TOKENS,
                        system=system_prompt,
                        tools=definitions,
                        messages=conversation,
                    ) as stream:
                        emitted_text = False
                        async for delta in stream.text_stream:
                            if context.cancel_event.is_set():
                                raise asyncio.CancelledError
                            text = str(delta or "")
                            if text:
                                emitted_text = True
                                await queue.put(
                                    semantic_event("message_delta", message=text)
                                )
                        message = await stream.get_final_message()
                    _merge_usage(usage, message)
                    if emitted_text:
                        await queue.put(semantic_event("message_complete"))
                    blocks = list(_value(message, "content", []) or [])
                    tool_uses = [
                        block for block in blocks if _value(block, "type") == "tool_use"
                    ]
                    if not tool_uses:
                        await queue.put(
                            semantic_event(
                                "runtime_complete",
                                usage=usage,
                                model=assistant.MODEL,
                            )
                        )
                        return

                    conversation.append(
                        {
                            "role": "assistant",
                            "content": [_serialize_block(block) for block in blocks],
                        }
                    )
                    tool_results: list[dict[str, Any]] = []
                    for block in tool_uses:
                        if context.cancel_event.is_set():
                            raise asyncio.CancelledError
                        arguments = _value(block, "input", {}) or {}
                        if not isinstance(arguments, dict):
                            arguments = {}
                        result = await invoke_tool(
                            context,
                            str(_value(block, "name", "")),
                            arguments,
                            external_handler=external_handler,
                        )
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": str(_value(block, "id", "")),
                                "content": result,
                            }
                        )
                    conversation.append({"role": "user", "content": tool_results})

                await queue.put(
                    semantic_event(
                        "error",
                        message="The conference assistant reached its tool-use limit.",
                    )
                )
        except asyncio.CancelledError:
            await queue.put(semantic_event("runtime_cancelled"))
        except Exception as exc:  # noqa: BLE001 - provider boundary becomes SSE error
            await queue.put(
                semantic_event(
                    "error",
                    message="The conference assistant could not finish this turn.",
                    detail=str(exc),
                )
            )
        finally:
            await queue.put(_QUEUE_DONE)

    producer_task = asyncio.create_task(producer())
    context.producer_task = producer_task
    try:
        while True:
            event = await queue.get()
            if event is _QUEUE_DONE:
                break
            yield event  # type: ignore[misc]
    finally:
        if not producer_task.done():
            producer_task.cancel()
        try:
            await producer_task
        except asyncio.CancelledError:
            pass
