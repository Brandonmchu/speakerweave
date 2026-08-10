"""Optional Every MCP OAuth client and provider-specific tool bridges."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
import secrets
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import HTTPException

from services.supabase_helpers import db, first
from supabase_client import supabase

EVERY_MCP_KIND = "every_mcp"
OAUTH_STATE_TTL = timedelta(minutes=10)
HTTP_TIMEOUT = httpx.Timeout(15.0, connect=5.0)

McpHandler = Callable[[str, dict[str, Any]], Awaitable[Any]]


@dataclass
class OAuthAttempt:
    org_id: str
    user_id: str
    code_verifier: str
    redirect_uri: str
    client_id: str
    client_secret: str | None
    token_endpoint: str
    created_at: datetime


_OAUTH_ATTEMPTS: dict[str, OAuthAttempt] = {}
_OAUTH_LOCK = asyncio.Lock()


def is_available() -> bool:
    return bool((os.getenv("EVERY_MCP_URL") or "").strip())


def mcp_url() -> str:
    return (os.getenv("EVERY_MCP_URL") or "").strip().rstrip("/")


def _origin(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("EVERY_MCP_URL must be an absolute HTTP(S) URL")
    return f"{parsed.scheme.lower()}://{parsed.netloc}"


def callback_uri() -> str:
    api_url = (os.getenv("PUBLIC_API_URL") or "http://localhost:8000").rstrip("/")
    return f"{api_url}/api/agent/integrations/every/callback"


def registered_redirect_uris() -> list[str]:
    redirect_uris = [callback_uri()]
    public_web = (os.getenv("PUBLIC_WEB_URL") or "").strip().rstrip("/")
    if public_web:
        branded = f"{public_web}/api/agent/integrations/every/callback"
        if branded not in redirect_uris:
            redirect_uris.append(branded)
    return redirect_uris


def _pkce_verifier() -> str:
    # token_urlsafe(64) is within RFC 7636's 43..128 character range.
    return secrets.token_urlsafe(64)


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


async def _stored_config(org_id: str) -> dict[str, Any] | None:
    row = first(
        await db(
            lambda: supabase.table("org_integrations")
            .select("config")
            .eq("org_id", org_id)
            .eq("kind", EVERY_MCP_KIND)
            .limit(1)
            .execute(),
            "every_mcp_config_get",
        )
    )
    config = row.get("config") if row else None
    return dict(config) if isinstance(config, dict) else None


async def _save_config(org_id: str, config: dict[str, Any]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    await db(
        lambda: supabase.table("org_integrations")
        .upsert(
            {
                "org_id": org_id,
                "kind": EVERY_MCP_KIND,
                "config": config,
                "updated_at": now,
            },
            on_conflict="org_id,kind",
        )
        .execute(),
        "every_mcp_config_save",
    )


async def connection_status(org_id: str) -> dict[str, Any]:
    config = await _stored_config(org_id) if is_available() else None
    return {
        "available": is_available(),
        "connected": bool(config and config.get("access_token")),
        "connected_email": (
            str(config.get("connected_email"))
            if config and config.get("connected_email")
            else None
        ),
    }


async def begin_connect(org_id: str, user_id: str) -> str:
    if not is_available():
        raise HTTPException(status_code=404, detail="Every MCP is not configured")
    resource_metadata_url = f"{_origin(mcp_url())}/.well-known/oauth-protected-resource"
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            resource_response = await client.get(resource_metadata_url)
            resource_response.raise_for_status()
            resource = resource_response.json()
            authorization_servers = resource.get("authorization_servers") or []
            authorization_server = (
                authorization_servers[0]
                if authorization_servers
                else resource.get("authorization_server")
            )
            if not authorization_server:
                raise ValueError("Protected-resource metadata has no authorization server")
            metadata_url = (
                f"{str(authorization_server).rstrip('/')}/"
                ".well-known/oauth-authorization-server"
            )
            metadata_response = await client.get(metadata_url)
            metadata_response.raise_for_status()
            metadata = metadata_response.json()
            registration_endpoint = metadata.get("registration_endpoint")
            authorization_endpoint = metadata.get("authorization_endpoint")
            token_endpoint = metadata.get("token_endpoint")
            if not registration_endpoint or not authorization_endpoint or not token_endpoint:
                raise ValueError("Authorization-server metadata is incomplete")
            registration_response = await client.post(
                registration_endpoint,
                json={
                    "client_name": "SpeakerWeave in-app agent",
                    "redirect_uris": registered_redirect_uris(),
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                },
            )
            registration_response.raise_for_status()
            registration = registration_response.json()
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=502, detail=f"Could not start Every authorization: {exc}"
        ) from exc

    client_id = str(registration.get("client_id") or "")
    if not client_id:
        raise HTTPException(status_code=502, detail="Every did not return an OAuth client ID")
    verifier = _pkce_verifier()
    state = secrets.token_urlsafe(32)
    attempt = OAuthAttempt(
        org_id=org_id,
        user_id=user_id,
        code_verifier=verifier,
        redirect_uri=callback_uri(),
        client_id=client_id,
        client_secret=(
            str(registration.get("client_secret"))
            if registration.get("client_secret")
            else None
        ),
        token_endpoint=str(token_endpoint),
        created_at=datetime.now(timezone.utc),
    )
    async with _OAUTH_LOCK:
        _OAUTH_ATTEMPTS[state] = attempt
    query = urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": attempt.redirect_uri,
            "code_challenge": _pkce_challenge(verifier),
            "code_challenge_method": "S256",
            "state": state,
        }
    )
    return f"{authorization_endpoint}?{query}"


async def finish_callback(code: str, state: str) -> None:
    async with _OAUTH_LOCK:
        attempt = _OAUTH_ATTEMPTS.pop(state, None)
    if (
        not attempt
        or attempt.created_at + OAUTH_STATE_TTL <= datetime.now(timezone.utc)
    ):
        raise HTTPException(status_code=400, detail="OAuth state is invalid or expired")
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": attempt.client_id,
        "redirect_uri": attempt.redirect_uri,
        "code_verifier": attempt.code_verifier,
    }
    if attempt.client_secret:
        payload["client_secret"] = attempt.client_secret
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.post(attempt.token_endpoint, data=payload)
            response.raise_for_status()
            token = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=502, detail=f"Could not finish Every authorization: {exc}"
        ) from exc
    access_token = str(token.get("access_token") or "")
    if not access_token:
        raise HTTPException(status_code=502, detail="Every did not return an access token")
    expires_in = int(token.get("expires_in") or 3600)
    await _save_config(
        attempt.org_id,
        {
            "access_token": access_token,
            "refresh_token": token.get("refresh_token"),
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(seconds=expires_in)
            ).isoformat(),
            "client_id": attempt.client_id,
            "client_secret": attempt.client_secret,
            "token_endpoint": attempt.token_endpoint,
            "connected_email": token.get("email") or token.get("connected_email"),
            "connected_user_id": attempt.user_id,
        },
    )


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def access_token(org_id: str) -> str | None:
    config = await _stored_config(org_id)
    if not config or not config.get("access_token"):
        return None
    expires_at = _parse_time(config.get("expires_at"))
    if expires_at and expires_at > datetime.now(timezone.utc) + timedelta(seconds=60):
        return str(config["access_token"])
    refresh_token = str(config.get("refresh_token") or "")
    token_endpoint = str(config.get("token_endpoint") or "")
    client_id = str(config.get("client_id") or "")
    if not refresh_token or not token_endpoint or not client_id:
        return None
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    }
    if config.get("client_secret"):
        payload["client_secret"] = str(config["client_secret"])
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.post(token_endpoint, data=payload)
            response.raise_for_status()
            refreshed = response.json()
    except (httpx.HTTPError, ValueError):
        return None
    new_access_token = str(refreshed.get("access_token") or "")
    if not new_access_token:
        return None
    next_config = {
        **config,
        "access_token": new_access_token,
        "refresh_token": refreshed.get("refresh_token") or refresh_token,
        "expires_at": (
            datetime.now(timezone.utc)
            + timedelta(seconds=int(refreshed.get("expires_in") or 3600))
        ).isoformat(),
    }
    await _save_config(org_id, next_config)
    return new_access_token


async def disconnect(org_id: str) -> None:
    await db(
        lambda: supabase.table("org_integrations")
        .delete()
        .eq("org_id", org_id)
        .eq("kind", EVERY_MCP_KIND)
        .execute(),
        "every_mcp_disconnect",
    )


def _safe_tool_name(name: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_]", "_", name).strip("_")
    return normalized or "tool"


def _definition(name: str, description: str | None, schema: Any) -> dict[str, Any]:
    return {
        "name": f"every_{_safe_tool_name(name)}",
        "description": description or "Use the connected Every workspace.",
        "input_schema": dict(schema or {"type": "object", "properties": {}}),
    }


def _serializable_result(result: Any) -> Any:
    if hasattr(result, "model_dump"):
        return result.model_dump(mode="json")
    if hasattr(result, "dict"):
        return result.dict()
    return result


async def openai_tools(
    stack: AsyncExitStack,
    org_id: str,
    progress_queue: asyncio.Queue[dict[str, Any]],
) -> tuple[list[dict[str, Any]], McpHandler | None]:
    """Attach openai-agents' Streamable HTTP client and namespace its tools."""
    token = await access_token(org_id) if is_available() else None
    if not token:
        return [], None
    try:
        # Lazy: a keyless/disabled deployment never imports the agents SDK.
        from agents.mcp import MCPServerStreamableHttp

        server = MCPServerStreamableHttp(
            params={
                "url": mcp_url(),
                "headers": {"Authorization": f"Bearer {token}"},
            },
            cache_tools_list=True,
            name="Every",
        )
        await stack.enter_async_context(server)
        listed = await server.list_tools()
        original_by_safe = {_safe_tool_name(tool.name): tool.name for tool in listed}
        definitions = [
            _definition(tool.name, tool.description, tool.inputSchema) for tool in listed
        ]

        async def invoke(name: str, arguments: dict[str, Any]) -> Any:
            original = original_by_safe.get(name, name)
            return _serializable_result(await server.call_tool(original, arguments))

        return definitions, invoke
    except Exception:  # noqa: BLE001 - one optional integration must not block chat
        await progress_queue.put(
            {
                "type": "progress",
                "message": "Every is connected, but its tools are temporarily unavailable.",
            }
        )
        return [], None


