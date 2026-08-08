"""Organizer-side management of public API tokens.

This surface is the ordinary organizer app (prefix ``/api``, Clerk/JWT auth),
NOT the public ``/v1`` API. It lets an org mint a key for the ``/v1`` endpoints,
list the keys it has (without ever re-showing the secret), and revoke one.

The raw key is returned exactly once, at mint time. Everything else reads back
metadata only — the hash never leaves the database.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from auth import get_current_user_and_org, verify_org_access
from services.api_keys import mint_api_key
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/api", tags=["api-tokens"])
logger = logging.getLogger(__name__)

# Columns safe to return to the organizer — deliberately excludes token_hash.
_SAFE_COLUMNS = "id, name, scopes, created_at, last_used_at"


class ApiTokenCreateRequest(BaseModel):
    name: str = Field(default="API token", max_length=120)


def _safe_token(row: dict) -> dict:
    """Metadata view of a token row. token_hash never appears — projected here
    in Python, not just in the SELECT, so the secret can't leak by accident."""
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "scopes": list(row.get("scopes") or []),
        "created_at": row.get("created_at"),
        "last_used_at": row.get("last_used_at"),
    }


@router.get("/api-tokens")
async def list_api_tokens(auth: tuple = Depends(get_current_user_and_org)) -> dict:
    """The org's API tokens — metadata only, newest first. No secrets."""
    _user_id, org_id = auth
    res = await db(
        lambda: supabase.table("api_tokens")
        .select(_SAFE_COLUMNS)
        .eq("org_id", org_id)
        .order("created_at", desc=True)
        .execute(),
        "list_api_tokens",
    )
    return {"tokens": [_safe_token(row) for row in rows(res)]}


@router.post("/api-tokens", status_code=201)
async def create_api_token(
    payload: ApiTokenCreateRequest,
    auth: tuple = Depends(get_current_user_and_org),
) -> dict:
    """Mint a key for this org and return it once.

    The response ``token`` is the ONLY time the raw key is shown; store it now.
    """
    _user_id, org_id = auth
    raw = await mint_api_key(org_id, payload.name)
    return {"token": raw, "name": payload.name.strip() or "API token"}


@router.delete("/api-tokens/{token_id}", status_code=204)
async def delete_api_token(
    token_id: str,
    auth: tuple = Depends(get_current_user_and_org),
) -> Response:
    """Revoke a token. 404 for a token that isn't this org's (never 403)."""
    _user_id, org_id = auth
    existing = first(
        await db(
            lambda: supabase.table("api_tokens")
            .select("id, org_id")
            .eq("id", token_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "api_token_lookup",
        )
    )
    verify_org_access(existing, org_id, "API token")

    await db(
        lambda: supabase.table("api_tokens")
        .delete()
        .eq("id", token_id)
        .eq("org_id", org_id)
        .execute(),
        "delete_api_token",
    )
    return Response(status_code=204)
