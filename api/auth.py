"""Organizer auth: HS256 Supabase-shaped JWTs.

Tokens are signed with SUPABASE_JWT_SECRET, aud="authenticated", and carry
`sub` (user id) + `org_id`. Today they come from scripts/mint_dev_token.py;
later Clerk's `supabase` JWT template mints the exact same shape, so nothing
here changes when Clerk lands.

The backend uses the Supabase service-role key and therefore BYPASSES RLS.
org isolation is this file's contract plus an org predicate on every query:
fetch -> verify_org_access -> 404.
"""

from __future__ import annotations

import logging
import os
import time

import jwt
from dotenv import load_dotenv
from fastapi import HTTPException, Request

load_dotenv()

logger = logging.getLogger(__name__)


def verify_token(token: str) -> dict | None:
    """Verify a JWT. Returns claims, or None when the token is unusable."""
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    if not secret:
        raise HTTPException(status_code=500, detail="SUPABASE_JWT_SECRET is not configured")
    try:
        return jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience="authenticated",
            # 30s leeway: client clocks drift, and a freshly minted token whose
            # iat is a hair in the future must not 401.
            # `require` fails closed on a token that omits exp (would never
            # expire) or sub (no user to scope to) rather than trusting it.
            options={
                "verify_exp": True,
                "verify_iat": True,
                "require": ["exp", "sub"],
            },
            leeway=30,
        )
    except jwt.ExpiredSignatureError:
        logger.info("auth: token expired")
    except jwt.InvalidTokenError as exc:
        logger.info("auth: invalid token: %s", exc)
    return None


async def get_current_user_and_org(request: Request) -> tuple[str, str]:
    """FastAPI dependency -> (user_id, org_id). Raises 401 otherwise.

    Usage:
        @router.get("/events")
        async def list_events(auth: tuple = Depends(get_current_user_and_org)):
            user_id, org_id = auth

    HS256 verification is pure CPU (microseconds) and touches no I/O, so it
    runs inline — no threadpool hop needed.
    """
    header = request.headers.get("Authorization") or ""
    token = header[7:].strip() if header.startswith("Bearer ") else header.strip()
    if not token:
        raise HTTPException(status_code=401, detail="Authorization header missing")

    claims = verify_token(token)
    if not claims:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")

    org_id = claims.get("org_id")
    if not org_id:
        # Expected briefly right after signup, before the org claim propagates.
        logger.info("auth: authed user has no org_id claim user_id=%s", user_id)
        raise HTTPException(status_code=401, detail="Organization ID not found in token")

    await _ensure_org_exists(org_id)
    return user_id, org_id


async def get_current_user_or_api_org(request: Request) -> tuple[str, str]:
    """Accept an organizer JWT or an organization API token.

    Most ``/api`` routes deliberately remain JWT-only. A small set of
    organizer operations is also exposed to the companion CLI, whose durable
    credential is the same ``x-access-token`` used by ``/v1``. Those routes use
    this dependency and continue to receive the familiar ``(actor_id, org_id)``
    tuple. The synthetic actor id is never used for organization scoping.

    When an API-token header is present it is authoritative: an invalid token
    fails closed instead of falling through to a possibly unrelated JWT.
    """
    if (request.headers.get("x-access-token") or "").strip():
        # Local import avoids coupling the JWT-only path to API-key services at
        # module import time and keeps auth.py free of a circular dependency.
        from deps.api_key_deps import get_api_org

        org_id, _scopes = await get_api_org(request)
        return "api-token", org_id
    return await get_current_user_and_org(request)


# Clerk creates orgs; our orgs table learns about them lazily on first
# authenticated request. Positive-only TTL cache so the upsert isn't per-call.
_ORG_SEEN: dict[str, float] = {}
_ORG_SEEN_TTL = 300.0


async def _ensure_org_exists(org_id: str) -> None:
    now = time.monotonic()
    seen = _ORG_SEEN.get(org_id)
    if seen is not None and now - seen < _ORG_SEEN_TTL:
        return
    from services.supabase_helpers import db  # local import: avoid module cycle
    from supabase_client import supabase

    try:
        await db(
            lambda: supabase.table("orgs").upsert({"org_id": org_id}, on_conflict="org_id").execute(),
            "ensure_org_exists",
        )
        _ORG_SEEN[org_id] = now
    except Exception:
        logger.warning("auth: org upsert failed org_id=%s", org_id, exc_info=True)


def verify_org_access(row: dict | None, org_id: str, resource: str = "Resource") -> dict:
    """Fetch -> verify -> 404. A row from another org is indistinguishable from
    a row that does not exist; never 403 (that leaks existence)."""
    if not row or row.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail=f"{resource} not found")
    return row
