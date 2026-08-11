"""Frozen `/api/agent` HTTP contract and detached streaming harness."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from agent import context_search, mcp_connectors, permissions, service, threads
from agent.events import PUBLIC_EVENT_TYPES, format_sse_event
from auth import get_current_user_or_api_org
from services.oauth import public_origin as oauth_public_origin

router = APIRouter(prefix="/api/agent", tags=["agent"])

# Compatibility exports for callers and frozen tests that historically used
# the router module as the active-turn control surface.
_ACTIVE_TURNS = service._ACTIVE_TURNS
ActiveTurn = service.ActiveTurn
cancel_turn = service.cancel_turn
claim_turn = service.claim_turn
release_turn = service.release_turn
resolve_provider = service.resolve_provider
run_turn = service.run_turn

MAX_MESSAGE_CHARS = 8_000
KEEPALIVE_SECONDS = 15.0


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


class MCPConnectorRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=50)
    url: str = Field(..., min_length=1, max_length=2_000)
    auth_kind: Literal["oauth", "bearer", "none"]
    bearer_token: str | None = Field(default=None, max_length=4_000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Name cannot be blank")
        return cleaned

    @model_validator(mode="after")
    def require_bearer_token(self) -> MCPConnectorRequest:
        if self.auth_kind == "bearer" and not (self.bearer_token or "").strip():
            raise ValueError("Bearer token is required")
        return self


@router.get("/capabilities")
async def capabilities(
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    _user_id, org_id = auth
    enabled = assistant_enabled()
    try:
        connector_count = await mcp_connectors.connected_count(org_id)
    except Exception:  # noqa: BLE001 - capability discovery must degrade closed
        connector_count = 0
    return {
        "assistant": enabled,
        "provider": resolve_provider() if enabled else None,
        "mcp": {"connectors_connected": connector_count, "available": True},
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
    require_enabled()
    user_id, org_id = auth
    if payload.thread_id:
        thread = await threads.fetch_thread(payload.thread_id, org_id)
    else:
        thread = await threads.create_thread(org_id, user_id)
    thread_id = str(thread["id"])
    metadata = payload.metadata.model_dump()
    progress_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def enqueue_event(event: dict[str, Any]) -> None:
        await progress_queue.put(event)

    # The task owns persistence and cleanup and deliberately outlives an SSE
    # reader that disconnects before the turn completes.
    asyncio.create_task(
        run_turn(
            org_id=org_id,
            user_id=user_id,
            thread_id=thread_id,
            message=payload.message,
            metadata=metadata,
            on_event=enqueue_event,
        )
    )

    async def event_stream() -> AsyncIterator[str]:
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
                if event_type in PUBLIC_EVENT_TYPES:
                    yield format_sse_event(
                        event_type,
                        {key: value for key, value in event_item.items() if key != "type"},
                    )
                progress_queue.task_done()
                if event_type in {"complete", "error", "cancelled"}:
                    return
        finally:
            # A CancelledError from client disconnect passes through this
            # generator. Deliberately leave the completion task alive.
            pass

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


@router.get("/integrations/mcp")
async def get_mcp_connectors(
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    _user_id, org_id = auth
    return {"connectors": await mcp_connectors.list_connectors(org_id)}


@router.post("/integrations/mcp")
async def post_mcp_connector(
    payload: MCPConnectorRequest,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, Any]:
    require_enabled()
    user_id, org_id = auth
    try:
        connector, authorize_url = await mcp_connectors.create_connector(
            org_id,
            user_id,
            name=payload.name,
            url=payload.url,
            auth_kind=payload.auth_kind,
            bearer_token=payload.bearer_token,
        )
    except mcp_connectors.ConnectorValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if authorize_url:
        return {"authorize_url": authorize_url}
    return connector


@router.post("/integrations/mcp/{key}/connect")
async def connect_mcp_connector(
    key: str,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, str]:
    require_enabled()
    user_id, org_id = auth
    return {"authorize_url": await mcp_connectors.begin_connect(org_id, user_id, key)}


@router.get("/integrations/mcp/callback")
async def mcp_connector_callback(request: Request, code: str, state: str) -> RedirectResponse:
    require_enabled()
    key = await mcp_connectors.finish_callback(code, state)
    # The callback is served from the API origin; a relative redirect would
    # strand the user there instead of back in the web app.
    origin = oauth_public_origin(request)
    return RedirectResponse(url=f"{origin}/settings?mcp=connected:{key}", status_code=302)


@router.delete("/integrations/mcp/{key}")
async def delete_mcp_connector(
    key: str,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> dict[str, bool]:
    require_enabled()
    _user_id, org_id = auth
    await mcp_connectors.delete_connector(org_id, key)
    return {"ok": True}
