"""OAuth 2.1 authorization server endpoints for hosted MCP connectors."""

from __future__ import annotations

import html
import json
import time
from datetime import datetime
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from security.rate_limiting import RATE_PUBLIC_DEFAULT, RATE_PUBLIC_WRITE, limiter
from services import oauth
from services.api_keys import resolve_api_key

router = APIRouter(tags=["oauth"])

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_MAX_REDIRECT_URIS = 20
_MAX_URI_LENGTH = 2048
_MAX_CLIENT_NAME_LENGTH = 200


def _json(payload: dict[str, Any], status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        payload,
        status_code=status_code,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


def _oauth_error(
    error: str, description: str, *, status_code: int = 400
) -> JSONResponse:
    return _json(
        {"error": error, "error_description": description}, status_code=status_code
    )


def _valid_redirect_uri(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value) > _MAX_URI_LENGTH:
        return False
    try:
        parsed = urlsplit(value)
        _port = parsed.port
    except ValueError:
        return False
    if (
        not parsed.scheme
        or not parsed.netloc
        or not parsed.hostname
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        return False
    hostname = (parsed.hostname or "").casefold()
    if hostname in _LOOPBACK_HOSTS:
        return parsed.scheme.casefold() in {"http", "https"}
    return parsed.scheme.casefold() == "https"


def _redirect_with_params(uri: str, values: dict[str, str]) -> str:
    parsed = urlsplit(uri)
    query = [*parse_qsl(parsed.query, keep_blank_values=True), *values.items()]
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment)
    )


def _query_value(request: Request, key: str, *, required: bool = True) -> str | None:
    value = request.query_params.get(key)
    if value is None or (required and not value):
        return None
    if len(value) > _MAX_URI_LENGTH:
        return None
    return value


def _resource_is_valid(request: Request, resource: str | None) -> bool:
    return resource is None or resource == oauth.mcp_resource_url(request)


async def _validated_authorization_request(
    request: Request,
) -> tuple[dict[str, str | None], dict[str, Any]] | JSONResponse:
    values: dict[str, str | None] = {
        "client_id": _query_value(request, "client_id"),
        "redirect_uri": _query_value(request, "redirect_uri"),
        "response_type": _query_value(request, "response_type"),
        "code_challenge": _query_value(request, "code_challenge"),
        "code_challenge_method": _query_value(request, "code_challenge_method"),
        "state": _query_value(request, "state", required=False),
        "resource": _query_value(request, "resource", required=False),
    }
    required = (
        "client_id",
        "redirect_uri",
        "response_type",
        "code_challenge",
        "code_challenge_method",
    )
    if any(not values[key] for key in required):
        return _oauth_error("invalid_request", "Required authorization parameter is missing")
    if values["response_type"] != "code":
        return _oauth_error("unsupported_response_type", "Only response_type=code is supported")
    if values["code_challenge_method"] != "S256" or not oauth.valid_code_challenge(
        str(values["code_challenge"])
    ):
        return _oauth_error("invalid_request", "A valid S256 PKCE challenge is required")
    if not _resource_is_valid(request, values["resource"]):
        return _oauth_error("invalid_target", "The requested resource is not this MCP server")

    client = await oauth.get_client(str(values["client_id"]))
    registered = client.get("redirect_uris") if client else None
    if not client or not isinstance(registered, list):
        return _oauth_error("invalid_request", "Unknown OAuth client")
    if values["redirect_uri"] not in registered:
        # Never redirect an error to an unregistered URI.
        return _oauth_error("invalid_request", "redirect_uri is not registered for this client")
    return values, client


