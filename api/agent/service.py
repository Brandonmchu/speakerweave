"""Provider-neutral agent turn service shared by HTTP transports."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from agent import mcp_connectors, permissions, threads, titles
from agent.events import PUBLIC_EVENT_TYPES
from agent.prompt import build_system_prompt
from agent.tools import TurnContext

logger = logging.getLogger(__name__)

EventCallback = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class TurnResult:
    status: Literal["complete", "error", "cancelled", "busy"]
    message_to_user: str
    error_message: str | None
    thread_id: str
    turn_id: str


@dataclass
class ActiveTurn:
    thread_id: str
    turn_id: str
    context: TurnContext
    completion_task: asyncio.Task[Any] | None = None


_ACTIVE_TURNS: dict[str, ActiveTurn] = {}
_ACTIVE_TURNS_LOCK = asyncio.Lock()


def resolve_provider() -> str | None:
    explicit = (os.getenv("ASSISTANT_PROVIDER") or "").strip().casefold()
    if explicit in {"openai", "anthropic"}:
        return explicit
    if (os.getenv("OPENAI_API_KEY") or "").strip():
        return "openai"
    if (os.getenv("ANTHROPIC_API_KEY") or "").strip():
        return "anthropic"
    return None


def valid_turn_id(value: str | None) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        return str(uuid.uuid4())


async def claim_turn(active: ActiveTurn) -> bool:
    async with _ACTIVE_TURNS_LOCK:
        if active.thread_id in _ACTIVE_TURNS:
            return False
        _ACTIVE_TURNS[active.thread_id] = active
        return True


async def release_turn(thread_id: str, turn_id: str) -> None:
    async with _ACTIVE_TURNS_LOCK:
        active = _ACTIVE_TURNS.get(thread_id)
        if active and active.turn_id == turn_id:
            _ACTIVE_TURNS.pop(thread_id, None)


async def cancel_turn(thread_id: str, turn_id: str) -> bool:
    async with _ACTIVE_TURNS_LOCK:
        active = _ACTIVE_TURNS.get(thread_id)
        if not active or active.turn_id != turn_id:
            return False
        active.context.cancel_event.set()
        producer = active.context.producer_task
        if producer and not producer.done():
            producer.cancel()
        return True


async def _send_event(
    on_event: EventCallback | None,
    event: dict[str, Any],
) -> None:
    if on_event is None:
        return
    try:
        await on_event(event)
    except Exception:
        logger.warning("Agent turn event observer failed", exc_info=True)


async def run_turn(
    *,
    org_id: str,
    user_id: str,
    thread_id: str | None = None,
    message: str,
    metadata: dict[str, Any] | None = None,
    on_event: EventCallback | None = None,
    permission_timeout_seconds: float | None = None,
) -> TurnResult:
    """Run and persist one agent turn independently of any transport reader."""
    provider = resolve_provider()
    turn_metadata = dict(metadata or {})
    if permission_timeout_seconds is not None:
        turn_metadata["permission_timeout_seconds"] = permission_timeout_seconds
    turn_id = valid_turn_id(turn_metadata.get("client_turn_id"))

    if thread_id:
        thread = await threads.fetch_thread(thread_id, org_id)
    else:
        thread = await threads.create_thread(org_id, user_id)
    resolved_thread_id = str(thread["id"])
    progress_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    stream_open = asyncio.Event()
    stream_open.set()
    context = TurnContext(
        org_id=org_id,
        user_id=user_id,
        thread_id=resolved_thread_id,
        turn_id=turn_id,
        metadata=turn_metadata,
        progress_queue=progress_queue,
        cancel_event=asyncio.Event(),
    )
    active = ActiveTurn(
        thread_id=resolved_thread_id,
        turn_id=turn_id,
        context=context,
        completion_task=asyncio.current_task(),
    )
    await _send_event(
        on_event,
        {
            "type": "thread_started",
            "thread_id": resolved_thread_id,
            "turn_id": turn_id,
        },
    )
    if not await claim_turn(active):
        await _send_event(
            on_event,
            {
                "type": "error",
                "message": "This thread already has a live turn.",
                "code": "thread_busy",
            },
        )
        return TurnResult(
            status="busy",
            message_to_user="",
            error_message=None,
            thread_id=resolved_thread_id,
            turn_id=turn_id,
        )

    dispatcher_task: asyncio.Task[None] | None = None

    async def dispatch_events() -> None:
        while True:
            event_item = await progress_queue.get()
            try:
                if event_item.get("type") == "_dispatcher_stop":
                    return
                if str(event_item.get("type") or "") in PUBLIC_EVENT_TYPES:
                    await _send_event(on_event, event_item)
            finally:
                progress_queue.task_done()

    try:
        dispatcher_task = asyncio.create_task(dispatch_events())
        history_result, event_result, connector_result = await asyncio.gather(
            threads.load_history(resolved_thread_id, org_id),
            threads.current_event_context(org_id),
            mcp_connectors.connected_count(org_id),
            return_exceptions=True,
        )
        if isinstance(history_result, BaseException):
            raise history_result
        history = history_result
        event = None if isinstance(event_result, BaseException) else event_result
        connector_count = (
            0 if isinstance(connector_result, BaseException) else connector_result
        )
        await threads.persist_user_message(
            thread_id=resolved_thread_id,
            org_id=org_id,
            user_id=user_id,
            turn_id=turn_id,
            content=message,
            metadata=turn_metadata,
        )

        system_prompt = build_system_prompt(
            org_id=org_id,
            user_id=user_id,
            metadata=turn_metadata,
            event=event,
            mcp_connectors_connected=int(connector_count),
        )
        full_prompt = threads.format_history(history, message)
        accumulated: list[str] = []
        usage: dict[str, Any] = {}
        status: Literal["complete", "error", "cancelled"] = "complete"
        error_message = "The conference assistant could not finish this turn."

        try:
            if provider == "openai":
                from agent.runtime_openai import stream_response
            elif provider == "anthropic":
                from agent.runtime_anthropic import stream_response
            else:
                raise RuntimeError("No agent provider is configured")

            async for event_item in stream_response(
                context=context,
                system_prompt=system_prompt,
                full_prompt=full_prompt,
            ):
                event_type = str(event_item.get("type") or "")
                if event_type == "message_delta":
                    accumulated.append(str(event_item.get("message") or ""))
                    await progress_queue.put(event_item)
                elif event_type == "runtime_complete":
                    usage = dict(event_item.get("usage") or {})
                elif event_type == "runtime_cancelled":
                    status = "cancelled"
                    break
                elif event_type == "error":
                    status = "error"
                    error_message = str(event_item.get("message") or error_message)
                    break
                elif event_type in PUBLIC_EVENT_TYPES:
                    await progress_queue.put(event_item)

            if context.cancel_event.is_set():
                status = "cancelled"
            response_text = "".join(accumulated).strip()
            if status == "complete" and not response_text:
                response_text = "I couldn't produce a response for that request."
                await progress_queue.put(
                    {"type": "message_delta", "message": response_text}
                )
                await progress_queue.put({"type": "message_complete"})

            if status == "complete" or response_text:
                await threads.persist_agent_message(
                    thread_id=resolved_thread_id,
                    org_id=org_id,
                    turn_id=turn_id,
                    content=response_text,
                    metadata={
                        "turn_id": turn_id,
                        "usage": usage,
                        "agent_sdk": (
                            "openai_agents_sdk"
                            if provider == "openai"
                            else "anthropic_sdk"
                        ),
                        "activity": context.activity,
                        **({"cancelled": True} if status == "cancelled" else {}),
                    },
                    reasoning_context={
                        "tool_calls": context.tool_calls,
                        "provider": provider,
                    },
                    response_type="error" if status == "error" else "completion",
                )

            if status == "complete" and response_text:
                asyncio.create_task(
                    titles.maybe_generate_title(
                        provider=provider,
                        thread_id=resolved_thread_id,
                        org_id=org_id,
                        user_message=message,
                        assistant_reply=response_text,
                        prior_history=history,
                        progress_queue=progress_queue,
                        stream_open=stream_open,
                    )
                )
        except asyncio.CancelledError:
            response_text = "".join(accumulated).strip()
            if response_text:
                await threads.persist_agent_message(
                    thread_id=resolved_thread_id,
                    org_id=org_id,
                    turn_id=turn_id,
                    content=response_text,
                    metadata={
                        "turn_id": turn_id,
                        "usage": usage,
                        "agent_sdk": (
                            "openai_agents_sdk"
                            if provider == "openai"
                            else "anthropic_sdk"
                        ),
                        "activity": context.activity,
                        "cancelled": True,
                    },
                    reasoning_context={
                        "tool_calls": context.tool_calls,
                        "provider": provider,
                    },
                )
            status = "cancelled"
        except Exception:  # noqa: BLE001 - convert provider/persistence failure
            status = "error"
            response_text = "".join(accumulated).strip()

        await progress_queue.join()
        result = TurnResult(
            status=status,
            message_to_user=response_text,
            error_message=error_message if status == "error" else None,
            thread_id=resolved_thread_id,
            turn_id=turn_id,
        )
        if status == "cancelled":
            await _send_event(on_event, {"type": "cancelled"})
        elif status == "error":
            await _send_event(
                on_event,
                {"type": "error", "message": error_message or "Agent error"},
            )
        else:
            await _send_event(
                on_event,
                {"type": "complete", "message_to_user": response_text},
            )
        return result
    except Exception:  # noqa: BLE001 - transport receives a terminal agent error
        error_message = "The conference assistant could not finish this turn."
        await _send_event(on_event, {"type": "error", "message": error_message})
        return TurnResult(
            status="error",
            message_to_user="",
            error_message=error_message,
            thread_id=resolved_thread_id,
            turn_id=turn_id,
        )
    finally:
        stream_open.clear()
        await permissions.deny_pending_for_turn(resolved_thread_id, turn_id)
        await release_turn(resolved_thread_id, turn_id)
        if dispatcher_task is not None:
            await progress_queue.put({"type": "_dispatcher_stop"})
            await dispatcher_task
