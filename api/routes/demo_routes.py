"""Public one-click demo entrance: hand out a short-lived token for the shared demo org.

Deliberate demo affordance — this endpoint is public and mints a working token for a
SINGLE shared demo org (org_dev, the seeded workspace), so a judge or an automated test
can open the fully-seeded app without Clerk sign-up. Never point it at a real org.

Three products live in this codebase, and until now only one of them had a door.
`/demo-entry/{persona}` opens the other two: a reviewer's scorecard and a speaker's
portal are real surfaces built on magic links, so the demo mints exactly the link an
organizer would have emailed — same purpose, same redemption path, same expiry rules —
for one seeded reviewer and one seeded speaker. Nothing here is a bypass: an invalid
persona 404s, a deployment whose demo workspace was never seeded 404s rather than
handing out a link to nothing, and every link stays scoped to the demo org.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, HTTPException, Request

from security.rate_limiting import RATE_PUBLIC_DEFAULT, limiter
from services import magic_links
from services.supabase_helpers import db, first
from supabase_client import supabase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public", tags=["public"])

# The shared demo org whose workspace is fully seeded (see scripts/mint_dev_token.py,
# which mints the identical shape for the same org).
DEMO_ORG_ID = "org_dev"
DEMO_USER_ID = "demo_user"
DEMO_TOKEN_HOURS = 8

# The two seeded rows the other personas enter as. Both ids are the seeder's own
# deterministic demo UUIDs (scripts/seed_demo.py): contact 2 is Priya Raman, who
# has accepted sessions and an unfinished task list, and evaluator 1 is Dr. Nadia
# Feldman, who has assignments in the open review round. Picking rows with work
# already in them is the point — an empty portal proves nothing.
DEMO_SPEAKER_CONTACT_ID = "dacc0000-0000-0000-0000-000000000002"
DEMO_REVIEWER_EVALUATOR_ID = "dae7e000-0000-0000-0000-000000000001"

# Short enough to be a demo, long enough to read a scorecard without re-entering.
DEMO_LINK_HOURS = 8

DEMO_PERSONAS = ("organizer", "reviewer", "speaker")


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


async def _demo_row_exists(table: str, row_id: str) -> bool:
    """True when the seeded row is present in the demo org.

    Checked before minting so an unseeded deployment answers "no demo speaker
    here" instead of issuing a link that redeems into an empty portal.
    """
    found = await db(
        lambda: supabase.table(table)
        .select("id")
        .eq("id", row_id)
        .eq("org_id", DEMO_ORG_ID)
        .limit(1)
        .execute()
    )
    return first(found) is not None


@router.get("/demo-entry/{persona}")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def demo_entry(request: Request, persona: str):
    """Open the demo as one of its three audiences.

    Returns either `{persona, kind: "token", token}` for the organizer — the same
    credential `/demo-token` hands out, so the existing entry path is unchanged —
    or `{persona, kind: "path", path}` for the reviewer and speaker, whose real
    surfaces are entered by magic link rather than by session.
    """
    if persona not in DEMO_PERSONAS:
        raise HTTPException(status_code=404, detail="Unknown demo persona")

    if persona == "organizer":
        secret = os.environ.get("SUPABASE_JWT_SECRET")
        if not secret:
            raise HTTPException(status_code=500, detail="SUPABASE_JWT_SECRET is not configured")
        return {"persona": persona, "kind": "token", "token": _mint_demo_token(secret)}

    table, row_id, purpose, prefix = (
        ("evaluators", DEMO_REVIEWER_EVALUATOR_ID, "review", "/review")
        if persona == "reviewer"
        else ("contacts", DEMO_SPEAKER_CONTACT_ID, "portal", "/portal")
    )

    if not await _demo_row_exists(table, row_id):
        raise HTTPException(status_code=404, detail=f"The demo workspace has no seeded {persona}")

    kwargs = (
        {"evaluator_id": row_id} if purpose == "review" else {"contact_id": row_id}
    )
    raw = await magic_links.mint(
        DEMO_ORG_ID, purpose, ttl_hours=DEMO_LINK_HOURS, **kwargs
    )
    return {"persona": persona, "kind": "path", "path": f"{prefix}/{raw}"}
