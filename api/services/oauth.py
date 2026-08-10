"""OAuth 2.1 persistence and opaque-token handling for the hosted MCP server.

All bearer credentials and authorization codes are high-entropy opaque values.
Only SHA-256 hashes are persisted, mirroring organization API-token storage.
The authorization server is intentionally public-client-only: dynamically
registered MCP clients authenticate with PKCE, never a client secret.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from services.magic_links import hash_token
from services.supabase_helpers import db, first
from supabase_client import supabase

AUTHORIZATION_CODE_TTL = timedelta(minutes=10)
ACCESS_TOKEN_TTL = timedelta(hours=1)
REFRESH_TOKEN_TTL = timedelta(days=30)

CLIENT_ID_PREFIX = "sw_client_"
AUTHORIZATION_CODE_PREFIX = "sw_code_"
ACCESS_TOKEN_PREFIX = "sw_access_"
REFRESH_TOKEN_PREFIX = "sw_refresh_"

_PKCE_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_PKCE_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


class InvalidGrantError(ValueError):
    """An authorization code or refresh token cannot be exchanged."""


def public_origin(request: Any) -> str:
    """Return the canonical public origin used by OAuth metadata and challenges.

    PUBLIC_APP_URL is authoritative, FRONTEND_URL is its deployment-friendly
    fallback, and the request origin keeps local/self-hosted installs working
    without extra configuration. Paths in configured URLs are deliberately
    discarded because an OAuth issuer here is the same-origin server root.
    """
    configured = os.getenv("PUBLIC_APP_URL") or os.getenv("FRONTEND_URL")
    candidate = configured or str(request.base_url)
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError("PUBLIC_APP_URL or FRONTEND_URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password:
        raise RuntimeError("Public application URL must not contain user information")
    return f"{parsed.scheme.lower()}://{parsed.netloc}"


def mcp_resource_url(request: Any) -> str:
    return f"{public_origin(request)}/mcp"


def _now(value: datetime | None = None) -> datetime:
    current = value or datetime.now(timezone.utc)
    return current if current.tzinfo else current.replace(tzinfo=timezone.utc)


def _parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def generate_client_id() -> str:
    return f"{CLIENT_ID_PREFIX}{secrets.token_urlsafe(24)}"


def valid_code_challenge(value: str) -> bool:
    return bool(_PKCE_CHALLENGE_RE.fullmatch(value or ""))


def _pkce_matches(verifier: str, challenge: str) -> bool:
    if not _PKCE_VERIFIER_RE.fullmatch(verifier or ""):
        return False
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    actual = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return secrets.compare_digest(actual, challenge)


async def register_client(redirect_uris: list[str], name: str) -> dict[str, Any]:
    """Register a public OAuth client and return its stored metadata."""
    client_id = generate_client_id()
    created = first(
        await db(
            lambda: supabase.table("oauth_clients")
            .insert(
                {
                    "client_id": client_id,
                    "redirect_uris": redirect_uris,
                    "name": name,
                }
            )
            .execute(),
            "oauth_register_client",
        )
    )
    if not created:
        raise RuntimeError("Could not register OAuth client")
    return created


async def get_client(client_id: str) -> dict[str, Any] | None:
    return first(
        await db(
            lambda: supabase.table("oauth_clients")
            .select("client_id, redirect_uris, name, created_at")
            .eq("client_id", client_id)
            .limit(1)
            .execute(),
            "oauth_get_client",
        )
    )


async def mint_authorization_code(
    *,
    client_id: str,
    org_id: str,
    redirect_uri: str,
    code_challenge: str,
    now: datetime | None = None,
) -> str:
    """Create a single-use code bound to client, redirect URI, org, and PKCE."""
    current = _now(now)
    raw = f"{AUTHORIZATION_CODE_PREFIX}{secrets.token_urlsafe(48)}"
    created = first(
        await db(
            lambda: supabase.table("oauth_codes")
            .insert(
                {
                    "code_hash": hash_token(raw),
                    "client_id": client_id,
                    "org_id": org_id,
                    "redirect_uri": redirect_uri,
                    "code_challenge": code_challenge,
                    "expires_at": (current + AUTHORIZATION_CODE_TTL).isoformat(),
                }
            )
            .execute(),
            "oauth_mint_code",
        )
    )
    if not created:
        raise RuntimeError("Could not create authorization code")
    return raw


async def _issue_token_pair(
    *, client_id: str, org_id: str, now: datetime
) -> dict[str, Any]:
    access_token = f"{ACCESS_TOKEN_PREFIX}{secrets.token_urlsafe(48)}"
    refresh_token = f"{REFRESH_TOKEN_PREFIX}{secrets.token_urlsafe(48)}"
    created = first(
        await db(
            lambda: supabase.table("oauth_tokens")
            .insert(
                {
                    "token_hash": hash_token(access_token),
                    "refresh_hash": hash_token(refresh_token),
                    "client_id": client_id,
                    "org_id": org_id,
                    "expires_at": (now + ACCESS_TOKEN_TTL).isoformat(),
                    "created_at": now.isoformat(),
                }
            )
            .execute(),
            "oauth_issue_tokens",
        )
    )
    if not created:
        raise RuntimeError("Could not issue OAuth tokens")
    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": int(ACCESS_TOKEN_TTL.total_seconds()),
        "refresh_token": refresh_token,
    }


async def exchange_authorization_code(
    *,
    raw_code: str,
    client_id: str,
    redirect_uri: str,
    code_verifier: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Consume a valid authorization code and issue an access/refresh pair."""
    current = _now(now)
    code_hash = hash_token(raw_code)
    row = first(
        await db(
            lambda: supabase.table("oauth_codes")
            .select(
                "code_hash, client_id, org_id, redirect_uri, code_challenge, "
                "expires_at, used_at"
            )
            .eq("code_hash", code_hash)
            .limit(1)
            .execute(),
            "oauth_code_lookup",
        )
    )
    expires_at = _parse_timestamp(row.get("expires_at")) if row else None
    if (
        not row
        or row.get("used_at") is not None
        or expires_at is None
        or expires_at <= current
        or row.get("client_id") != client_id
        or row.get("redirect_uri") != redirect_uri
        or not _pkce_matches(code_verifier, str(row.get("code_challenge") or ""))
    ):
        raise InvalidGrantError("Authorization code is invalid or expired")

    # The conditional update is the single-use boundary. Concurrent exchanges
    # may both read the code, but only one can transition used_at from NULL.
    consumed = first(
        await db(
            lambda: supabase.table("oauth_codes")
            .update({"used_at": current.isoformat()})
            .eq("code_hash", code_hash)
            .is_("used_at", "null")
            .gt("expires_at", current.isoformat())
            .execute(),
            "oauth_code_consume",
        )
    )
    if not consumed:
        raise InvalidGrantError("Authorization code is invalid or expired")
    return await _issue_token_pair(
        client_id=client_id, org_id=str(row["org_id"]), now=current
    )


