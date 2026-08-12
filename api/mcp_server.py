"""Hosted Model Context Protocol surface for conference integrations.

The MCP server is mounted by :mod:`main` at ``/mcp``. Its HTTP boundary accepts
either the same raw organization API tokens as ``/v1`` or OAuth access tokens
issued by this app, resolves the organization once, then passes only that
trusted organization id to tools and resources.
"""

from __future__ import annotations

import inspect
import json
from typing import Any, Literal
from urllib.parse import urlsplit

# mcp 2.x renamed FastMCP to MCPServer; openai-agents (chat agent's OpenAI lane)
# still pins mcp<2, so both spellings must import cleanly.
try:
    from mcp.server import MCPServer
    from mcp.server.mcpserver import Context
except ImportError:  # mcp < 2
    from mcp.server.fastmcp import Context
    from mcp.server.fastmcp import FastMCP as MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.settings import settings
from services import integration_api
from services.api_keys import resolve_api_key
from services.oauth import public_origin, resolve_access_token

_ORG_HEADER = b"x-dais-resolved-org"

_SERVER_KWARGS: dict[str, Any] = {
    "name": "dais-conference-management",
    "title": "dais Conference Management",
    "description": "Manage an organization's events, submissions, speakers, schedule, content, and evaluations.",
    "instructions": (
        "All results are scoped to the organization attached to the supplied dais API "
        "token. Pass an event id or slug when the organization has multiple events."
    ),
    "version": "1.0.0",
}
# mcp<2 FastMCP does not accept title/description/version; keep whichever
# kwargs the installed SDK understands.
_ACCEPTED = set(inspect.signature(MCPServer.__init__).parameters)
mcp_server = MCPServer(**{k: v for k, v in _SERVER_KWARGS.items() if k in _ACCEPTED})


class ApiTokenAuthMiddleware:
    """Resolve an API/OAuth Bearer token and inject a trusted org downstream."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Under mcp<2 the SDK app's only route is "/", and the parent Mount
        # hands "/mcp" through with an empty path — Starlette then 307s to
        # "/mcp/" using the upstream Host header, which breaks strict clients
        # on the brand domain. Normalize instead of redirecting.
        if scope.get("path", "") in ("", "/mcp"):
            scope = {**scope, "path": "/"}

        authorization = Headers(scope=scope).get("authorization", "")
        scheme, _, raw_token = authorization.partition(" ")
        resolved = None
        if scheme.casefold() == "bearer" and raw_token:
            token = raw_token.strip()
            # Keep the established organization API-token path first and
            # unchanged; connector UIs use the OAuth lookup alongside it.
            resolved = await resolve_api_key(token)
            if not resolved:
                oauth_org_id = await resolve_access_token(token)
                if oauth_org_id:
                    resolved = (oauth_org_id, [])
        if not resolved:
            metadata_url = (
                f'{public_origin(Request(scope))}/.well-known/oauth-protected-resource'
            )
            response = JSONResponse(
                {"detail": "Missing or invalid API token"},
                status_code=401,
                headers={
                    "WWW-Authenticate": (
                        f'Bearer resource_metadata="{metadata_url}"'
                    )
                },
            )
            await response(scope, receive, send)
            return

        org_id, _scopes = resolved
        child_scope = dict(scope)
        # Remove any client-supplied copy before adding the server-resolved value.
        child_scope["headers"] = [
            (key, value)
            for key, value in scope.get("headers", [])
            if key.lower() != _ORG_HEADER
        ] + [(_ORG_HEADER, str(org_id).encode("utf-8"))]
        await self.app(child_scope, receive, send)


def _org_id(ctx: Context) -> str:
    if hasattr(ctx, "headers"):  # mcp >= 2
        headers = ctx.headers or {}
    else:  # mcp < 2: reach the Starlette request through the request context
        request = ctx.request_context.request
        headers = request.headers if request is not None else {}
    org_id = headers.get(_ORG_HEADER.decode("ascii"))
    if not org_id:  # pragma: no cover - guarded by the ASGI auth boundary
        raise PermissionError("Authenticated organization context is unavailable")
    return org_id


async def _event_id(ctx: Context, reference: str | None) -> str:
    event = await integration_api.resolve_event(_org_id(ctx), reference)
    return str(event["id"])


@mcp_server.tool()
async def list_events(ctx: Context) -> dict[str, Any]:
    """List all events available to the authenticated organization."""
    return await integration_api.list_events(
        _org_id(ctx), page=1, page_size=integration_api.MAX_PAGE_SIZE
    )


@mcp_server.tool()
async def list_submissions(
    ctx: Context,
    status: str | None = None,
    track: str | None = None,
    event: str | None = None,
) -> dict[str, Any]:
    """List submissions, optionally filtered by event, workflow status, or track."""
    event_id = await _event_id(ctx, event) if event else None
    return await integration_api.list_submissions(
        _org_id(ctx),
        event_id=event_id,
        status=status,
        track=track,
        page=1,
        page_size=integration_api.MAX_PAGE_SIZE,
    )


@mcp_server.tool()
async def get_submission(ctx: Context, id: str) -> dict[str, Any]:
    """Get one submission by id, including its speakers, track, format, and room."""
    return {"data": await integration_api.get_submission(_org_id(ctx), id)}


@mcp_server.tool()
async def decide_submission(
    ctx: Context,
    id: str,
    decision: str,
    feedback: str | None = None,
) -> dict[str, Any]:
    """Accept, decline, or queue a submission and optionally record feedback."""
    return {
        "data": await integration_api.decide_submission(
            _org_id(ctx), id, decision, feedback
        )
    }


@mcp_server.tool()
async def list_speakers(
    ctx: Context,
    filter: str | None = None,
    event: str | None = None,
) -> dict[str, Any]:
    """List speakers, optionally filtered by event or matching name, email, or company."""
    event_id = await _event_id(ctx, event) if event else None
    return await integration_api.list_speakers(
        _org_id(ctx),
        event_id=event_id,
        filter_text=filter,
        page=1,
        page_size=integration_api.MAX_PAGE_SIZE,
    )


@mcp_server.tool()
async def get_speaker(ctx: Context, id: str) -> dict[str, Any]:
    """Get one speaker, including portal invite status and logistics details."""
    return {"data": await integration_api.get_speaker(_org_id(ctx), id)}


@mcp_server.tool()
async def invite_speaker_to_portal(ctx: Context, id: str) -> dict[str, Any]:
    """Create a speaker portal invite and queue its delivery email."""
    return {"data": await integration_api.invite_speaker_to_portal(_org_id(ctx), id)}


@mcp_server.tool()
async def list_schedule(
    ctx: Context, event: str | None = None
) -> dict[str, Any]:
    """Return an event's full schedule with rooms, tracks, and sessions."""
    event_id = await _event_id(ctx, event)
    return {"data": await integration_api.list_schedule(_org_id(ctx), event_id)}


