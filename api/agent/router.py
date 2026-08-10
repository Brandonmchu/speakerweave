"""Frozen `/api/agent` HTTP contract and detached streaming harness."""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from agent import context_search, every_mcp, permissions, threads, titles
from agent.events import PUBLIC_EVENT_TYPES, format_sse_event
from agent.prompt import build_system_prompt
from agent.tools import TurnContext
from auth import get_current_user_or_api_org

router = APIRouter(prefix="/api/agent", tags=["agent"])

MAX_MESSAGE_CHARS = 8_000
KEEPALIVE_SECONDS = 15.0


def resolve_provider() -> str | None:
    explicit = (os.getenv("ASSISTANT_PROVIDER") or "").strip().casefold()
    if explicit in {"openai", "anthropic"}:
        return explicit
    if (os.getenv("OPENAI_API_KEY") or "").strip():
        return "openai"
    if (os.getenv("ANTHROPIC_API_KEY") or "").strip():
        return "anthropic"
    return None


def assistant_enabled() -> bool:
    has_key = bool(
        (os.getenv("OPENAI_API_KEY") or "").strip()
        or (os.getenv("ANTHROPIC_API_KEY") or "").strip()
    )
    return has_key and (os.getenv("ASSISTANT_ENABLED") or "").strip().casefold() != "false"


def require_enabled() -> str:
    if not assistant_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    provider = resolve_provider()
    if provider is None:
        raise HTTPException(status_code=404, detail="Not found")
    return provider


def valid_turn_id(value: str | None) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        return str(uuid.uuid4())


class EmptyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RenameThreadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Thread name cannot be blank")
        return cleaned