async def rotate_refresh_token(
    *, raw_refresh_token: str, client_id: str, now: datetime | None = None
) -> dict[str, Any]:
    """Consume a refresh token, revoke its pair, and return a rotated pair."""
    current = _now(now)
    refresh_hash = hash_token(raw_refresh_token)
    row = first(
        await db(
            lambda: supabase.table("oauth_tokens")
            .select(
                "token_hash, refresh_hash, client_id, org_id, expires_at, "
                "revoked_at, created_at"
            )
            .eq("refresh_hash", refresh_hash)
            .limit(1)
            .execute(),
            "oauth_refresh_lookup",
        )
    )
    created_at = _parse_timestamp(row.get("created_at")) if row else None
    if (
        not row
        or row.get("revoked_at") is not None
        or row.get("client_id") != client_id
        or created_at is None
        or created_at + REFRESH_TOKEN_TTL <= current
    ):
        raise InvalidGrantError("Refresh token is invalid or expired")

    # A row represents one access/refresh pair. Rotation revokes the old pair,
    # which also makes replayed refresh tokens and the superseded access token
    # fail closed without needing a second refresh-expiry column.
    revoked = first(
        await db(
            lambda: supabase.table("oauth_tokens")
            .update({"revoked_at": current.isoformat()})
            .eq("refresh_hash", refresh_hash)
            .is_("revoked_at", "null")
            .execute(),
            "oauth_refresh_revoke",
        )
    )
    if not revoked:
        raise InvalidGrantError("Refresh token is invalid or expired")
    return await _issue_token_pair(
        client_id=client_id, org_id=str(row["org_id"]), now=current
    )


async def resolve_access_token(
    raw_access_token: str | None, *, now: datetime | None = None
) -> str | None:
    """Resolve an active OAuth access token to its trusted organization id."""
    if not raw_access_token or not raw_access_token.startswith(ACCESS_TOKEN_PREFIX):
        return None
    current = _now(now)
    row = first(
        await db(
            lambda: supabase.table("oauth_tokens")
            .select("org_id, expires_at, revoked_at")
            .eq("token_hash", hash_token(raw_access_token))
            .limit(1)
            .execute(),
            "oauth_access_lookup",
        )
    )
    expires_at = _parse_timestamp(row.get("expires_at")) if row else None
    if (
        not row
        or row.get("revoked_at") is not None
        or expires_at is None
        or expires_at <= current
    ):
        return None
    return str(row["org_id"])
