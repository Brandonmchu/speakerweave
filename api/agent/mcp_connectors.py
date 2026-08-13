"""Organization-scoped MCP connector catalog, OAuth, and runtime bridges."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import re
import secrets
import unicodedata
from collections.abc import Awaitable, Callable, Mapping
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import HTTPException

from services.supabase_helpers import db, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

MCP_CONNECTOR_PROVIDER = "mcp_connector"
MCP_CONNECTOR_KIND_PREFIX = f"{MCP_CONNECTOR_PROVIDER}:"
OAUTH_STATE_TTL = timedelta(minutes=10)
VALIDATION_TIMEOUT_SECONDS = 10.0
HTTP_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
# Partner MCP servers may hold a gated tool call open while a human approves it
# out-of-band (Every's admin-mcp waits ~30s and expects the client to survive).
# The SDK's 5-second default was killing those calls mid-approval.
MCP_HTTP_TIMEOUT_SECONDS = 60.0
MCP_SSE_READ_TIMEOUT_SECONDS = 120.0
MCP_TOOL_CALL_TIMEOUT_SECONDS = 90.0


def _tool_call_timeout_result(exposed_name: str) -> dict[str, Any]:
    return {
        "error": (
            f"{exposed_name} did not respond within "
            f"{int(MCP_TOOL_CALL_TIMEOUT_SECONDS)} seconds. If this action needs "
            "approval in the connected app, approve it there and ask me to retry."
        ),
        "timed_out": True,
    }

# Adding a preset is one catalog entry. Its endpoint remains deployment config,
# while connection state and credentials remain organization-owned rows.
PRESET_DEFINITIONS: tuple[dict[str, str], ...] = (
    {
        "key": "every",
        "name": "Every",
        "url_env": "EVERY_MCP_URL",
        "auth_kind": "oauth",
        "description": "Business tools: proposals, invoices, clients",
    },
)

McpHandler = Callable[[str, dict[str, Any]], Awaitable[Any]]


class ConnectorValidationError(ValueError):
    """A custom connector could not complete initialize + tools/list."""


@dataclass
class OAuthAttempt:
    org_id: str
    user_id: str
    connector_key: str
    code_verifier: str
    redirect_uri: str
    client_id: str
    client_secret: str | None
    token_endpoint: str
    created_at: datetime


_OAUTH_ATTEMPTS: dict[str, OAuthAttempt] = {}
_OAUTH_LOCK = asyncio.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def _hash_state(state: str) -> str:
    return hashlib.sha256(state.encode("utf-8")).hexdigest()


def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode("ascii").rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).decode("ascii").rstrip("=")
    return verifier, challenge


def _parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def validate_url(value: str) -> str:
    """Require HTTPS, except for explicit loopback development endpoints."""
    cleaned = value.strip().rstrip("/")
    parsed = urlsplit(cleaned)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("URL must be an absolute MCP endpoint without credentials, query, or fragment")
    loopback = parsed.hostname.casefold() in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise ValueError("MCP server URL must use HTTPS (HTTP is allowed only for localhost)")
    return cleaned


def _origin(url: str) -> str:
    parsed = urlsplit(validate_url(url))
    return f"{parsed.scheme.lower()}://{parsed.netloc}"


def _slug(value: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.casefold()).strip("-")
    return slug or "connector"


def _kind(key: str) -> str:
    return f"{MCP_CONNECTOR_KIND_PREFIX}{key}"


def callback_uri() -> str:
    api_url = (os.getenv("PUBLIC_API_URL") or "http://localhost:8000").rstrip("/")
    return f"{api_url}/api/agent/integrations/mcp/callback"


def registered_redirect_uris() -> list[str]:
    redirect_uris = [callback_uri()]
    public_web = (os.getenv("PUBLIC_WEB_URL") or "").strip().rstrip("/")
    if public_web:
        branded = f"{public_web}/api/agent/integrations/mcp/callback"
        if branded not in redirect_uris:
            redirect_uris.append(branded)
    return redirect_uris


def preset_catalog() -> list[dict[str, Any]]:
    """Resolve deployable presets from the small in-code catalog."""
    presets: list[dict[str, Any]] = []
    for definition in PRESET_DEFINITIONS:
        raw_url = (os.getenv(definition["url_env"]) or "").strip()
        if not raw_url:
            continue
        try:
            url = validate_url(raw_url)
        except ValueError as exc:
            logger.warning("Ignoring invalid %s preset endpoint: %s", definition["key"], exc)
            continue
        presets.append(
            {
                "key": definition["key"],
                "name": definition["name"],
                "url": url,
                "auth_kind": definition["auth_kind"],
                "description": definition["description"],
                "preset": True,
            }
        )
    return presets


def _preset(key: str) -> dict[str, Any] | None:
    return next((item for item in preset_catalog() if item["key"] == key), None)


async def _stored_rows(org_id: str) -> list[dict[str, Any]]:
    result = await db(
        lambda: supabase.table("org_integrations")
        .select("kind, config, updated_at")
        .eq("org_id", org_id)
        .eq("provider", MCP_CONNECTOR_PROVIDER)
        .execute(),
        "mcp_connectors_list",
    )
    return rows(result)


def _effective_config(row: Mapping[str, Any]) -> dict[str, Any]:
    config = row.get("config")
    resolved = dict(config) if isinstance(config, dict) else {}
    key = str(resolved.get("key") or str(row.get("kind") or "").removeprefix(MCP_CONNECTOR_KIND_PREFIX))
    preset = _preset(key)
    if preset:
        resolved = {**resolved, **{field: preset[field] for field in ("key", "name", "url", "auth_kind")}}
    resolved["key"] = key
    return resolved


async def _get_config(org_id: str, key: str) -> dict[str, Any] | None:
    for row in await _stored_rows(org_id):
        config = _effective_config(row)
        if config.get("key") == key:
            return config
    return None


async def _insert_config(org_id: str, config: dict[str, Any]) -> None:
    await db(
        lambda: supabase.table("org_integrations")
        .insert(
            {
                "org_id": org_id,
                "provider": MCP_CONNECTOR_PROVIDER,
                "kind": _kind(str(config["key"])),
                "config": config,
                "updated_at": _now_iso(),
            }
        )
        .execute(),
        "mcp_connector_create",
    )


async def _save_config(org_id: str, config: dict[str, Any]) -> None:
    key = str(config["key"])
    result = await db(
        lambda: supabase.table("org_integrations")
        .update({"config": config, "updated_at": _now_iso()})
        .eq("org_id", org_id)
        .eq("provider", MCP_CONNECTOR_PROVIDER)
        .eq("kind", _kind(key))
        .execute(),
        "mcp_connector_update",
    )
    if not rows(result):
        raise HTTPException(status_code=404, detail="MCP connector not found")


def _has_credentials(config: Mapping[str, Any]) -> bool:
    auth_kind = config.get("auth_kind")
    if auth_kind == "oauth":
        tokens = config.get("tokens")
        return isinstance(tokens, dict) and bool(tokens.get("access_token"))
    if auth_kind == "bearer":
        return bool(config.get("bearer_token"))
    return auth_kind == "none"


def _public(config: Mapping[str, Any], *, preset: bool, description: str | None = None) -> dict[str, Any]:
    status = str(config.get("status") or "disconnected")
    connected = status == "connected" and _has_credentials(config)
    result: dict[str, Any] = {
        "key": str(config.get("key") or ""),
        "name": str(config.get("name") or ""),
        "url": str(config.get("url") or ""),
        "auth_kind": str(config.get("auth_kind") or "none"),
        "preset": preset,
        "connected": connected,
        "status": status,
    }
    if description:
        result["description"] = description
    if config.get("connected_at"):
        result["connected_at"] = config["connected_at"]
    if config.get("last_error"):
        result["last_error"] = str(config["last_error"])
    return result


async def list_connectors(org_id: str) -> list[dict[str, Any]]:
    stored = {_effective_config(row)["key"]: _effective_config(row) for row in await _stored_rows(org_id)}
    merged: list[dict[str, Any]] = []
    preset_keys: set[str] = set()
    for preset in preset_catalog():
        key = str(preset["key"])
        preset_keys.add(key)
        config = stored.get(key) or {
            "key": key,
            "name": preset["name"],
            "url": preset["url"],
            "auth_kind": preset["auth_kind"],
            "status": "disconnected",
        }
        merged.append(_public(config, preset=True, description=str(preset["description"])))
    for key, config in stored.items():
        if key not in preset_keys:
            merged.append(_public(config, preset=False))
    return merged


async def connected_count(org_id: str) -> int:
    return sum(1 for connector in await list_connectors(org_id) if connector["connected"])


async def create_connector(
    org_id: str,
    user_id: str,
    *,
    name: str,
    url: str,
    auth_kind: str,
    bearer_token: str | None,
) -> tuple[dict[str, Any], str | None]:
    clean_name = name.strip()
    if not 1 <= len(clean_name) <= 50:
        raise ValueError("Name must be between 1 and 50 characters")
    clean_url = validate_url(url)
    if auth_kind not in {"oauth", "bearer", "none"}:
        raise ValueError("Unsupported authentication type")
    token = (bearer_token or "").strip()
    if auth_kind == "bearer" and not token:
        raise ValueError("Bearer token is required")

    occupied = {str(row.get("key")) for row in await list_connectors(org_id)}
    occupied.update(str(item["key"]) for item in PRESET_DEFINITIONS)
    base_key = _slug(clean_name)
    key = base_key
    suffix = 2
    while key in occupied:
        key = f"{base_key}-{suffix}"
        suffix += 1

    headers = {"Authorization": f"Bearer {token}"} if auth_kind == "bearer" else {}
    if auth_kind != "oauth":
        try:
            await validate_connection(clean_url, headers)
        except Exception as exc:
            raise ConnectorValidationError(f"MCP validation failed: {exc}") from exc

    config: dict[str, Any] = {
        "key": key,
        "name": clean_name,
        "url": clean_url,
        "auth_kind": auth_kind,
        "status": "disconnected" if auth_kind == "oauth" else "connected",
        "connected_at": None if auth_kind == "oauth" else _now_iso(),
        "last_error": None,
        "tokens": {},
        "bearer_token": token if auth_kind == "bearer" else None,
    }
    await _insert_config(org_id, config)
    authorize_url = await begin_connect(org_id, user_id, key) if auth_kind == "oauth" else None
    return _public(config, preset=False), authorize_url


async def delete_connector(org_id: str, key: str) -> None:
    result = await db(
        lambda: supabase.table("org_integrations")
        .delete()
        .eq("org_id", org_id)
        .eq("provider", MCP_CONNECTOR_PROVIDER)
        .eq("kind", _kind(key))
        .execute(),
        "mcp_connector_delete",
    )
    if not rows(result):
        raise HTTPException(status_code=404, detail="MCP connector not found")


async def validate_connection(url: str, headers: Mapping[str, str]) -> None:
    """Perform a bounded MCP initialize and tools/list validation."""

    async def ping() -> None:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        async with streamablehttp_client(url, headers=dict(headers)) as streams:
            read_stream, write_stream, _session_id = streams
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                await session.list_tools()

    await asyncio.wait_for(ping(), timeout=VALIDATION_TIMEOUT_SECONDS)


async def _discover_and_register(url: str) -> tuple[str, str, str, str | None]:
    resource_metadata_url = f"{_origin(url)}/.well-known/oauth-protected-resource"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resource_response = await client.get(resource_metadata_url)
        resource_response.raise_for_status()
        resource = resource_response.json()
        authorization_servers = resource.get("authorization_servers") or []
        authorization_server = authorization_servers[0] if authorization_servers else resource.get("authorization_server")
        if not authorization_server:
            raise ValueError("Protected-resource metadata has no authorization server")
        metadata_url = f"{str(authorization_server).rstrip('/')}/.well-known/oauth-authorization-server"
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
    client_id = str(registration.get("client_id") or "")
    if not client_id:
        raise ValueError("OAuth server did not return a client ID")
    client_secret = str(registration["client_secret"]) if registration.get("client_secret") else None
    return str(authorization_endpoint), str(token_endpoint), client_id, client_secret


async def begin_connect(org_id: str, user_id: str, key: str) -> str:
    config = await _get_config(org_id, key)
    if config is None:
        preset = _preset(key)
        if not preset:
            raise HTTPException(status_code=404, detail="MCP connector not found")
        config = {
            "key": key,
            "name": preset["name"],
            "url": preset["url"],
            "auth_kind": preset["auth_kind"],
            "status": "disconnected",
            "connected_at": None,
            "last_error": None,
            "tokens": {},
            "bearer_token": None,
        }
        await _insert_config(org_id, config)
    if config.get("auth_kind") != "oauth":
        raise HTTPException(status_code=409, detail="This MCP connector does not use OAuth")

    try:
        authorization_endpoint, token_endpoint, client_id, client_secret = await _discover_and_register(str(config["url"]))
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        failed = {**config, "status": "error", "last_error": str(exc)}
        await _save_config(org_id, failed)
        raise HTTPException(status_code=502, detail=f"Could not start MCP authorization: {exc}") from exc

    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(40)
    attempt = OAuthAttempt(
        org_id=org_id,
        user_id=user_id,
        connector_key=key,
        code_verifier=verifier,
        redirect_uri=callback_uri(),
        client_id=client_id,
        client_secret=client_secret,
        token_endpoint=token_endpoint,
        created_at=_now(),
    )
    async with _OAUTH_LOCK:
        _OAUTH_ATTEMPTS[_hash_state(state)] = attempt
    query = urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": attempt.redirect_uri,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
    )
    return f"{authorization_endpoint}?{query}"


async def finish_callback(code: str, state: str) -> str:
    async with _OAUTH_LOCK:
        attempt = _OAUTH_ATTEMPTS.pop(_hash_state(state), None)
    if not attempt or attempt.created_at + OAUTH_STATE_TTL <= _now():
        raise HTTPException(status_code=400, detail="OAuth state is invalid or expired")
    config = await _get_config(attempt.org_id, attempt.connector_key)
    if not config:
        raise HTTPException(status_code=404, detail="MCP connector not found")
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
        access_token = str(token.get("access_token") or "")
        if not access_token:
            raise ValueError("OAuth server did not return an access token")
        expires_in = int(token.get("expires_in") or 3600)
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        failed = {**config, "status": "error", "last_error": str(exc)}
        await _save_config(attempt.org_id, failed)
        raise HTTPException(status_code=502, detail=f"Could not finish MCP authorization: {exc}") from exc
    connected_at = _now_iso()
    next_config = {
        **config,
        "status": "connected",
        "connected_at": connected_at,
        "last_error": None,
        "tokens": {
            "access_token": access_token,
            "refresh_token": token.get("refresh_token"),
            "expires_at": (_now() + timedelta(seconds=expires_in)).isoformat(),
            "token_endpoint": attempt.token_endpoint,
            "client_id": attempt.client_id,
            "client_secret": attempt.client_secret,
        },
    }
    await _save_config(attempt.org_id, next_config)
    return attempt.connector_key


async def _oauth_access_token(org_id: str, config: dict[str, Any]) -> str | None:
    tokens_value = config.get("tokens")
    tokens = dict(tokens_value) if isinstance(tokens_value, dict) else {}
    current = str(tokens.get("access_token") or "")
    if not current:
        return None
    expires_at = _parse_time(tokens.get("expires_at"))
    if not expires_at or expires_at > _now() + timedelta(seconds=60):
        return current
    refresh_token = str(tokens.get("refresh_token") or "")
    token_endpoint = str(tokens.get("token_endpoint") or "")
    client_id = str(tokens.get("client_id") or "")
    if not refresh_token or not token_endpoint or not client_id:
        config.update({"status": "error", "last_error": "OAuth authorization must be renewed"})
        await _save_config(org_id, config)
        return None
    payload = {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id}
    if tokens.get("client_secret"):
        payload["client_secret"] = str(tokens["client_secret"])
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.post(token_endpoint, data=payload)
            response.raise_for_status()
            refreshed = response.json()
        access_token = str(refreshed.get("access_token") or "")
        if not access_token:
            raise ValueError("OAuth refresh did not return an access token")
        next_config = {
            **config,
            "status": "connected",
            "last_error": None,
            "tokens": {
                **tokens,
                "access_token": access_token,
                "refresh_token": refreshed.get("refresh_token") or refresh_token,
                "expires_at": (_now() + timedelta(seconds=int(refreshed.get("expires_in") or 3600))).isoformat(),
            },
        }
        config.update(next_config)
        await _save_config(org_id, next_config)
        return access_token
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        config.update({"status": "error", "last_error": f"Token refresh failed: {exc}"})
        await _save_config(org_id, config)
        return None


async def _runtime_configs(org_id: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for row in await _stored_rows(org_id):
        config = _effective_config(row)
        if config.get("status") not in {"connected", "error"} or not _has_credentials(config):
            continue
        found.append(config)
    return found


async def _headers(org_id: str, config: dict[str, Any]) -> dict[str, str]:
    if config.get("auth_kind") == "oauth":
        token = await _oauth_access_token(org_id, config)
        if not token:
            raise RuntimeError("OAuth authorization must be renewed")
        return {"Authorization": f"Bearer {token}"}
    if config.get("auth_kind") == "bearer":
        return {"Authorization": f"Bearer {config['bearer_token']}"}
    return {}


def _safe_tool_name(name: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_-]", "_", name).strip("_")
    return normalized or "tool"


def _definition(key: str, connector_name: str, tool: Any) -> dict[str, Any]:
    # mcp 1.x exposes Tool.inputSchema; 2.x renamed it to input_schema. Our
    # requirement spans both (see requirements.txt), so probe for either.
    schema = getattr(tool, "inputSchema", None)
    if schema is None:
        schema = getattr(tool, "input_schema", None)
    return {
        "name": f"mcp__{key}__{_safe_tool_name(str(tool.name))}",
        "description": tool.description or f"Use the connected {connector_name} MCP server.",
        "input_schema": dict(schema or {"type": "object", "properties": {}}),
        "connector_name": connector_name,
    }


def _serializable_result(result: Any) -> Any:
    if hasattr(result, "model_dump"):
        return result.model_dump(mode="json")
    if hasattr(result, "dict"):
        return result.dict()
    return result


async def _record_runtime_result(org_id: str, config: dict[str, Any], error: Exception | None) -> None:
    desired = "error" if error else "connected"
    message = str(error)[:500] if error else None
    if config.get("status") == desired and config.get("last_error") == message:
        return
    try:
        await _save_config(org_id, {**config, "status": desired, "last_error": message})
    except Exception:
        logger.warning("Could not persist MCP connector health for %s", config.get("key"), exc_info=True)


async def openai_tools(
    stack: AsyncExitStack,
    org_id: str,
    progress_queue: asyncio.Queue[dict[str, Any]],
) -> tuple[list[dict[str, Any]], McpHandler | None]:
    """Attach every healthy connector independently through openai-agents."""
    from agents.mcp import MCPServerStreamableHttp

    definitions: list[dict[str, Any]] = []
    handlers: dict[str, tuple[Any, str]] = {}
    for config in await _runtime_configs(org_id):
        key = str(config["key"])
        name = str(config["name"])
        try:
            server = MCPServerStreamableHttp(
                params={
                    "url": str(config["url"]),
                    "headers": await _headers(org_id, config),
                    "timeout": MCP_HTTP_TIMEOUT_SECONDS,
                    "sse_read_timeout": MCP_SSE_READ_TIMEOUT_SECONDS,
                },
                cache_tools_list=True,
                name=name,
            )
            await stack.enter_async_context(server)
            for tool in await server.list_tools():
                definition = _definition(key, name, tool)
                definitions.append(definition)
                handlers[str(definition["name"])] = (server, str(tool.name))
            await _record_runtime_result(org_id, config, None)
        except Exception as exc:
            logger.warning("Failed to attach MCP connector %s: %s", key, exc, exc_info=True)
            await _record_runtime_result(org_id, config, exc)
            await progress_queue.put({"type": "progress", "message": f"Couldn't reach {name} — continuing without it"})

    async def invoke(exposed_name: str, arguments: dict[str, Any]) -> Any:
        server, original_name = handlers[exposed_name]
        try:
            result = await asyncio.wait_for(
                server.call_tool(original_name, arguments),
                timeout=MCP_TOOL_CALL_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            return _tool_call_timeout_result(exposed_name)
        except Exception as exc:  # noqa: BLE001 - one connector fault stays one tool error
            logger.warning("MCP tool %s failed", exposed_name, exc_info=True)
            return {"error": str(exc)}
        return _serializable_result(result)

    return definitions, (invoke if handlers else None)


async def anthropic_tools(
    stack: AsyncExitStack,
    org_id: str,
    progress_queue: asyncio.Queue[dict[str, Any]],
) -> tuple[list[dict[str, Any]], McpHandler | None]:
    """Attach every healthy connector independently through the MCP SDK."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    definitions: list[dict[str, Any]] = []
    handlers: dict[str, tuple[Any, str]] = {}
    for config in await _runtime_configs(org_id):
        key = str(config["key"])
        name = str(config["name"])
        try:
            read_stream, write_stream, _session_id = await stack.enter_async_context(
                streamablehttp_client(
                    str(config["url"]),
                    headers=await _headers(org_id, config),
                    timeout=MCP_HTTP_TIMEOUT_SECONDS,
                    sse_read_timeout=MCP_SSE_READ_TIMEOUT_SECONDS,
                )
            )
            session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
            await session.initialize()
            listed_result = await session.list_tools()
            for tool in list(getattr(listed_result, "tools", []) or []):
                definition = _definition(key, name, tool)
                definitions.append(definition)
                handlers[str(definition["name"])] = (session, str(tool.name))
            await _record_runtime_result(org_id, config, None)
        except Exception as exc:
            logger.warning("Failed to attach MCP connector %s: %s", key, exc, exc_info=True)
            await _record_runtime_result(org_id, config, exc)
            await progress_queue.put({"type": "progress", "message": f"Couldn't reach {name} — continuing without it"})

    async def invoke(exposed_name: str, arguments: dict[str, Any]) -> Any:
        session, original_name = handlers[exposed_name]
        try:
            result = await asyncio.wait_for(
                session.call_tool(original_name, arguments),
                timeout=MCP_TOOL_CALL_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            return _tool_call_timeout_result(exposed_name)
        except Exception as exc:  # noqa: BLE001 - one connector fault stays one tool error
            logger.warning("MCP tool %s failed", exposed_name, exc_info=True)
            return {"error": str(exc)}
        return _serializable_result(result)

    return definitions, (invoke if handlers else None)