class ChatMetadata(BaseModel):
    model_config = ConfigDict(extra="allow")

    pathname: str = Field(default="/dashboard", max_length=500)
    timezone: str = Field(default="UTC", max_length=100)
    client_turn_id: str | None = Field(default=None, max_length=100)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    thread_id: str | None = Field(default=None, max_length=100)
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CHARS)
    metadata: ChatMetadata = Field(default_factory=ChatMetadata)

    @field_validator("message")
    @classmethod
    def non_blank_message(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message cannot be blank")
        return value


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    thread_id: str
    turn_id: str


class PermissionResponseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str
    approved: bool


@dataclass
class ActiveTurn:
    thread_id: str
    turn_id: str
    context: TurnContext
    completion_task: asyncio.Task[None] | None = None


_ACTIVE_TURNS: dict[str, ActiveTurn] = {}
_ACTIVE_TURNS_LOCK = asyncio.Lock()


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


@router.get("/capabilities")
async def capabilities(
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    _user_id, org_id = auth
    enabled = assistant_enabled()
    try:
        every_status = await every_mcp.connection_status(org_id)
    except Exception:  # noqa: BLE001 - capability discovery must degrade closed
        every_status = {
            "available": every_mcp.is_available(),
            "connected": False,
            "connected_email": None,
        }
    return {
        "assistant": enabled,
        "provider": resolve_provider() if enabled else None,
        "every_mcp": {
            "available": every_status["available"],
            "connected": every_status["connected"],
        },
    }


@router.get("/threads")
async def get_threads(
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    _user_id, org_id = auth
    return {"threads": await threads.list_threads(org_id)}


@router.post("/threads")
async def post_thread(
    _payload: EmptyRequest,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    user_id, org_id = auth
    return {"thread": await threads.create_thread(org_id, user_id)}


@router.patch("/threads/{thread_id}")
async def patch_thread(
    thread_id: str,
    payload: RenameThreadRequest,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    _user_id, org_id = auth
    return {"thread": await threads.rename_thread(thread_id, org_id, payload.name)}


@router.delete("/threads/{thread_id}")
async def remove_thread(
    thread_id: str,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, bool]:
    require_enabled()
    _user_id, org_id = auth
    await threads.delete_thread(thread_id, org_id)
    return {"ok": True}


@router.get("/threads/{thread_id}/messages")
async def get_messages(
    thread_id: str,
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=5_000),
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    _user_id, org_id = auth
    messages, has_more = await threads.list_messages(
        thread_id, org_id, limit=limit, offset=offset
    )
    return {"messages": messages, "has_more": has_more}


@router.get("/threads/{thread_id}/permission-requests/pending")
async def get_pending_permissions(
    thread_id: str,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    _user_id, org_id = auth
    await threads.fetch_thread(thread_id, org_id)
    found = await permissions.pending_for_thread(thread_id, org_id)
    return {"request": found[0] if found else None, "count": len(found)}


@router.get("/context-search")
async def search_context(
    q: str = Query(default="", max_length=200),
    type: str | None = Query(default=None, max_length=30),
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    _user_id, org_id = auth
    return {"results": await context_search.search_context(org_id, q, type)}


async def _busy_stream(thread_id: str, turn_id: str) -> AsyncIterator[str]:
    yield format_sse_event(
        "thread_started", {"thread_id": thread_id, "turn_id": turn_id}
    )
    yield format_sse_event(
        "error", {"message": "This thread already has a live turn.", "code": "thread_busy"}
    )


def _streaming_response(generator: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/stream")
async def chat_stream(
    payload: ChatRequest,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> StreamingResponse:
    provider = require_enabled()
    user_id, org_id = auth
    if payload.thread_id:
        thread = await threads.fetch_thread(payload.thread_id, org_id)
    else:
        thread = await threads.create_thread(org_id, user_id)
    thread_id = str(thread["id"])
    metadata = payload.metadata.model_dump()
    turn_id = valid_turn_id(metadata.get("client_turn_id"))
    progress_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    stream_open = asyncio.Event()
    stream_open.set()
    context = TurnContext(
        org_id=org_id,
        user_id=user_id,
        thread_id=thread_id,
        turn_id=turn_id,
        metadata=metadata,
        progress_queue=progress_queue,
        cancel_event=asyncio.Event(),
    )
    active = ActiveTurn(thread_id=thread_id, turn_id=turn_id, context=context)
    if not await claim_turn(active):
        return _streaming_response(_busy_stream(thread_id, turn_id))

    try:
        history_result, event_result, every_result = await asyncio.gather(
            threads.load_history(thread_id, org_id),
            threads.current_event_context(org_id),
            every_mcp.connection_status(org_id),
            return_exceptions=True,
        )
        if isinstance(history_result, BaseException):
            raise history_result
        history = history_result
        event = None if isinstance(event_result, BaseException) else event_result
        every_status = (
            {"connected": False}
            if isinstance(every_result, BaseException)
            else every_result
        )
        await threads.persist_user_message(
            thread_id=thread_id,
            org_id=org_id,
            user_id=user_id,
            turn_id=turn_id,
            content=payload.message,
            metadata=metadata,
        )
    except BaseException:
        await release_turn(thread_id, turn_id)
        raise

    system_prompt = build_system_prompt(
        org_id=org_id,
        user_id=user_id,
        metadata=metadata,
        event=event,
        every_connected=bool(every_status.get("connected")),
    )
    full_prompt = threads.format_history(history, payload.message)

    async def completion() -> None:
        accumulated: list[str] = []
        usage: dict[str, Any] = {}
        status = "complete"
        error_message = "The conference assistant could not finish this turn."
        try:
            if provider == "openai":
                from agent.runtime_openai import stream_response
            else:
                from agent.runtime_anthropic import stream_response

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
                    thread_id=thread_id,
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
                        thread_id=thread_id,
                        org_id=org_id,
                        user_message=payload.message,
                        assistant_reply=response_text,
                        prior_history=history,
                        progress_queue=progress_queue,
                        stream_open=stream_open,
                    )
                )
            await progress_queue.put(
                {
                    "type": "stream_done",
                    "status": status,
                    "message_to_user": response_text,
                    "error_message": error_message,
                }
            )
        except asyncio.CancelledError:
            # The harness itself is never cancelled for a client disconnect. If
            # cancellation reaches here, treat it as the explicit stop path.
            response_text = "".join(accumulated).strip()
            if response_text:
                await threads.persist_agent_message(
                    thread_id=thread_id,
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
            await progress_queue.put(
                {
                    "type": "stream_done",
                    "status": "cancelled",
                    "message_to_user": response_text,
                }
            )
        except Exception:  # noqa: BLE001 - convert provider/persistence failure to SSE
            await progress_queue.put(
                {
                    "type": "stream_done",
                    "status": "error",
                    "message_to_user": "".join(accumulated).strip(),
                    "error_message": error_message,
                }
            )
        finally:
            await permissions.deny_pending_for_turn(thread_id, turn_id)
            await release_turn(thread_id, turn_id)

    completion_task = asyncio.create_task(completion())
    active.completion_task = completion_task

    async def event_stream() -> AsyncIterator[str]:
        yield format_sse_event(
            "thread_started", {"thread_id": thread_id, "turn_id": turn_id}
        )
        last_keepalive = time.monotonic()
        try:
            while True:
                now = time.monotonic()
                if now - last_keepalive >= KEEPALIVE_SECONDS:
                    yield format_sse_event("keepalive")
                    last_keepalive = now
                try:
                    event_item = await asyncio.wait_for(
                        progress_queue.get(), timeout=0.5
                    )
                except TimeoutError:
                    continue
                event_type = str(event_item.get("type") or "")
                if event_type == "stream_done":
                    while not progress_queue.empty():
                        trailing = progress_queue.get_nowait()
                        trailing_type = str(trailing.get("type") or "")
                        if trailing_type in PUBLIC_EVENT_TYPES:
                            yield format_sse_event(
                                trailing_type,
                                {key: value for key, value in trailing.items() if key != "type"},
                            )
                    status = event_item.get("status")
                    if status == "cancelled":
                        yield format_sse_event("cancelled")
                    elif status == "error":
                        yield format_sse_event(
                            "error",
                            {"message": event_item.get("error_message") or "Agent error"},
                        )
                    else:
                        yield format_sse_event(
                            "complete",
                            {"message_to_user": event_item.get("message_to_user") or ""},
                        )
                    return
                if event_type in PUBLIC_EVENT_TYPES:
                    yield format_sse_event(
                        event_type,
                        {key: value for key, value in event_item.items() if key != "type"},
                    )
                progress_queue.task_done()
        finally:
            # A CancelledError from client disconnect passes through this
            # generator. Deliberately leave the completion task alive.
            stream_open.clear()

    return _streaming_response(event_stream())


@router.post("/chat/cancel")
async def cancel_chat(
    payload: CancelRequest,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, bool]:
    require_enabled()
    _user_id, org_id = auth
    await threads.fetch_thread(payload.thread_id, org_id)
    await cancel_turn(payload.thread_id, payload.turn_id)
    return {"ok": True}


@router.post("/permission-response")
async def permission_response(
    payload: PermissionResponseRequest,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, bool]:
    require_enabled()
    _user_id, org_id = auth
    await permissions.resolve_permission(payload.request_id, org_id, payload.approved)
    return {"ok": True}


@router.get("/integrations/every")
async def every_status(
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    _user_id, org_id = auth
    return await every_mcp.connection_status(org_id)


@router.post("/integrations/every/connect")
async def connect_every(
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, str]:
    require_enabled()
    user_id, org_id = auth
    return {"authorize_url": await every_mcp.begin_connect(org_id, user_id)}


@router.get("/integrations/every/callback")
async def every_callback(code: str, state: str) -> RedirectResponse:
    require_enabled()
    await every_mcp.finish_callback(code, state)
    return RedirectResponse(url="/settings?every=connected", status_code=302)


@router.post("/integrations/every/disconnect")
async def disconnect_every(
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, bool]:
    require_enabled()
    _user_id, org_id = auth
    await every_mcp.disconnect(org_id)
    return {"ok": True}