def _consent_page(
    values: dict[str, str | None], client: dict[str, Any], *, error: str | None = None
) -> HTMLResponse:
    query = {
        key: value
        for key, value in values.items()
        if value is not None
    }
    action = f"/oauth/authorize/decision?{urlencode(query)}"
    client_name = str(client.get("name") or "MCP client")
    error_html = (
        f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    )
    # The pasted API-token bridge keeps OAuth deployable independently from
    # Clerk. A future upgrade can replace this one field with a session-cookie
    # organization picker while preserving the same authorization protocol.
    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SpeakerWeave — Authorize {html.escape(client_name)}</title>
  <style>
    :root {{ color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f7f8fc; color: #172033; }}
    main {{ width: 100%; max-width: 460px; border: 1px solid #dfe3f2; border-radius: 18px; background: white; padding: 32px; box-shadow: 0 18px 50px rgba(28, 39, 78, .10); }}
    .mark {{ width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; background: #4962E2; color: white; font-weight: 750; }}
    h1 {{ margin: 22px 0 8px; font-size: 24px; line-height: 1.25; letter-spacing: -.02em; }}
    p {{ margin: 0; color: #65708a; font-size: 14px; line-height: 1.55; }}
    form {{ margin-top: 26px; }}
    label {{ display: block; margin-bottom: 8px; color: #2b3448; font-size: 13px; font-weight: 700; }}
    input {{ width: 100%; border: 1px solid #cbd2e5; border-radius: 10px; padding: 12px 13px; font: inherit; outline: none; }}
    input:focus {{ border-color: #4962E2; box-shadow: 0 0 0 3px rgba(73, 98, 226, .14); }}
    .help {{ margin-top: 8px; font-size: 12px; }}
    .error {{ margin: 14px 0 -10px; border-radius: 9px; background: #fff0f1; padding: 10px 12px; color: #a62936; }}
    .actions {{ display: flex; gap: 10px; margin-top: 24px; }}
    button {{ flex: 1; border-radius: 10px; padding: 11px 14px; font: inherit; font-weight: 700; cursor: pointer; }}
    .approve {{ border: 1px solid #4962E2; background: #4962E2; color: white; }}
    .deny {{ border: 1px solid #cbd2e5; background: white; color: #3d475d; }}
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">S</div>
    <h1>SpeakerWeave — Authorize {html.escape(client_name)}</h1>
    <p>This connector will be able to use SpeakerWeave for the organization attached to your API token.</p>
    {error_html}
    <form method="post" action="{html.escape(action, quote=True)}">
      <label for="org-token">Organization API token</label>
      <input id="org-token" name="org_token" type="password" autocomplete="off" required autofocus>
      <p class="help">Create or copy one from Settings → API tokens.</p>
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny" formnovalidate>Deny</button>
        <button class="approve" type="submit" name="decision" value="approve">Approve</button>
      </div>
    </form>
  </main>
</body>
</html>"""
    return HTMLResponse(
        document,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@router.get("/.well-known/oauth-protected-resource")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def protected_resource_metadata(request: Request) -> JSONResponse:
    origin = oauth.public_origin(request)
    return JSONResponse(
        {
            "resource": f"{origin}/mcp",
            "authorization_servers": [origin],
            "bearer_methods_supported": ["header"],
        }
    )


@router.get("/.well-known/oauth-authorization-server")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def authorization_server_metadata(request: Request) -> JSONResponse:
    origin = oauth.public_origin(request)
    return JSONResponse(
        {
            "issuer": origin,
            "authorization_endpoint": f"{origin}/oauth/authorize",
            "token_endpoint": f"{origin}/oauth/token",
            "registration_endpoint": f"{origin}/oauth/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
        }
    )


@router.post("/oauth/register", status_code=201)
@limiter.limit(RATE_PUBLIC_WRITE)
async def register_client(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _oauth_error("invalid_client_metadata", "Request body must be JSON")
    if not isinstance(payload, dict):
        return _oauth_error("invalid_client_metadata", "Client metadata must be an object")

    redirect_uris = payload.get("redirect_uris")
    if (
        not isinstance(redirect_uris, list)
        or not redirect_uris
        or len(redirect_uris) > _MAX_REDIRECT_URIS
        or len({uri for uri in redirect_uris if isinstance(uri, str)})
        != len(redirect_uris)
        or any(not _valid_redirect_uri(uri) for uri in redirect_uris)
    ):
        return _oauth_error(
            "invalid_redirect_uri",
            "redirect_uris must contain unique HTTPS or localhost callback URLs",
        )
    auth_method = payload.get("token_endpoint_auth_method", "none")
    if auth_method != "none":
        return _oauth_error(
            "invalid_client_metadata", "Only public clients with auth method none are supported"
        )
    client_name = payload.get("client_name") or payload.get("name") or "MCP client"
    if not isinstance(client_name, str) or not client_name.strip():
        return _oauth_error("invalid_client_metadata", "client_name must be a string")
    client_name = client_name.strip()[:_MAX_CLIENT_NAME_LENGTH]

    client = await oauth.register_client(redirect_uris, client_name)
    created_at = client.get("created_at")
    issued_at = int(time.time())
    if isinstance(created_at, str):
        try:
            issued_at = int(
                datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
            )
        except ValueError:
            pass
    return _json(
        {
            "client_id": client["client_id"],
            "client_id_issued_at": issued_at,
            "client_name": client_name,
            "redirect_uris": redirect_uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        },
        status_code=201,
    )


@router.get("/oauth/authorize")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def authorize(request: Request):
    validated = await _validated_authorization_request(request)
    if isinstance(validated, JSONResponse):
        return validated
    values, client = validated
    return _consent_page(values, client)


@router.post("/oauth/authorize/decision")
@limiter.limit(RATE_PUBLIC_WRITE)
async def authorize_decision(request: Request):
    validated = await _validated_authorization_request(request)
    if isinstance(validated, JSONResponse):
        return validated
    values, client = validated
    form = await request.form()
    decision = str(form.get("decision") or "")
    redirect_uri = str(values["redirect_uri"])
    state = values.get("state")
    if decision == "deny":
        params = {"error": "access_denied"}
        if state is not None:
            params["state"] = state
        return RedirectResponse(
            _redirect_with_params(redirect_uri, params), status_code=302
        )
    if decision != "approve":
        return _oauth_error("invalid_request", "Decision must be approve or deny")

    # This bridge deliberately uses an existing org-scoped API token. It does
    # not couple OAuth to Clerk and never stores or forwards the pasted value.
    resolved = await resolve_api_key(str(form.get("org_token") or "").strip())
    if not resolved:
        return _consent_page(values, client, error="That API token is invalid. Try again.")
    org_id, _scopes = resolved
    code = await oauth.mint_authorization_code(
        client_id=str(values["client_id"]),
        org_id=org_id,
        redirect_uri=redirect_uri,
        code_challenge=str(values["code_challenge"]),
    )
    params = {"code": code}
    if state is not None:
        params["state"] = state
    return RedirectResponse(_redirect_with_params(redirect_uri, params), status_code=302)


@router.post("/oauth/token")
@limiter.limit(RATE_PUBLIC_WRITE)
async def token(request: Request) -> JSONResponse:
    form = await request.form()
    grant_type = str(form.get("grant_type") or "")
    client_id = str(form.get("client_id") or "")
    resource = str(form.get("resource") or "") or None
    if not client_id:
        return _oauth_error("invalid_request", "client_id is required")
    if not _resource_is_valid(request, resource):
        return _oauth_error("invalid_target", "The requested resource is not this MCP server")

    try:
        if grant_type == "authorization_code":
            code = str(form.get("code") or "")
            redirect_uri = str(form.get("redirect_uri") or "")
            code_verifier = str(form.get("code_verifier") or "")
            if not code or not redirect_uri or not code_verifier:
                return _oauth_error(
                    "invalid_request", "code, redirect_uri, and code_verifier are required"
                )
            payload = await oauth.exchange_authorization_code(
                raw_code=code,
                client_id=client_id,
                redirect_uri=redirect_uri,
                code_verifier=code_verifier,
            )
        elif grant_type == "refresh_token":
            refresh_token = str(form.get("refresh_token") or "")
            if not refresh_token:
                return _oauth_error("invalid_request", "refresh_token is required")
            payload = await oauth.rotate_refresh_token(
                raw_refresh_token=refresh_token, client_id=client_id
            )
        else:
            return _oauth_error(
                "unsupported_grant_type",
                "Only authorization_code and refresh_token grants are supported",
            )
    except oauth.InvalidGrantError as exc:
        return _oauth_error("invalid_grant", str(exc))
    return _json(payload)
