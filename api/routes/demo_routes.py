"""Public one-click demo entrance: hand out a short-lived token for the shared demo org.

Deliberate demo affordance — this endpoint is public and mints a working token for a
SINGLE shared demo org (org_dev, the seeded workspace), so a judge or an automated test
can open the fully-seeded app without Clerk sign-up. Never point it at a real org.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, HTTPException, Request

from security.rate_limiting import RATE_PUBLIC_DEFAULT, limiter

router = APIRouter(prefix="/public", tags=["public"])

# The shared demo org whose workspace is fully seeded (see scripts/mint_dev_token.py,
# which mints the identical shape for the same org).
DEMO_ORG_ID = "org_dev"
DEMO_USER_ID = "demo_user"
DEMO_TOKEN_HOURS = 8


def _mint_demo_token(secret: str) -> str:
    """Sign an HS256 Supabase-shaped JWT for the demo org.

    Mirrors scripts/mint_dev_token.py exactly (HS256, aud=authenticated, sub + org_id,
    datetime iat/exp) so auth.verify_token accepts it unchanged.
    """
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": DEMO_USER_ID,
            "org_id": DEMO_ORG_ID,
            "aud": "authenticated",
            "role": "authenticated",
            "iat": now,
            "exp": now + timedelta(hours=DEMO_TOKEN_HOURS),
        },
        secret,
        algorithm="HS256",
    )


@router.get("/demo-token")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def demo_token(request: Request):
    """Return a short-lived demo token: {token} scoped to the shared demo org."""
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    if not secret:
        raise HTTPException(status_code=500, detail="SUPABASE_JWT_SECRET is not configured")
    return {"token": _mint_demo_token(secret)}