@mcp_server.tool()
async def place_session(
    ctx: Context, id: str, room: str, start: str
) -> dict[str, Any]:
    """Place a session into a room at an ISO-8601 start time."""
    return {
        "data": await integration_api.place_session(_org_id(ctx), id, room, start)
    }


@mcp_server.tool()
async def unschedule_session(ctx: Context, id: str) -> dict[str, Any]:
    """Remove a session's room and start/end times from the schedule."""
    return {"data": await integration_api.unschedule_session(_org_id(ctx), id)}


@mcp_server.tool()
async def content_status(ctx: Context, event: str) -> dict[str, Any]:
    """Read content status counts and outstanding speakers for an event."""
    event_id = await _event_id(ctx, event)
    return {"data": await integration_api.content_status(_org_id(ctx), event_id)}


@mcp_server.tool()
async def remind_outstanding_content(ctx: Context, event: str) -> dict[str, Any]:
    """Queue deduplicated reminder emails for speakers with outstanding content."""
    event_id = await _event_id(ctx, event)
    return {
        "data": await integration_api.remind_outstanding_content(
            _org_id(ctx), event_id
        )
    }


@mcp_server.tool()
async def reviewer_links(ctx: Context, plan: str) -> dict[str, Any]:
    """Mint a fresh review link for every reviewer on an evaluation plan.

    For handing a committee member back into their scorecard when they have lost
    the email. Links are scoped to one reviewer, expire, and can be revoked;
    previously issued links keep working, so this never locks anyone out.
    """
    return {"data": await integration_api.reviewer_links(_org_id(ctx), plan)}


@mcp_server.tool()
async def evaluation_summary(
    ctx: Context,
    plan: str | None = None,
    event: str | None = None,
) -> dict[str, Any]:
    """Get score results for a plan, or list evaluation plans for an event."""
    if plan:
        return {"data": await integration_api.evaluation_summary(_org_id(ctx), plan)}
    event_id = await _event_id(ctx, event)
    return await integration_api.list_evaluation_plans(
        _org_id(ctx),
        event_id,
        page=1,
        page_size=integration_api.MAX_PAGE_SIZE,
    )


@mcp_server.tool()
async def ai_triage(ctx: Context, plan: str) -> dict[str, Any]:
    """Run the configured AI first-pass triage for an evaluation plan."""
    return {"data": await integration_api.run_ai_triage(_org_id(ctx), plan)}


FontToken = Literal[
    "instrument-sans",
    "instrument-serif",
    "inter",
    "space-grotesk",
    "dm-sans",
    "ibm-plex-sans",
    "figtree",
    "playfair-display",
    "source-serif",
    "lora",
    "jetbrains-mono",
    "ibm-plex-mono",
]
RadiusToken = Literal["none", "small", "medium", "large"]
ScheduleLayout = Literal["list", "tracks", "grid"]
SpeakerLayout = Literal["grid", "list"]
DensityToken = Literal["comfortable", "compact"]
HeaderStyle = Literal["minimal", "banner"]


