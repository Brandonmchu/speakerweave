"""The signed-in organizer's own account: which orgs they have, and switching.

A token names exactly one org (`auth.get_current_user_and_org`), so "switch
organization" cannot be a client-side toggle — it is a new token, minted here,
and ONLY after this user's membership has been read back from the database.
That check is the security boundary of this module: an org the caller has no
row in returns 404, indistinguishable from an org that does not exist, and
nothing is signed.

The minted token is the exact shape `scripts/mint_dev_token.py` produces —
same signing key, same claims, same TTL policy — because the API only ever
verifies HS256 against SUPABASE_JWT_SECRET. One mechanism therefore serves both
the dev-token flow and the Clerk flow.

This router is mounted twice (see main.py): at `/v1/me` — the contracted path —
and at `/api/me`, which is what the web tier's same-origin proxy forwards.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user_and_org, get_display_name
from scripts.mint_dev_token import mint_dev_token
from services import org_membership

router = APIRouter(tags=["me"])


@router.get("/organizations")
async def list_my_organizations(auth: tuple = Depends(get_current_user_and_org)):
    """Every org this user belongs to, with its event count and which is live."""
    user_id, org_id = auth
    return {"organizations": await org_membership.list_organizations(user_id, org_id)}


@router.post("/organizations/{org_id}/token")
async def mint_organization_token(
    org_id: str,
    request: Request,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Mint an organizer token for another of THIS user's orgs.

    Membership is verified server-side, from `org_memberships`, before anything
    is signed. The caller's current org is accepted without that row as well:
    they already hold a verified token for it, so re-issuing one grants nothing
    new and keeps the switcher working if the best-effort backfill never ran.
    """
    user_id, current_org_id = auth
    if org_id != current_org_id and not await org_membership.is_member(org_id, user_id):
        # 404, never 403: membership in an org the caller does not belong to is
        # indistinguishable from that org not existing.
        raise HTTPException(status_code=404, detail="Organization not found")

    # Same sub, new org_id. No TTL of our own: mint_dev_token owns that policy.
    token = mint_dev_token(org=org_id, sub=user_id, name=get_display_name(request))
    return {"token": token}