async def anthropic_tools(
    stack: AsyncExitStack,
    org_id: str,
    progress_queue: asyncio.Queue[dict[str, Any]],
) -> tuple[list[dict[str, Any]], McpHandler | None]:
    """Attach the MCP Python SDK bridge used by the Anthropic lane."""
    token = await access_token(org_id) if is_available() else None
    if not token:
        return [], None
    try:
        # Lazy for deployments that never select the Anthropic/MCP lane.
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        read_stream, write_stream, _session_id = await stack.enter_async_context(
            streamablehttp_client(
                mcp_url(), headers={"Authorization": f"Bearer {token}"}
            )
        )
        session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
        await session.initialize()
        listed_result = await session.list_tools()
        listed = list(getattr(listed_result, "tools", []) or [])
        original_by_safe = {_safe_tool_name(tool.name): tool.name for tool in listed}
        definitions = [
            _definition(tool.name, tool.description, tool.inputSchema) for tool in listed
        ]

        async def invoke(name: str, arguments: dict[str, Any]) -> Any:
            original = original_by_safe.get(name, name)
            return _serializable_result(await session.call_tool(original, arguments))

        return definitions, invoke
    except Exception:  # noqa: BLE001 - one optional integration must not block chat
        await progress_queue.put(
            {
                "type": "progress",
                "message": "Every is connected, but its tools are temporarily unavailable.",
            }
        )
        return [], None