@mcp_server.tool()
async def get_event_branding(ctx: Context, event: str) -> dict[str, Any]:
    """Get an event's resolved public colors, fonts, assets, and layouts."""
    event_id = await _event_id(ctx, event)
    return {
        "data": await integration_api.get_event_branding(_org_id(ctx), event_id)
    }


@mcp_server.tool()
async def set_event_branding(
    ctx: Context,
    event: str,
    accent: str | None = None,
    background: str | None = None,
    surface: str | None = None,
    ink: str | None = None,
    heading_font: FontToken | None = None,
    body_font: FontToken | None = None,
    radius: RadiusToken | None = None,
    schedule_layout: ScheduleLayout | None = None,
    speaker_layout: SpeakerLayout | None = None,
    density: DensityToken | None = None,
    header_style: HeaderStyle | None = None,
    show_powered_by: bool | None = None,
    reset: list[str] | None = None,
) -> dict[str, Any]:
    """Merge selected branding properties into an event's public identity.

    Color values are six hexadecimal digits without a leading ``#``. Omitted
    properties stay unchanged; to clear one back to its default, name it in
    ``reset`` — an omitted argument and an explicit null are indistinguishable
    in this signature, so clearing needs its own channel.
    """
    event_id = await _event_id(ctx, event)
    values = {
        "accent": accent,
        "background": background,
        "surface": surface,
        "ink": ink,
        "heading_font": heading_font,
        "body_font": body_font,
        "radius": radius,
        "schedule_layout": schedule_layout,
        "speaker_layout": speaker_layout,
        "density": density,
        "header_style": header_style,
        "show_powered_by": show_powered_by,
    }
    patch: dict[str, Any] = {
        key: value for key, value in values.items() if value is not None
    }
    for key in reset or ():
        patch[str(key)] = None
    return {
        "data": await integration_api.update_event_branding(
            _org_id(ctx), event_id, patch
        )
    }


def _resource_json(value: dict[str, Any]) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))


@mcp_server.resource(
    "dais://events/{event}/schedule",
    name="event-schedule",
    description="Complete schedule JSON for one event.",
    mime_type="application/json",
)
async def schedule_resource(event: str, ctx: Context) -> str:
    event_id = await _event_id(ctx, event)
    return _resource_json(await integration_api.list_schedule(_org_id(ctx), event_id))


@mcp_server.resource(
    "dais://events/{event}/speakers",
    name="event-speakers",
    description="Speaker directory JSON for one event.",
    mime_type="application/json",
)
async def speakers_resource(event: str, ctx: Context) -> str:
    event_id = await _event_id(ctx, event)
    return _resource_json(
        await integration_api.list_speakers(
            _org_id(ctx),
            event_id=event_id,
            page=1,
            page_size=integration_api.MAX_PAGE_SIZE,
        )
    )


@mcp_server.resource(
    "dais://events/{event}/content-status",
    name="event-content-status",
    description="Content deliverable status JSON for one event.",
    mime_type="application/json",
)
async def content_status_resource(event: str, ctx: Context) -> str:
    event_id = await _event_id(ctx, event)
    return _resource_json(
        await integration_api.content_status(_org_id(ctx), event_id)
    )


@mcp_server.resource(
    "dais://events/{event}/branding",
    name="event-branding",
    description="Resolved branding JSON for one event.",
    mime_type="application/json",
)
async def branding_resource(event: str, ctx: Context) -> str:
    event_id = await _event_id(ctx, event)
    return _resource_json(
        await integration_api.get_event_branding(_org_id(ctx), event_id)
    )


def _transport_security() -> TransportSecuritySettings:
    public = urlsplit(settings.public_api_url)
    allowed_hosts = [
        "127.0.0.1",
        "127.0.0.1:*",
        "localhost",
        "localhost:*",
        "[::1]",
        "[::1]:*",
        "testserver",
        "testserver:*",
    ]
    if public.netloc:
        allowed_hosts.append(public.netloc)
    allowed_origins = [
        "http://127.0.0.1:*",
        "http://localhost:*",
        "http://[::1]:*",
        *settings.cors_allowed_origins,
    ]
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=list(dict.fromkeys(allowed_hosts)),
        allowed_origins=list(dict.fromkeys(allowed_origins)),
    )


_HTTP_APP_KWARGS: dict[str, Any] = {
    "streamable_http_path": "/",
    "stateless_http": True,
    "json_response": True,
    "transport_security": _transport_security(),
}
if "stateless_http" in inspect.signature(mcp_server.streamable_http_app).parameters:
    _sdk_app = mcp_server.streamable_http_app(**_HTTP_APP_KWARGS)
else:  # mcp<2 reads the same settings from the server object at app-build time
    for _key, _value in _HTTP_APP_KWARGS.items():
        setattr(mcp_server.settings, _key, _value)
    _sdk_app = mcp_server.streamable_http_app()
mcp_app = ApiTokenAuthMiddleware(_sdk_app)
