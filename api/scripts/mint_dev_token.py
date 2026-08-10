#!/usr/bin/env python3
"""Print a dev JWT the backend will accept.

This is how we authenticate the organizer surface until Clerk lands. Clerk's
`supabase` JWT template mints the identical shape (HS256, aud=authenticated,
sub + org_id), so nothing in auth.py changes at swap time.

    python scripts/mint_dev_token.py
    curl -H "Authorization: Bearer $(python scripts/mint_dev_token.py)" \\
         http://localhost:8000/api/events
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from dotenv import load_dotenv

API_DIR = Path(__file__).resolve().parent.parent


def mint_dev_token(
    *,
    org: str = "org_dev",
    sub: str = "dev_user",
    hours: int = 24,
    secret: str | None = None,
    now: datetime | None = None,
) -> str:
    """Return a dev JWT in the same shape used by the organizer surface."""
    load_dotenv(API_DIR / ".env")

    signing_secret = secret or os.getenv("SUPABASE_JWT_SECRET")
    if not signing_secret:
        raise RuntimeError("SUPABASE_JWT_SECRET is not set (api/.env)")

    issued_at = now or datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": sub,
            "org_id": org,
            "aud": "authenticated",
            "role": "authenticated",
            "iat": issued_at,
            "exp": issued_at + timedelta(hours=hours),
        },
        signing_secret,
        algorithm="HS256",
    )


def main() -> int:
    load_dotenv(API_DIR / ".env")

    parser = argparse.ArgumentParser(description="Mint a dev JWT for the dais API")
    parser.add_argument("--sub", default="dev_user", help="user id (sub claim)")
    parser.add_argument("--org", default="org_dev", help="org id (org_id claim)")
    parser.add_argument("--hours", type=int, default=24, help="lifetime in hours")
    args = parser.parse_args()

    try:
        token = mint_dev_token(org=args.org, sub=args.sub, hours=args.hours)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
