"""Organizer-authenticated integration configuration and sync routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from auth import get_current_user_and_org
from services import airtable_sync

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


class AirtableConfigRequest(BaseModel):
    # None/blank means "leave the write-only token unchanged".
    token: str | None = Field(default=None, max_length=500)
    base_id: str = Field(default="", max_length=200)
    enabled: bool = False


@router.get("/airtable")
async def get_airtable_config(
    auth: tuple = Depends(get_current_user_and_org),
) -> dict:
    _user_id, org_id = auth
    return await airtable_sync.get_public_config(org_id)


@router.put("/airtable")
async def put_airtable_config(
    payload: AirtableConfigRequest,
    auth: tuple = Depends(get_current_user_and_org),
) -> dict:
    _user_id, org_id = auth
    return await airtable_sync.save_config(
        org_id,
        token=payload.token,
        base_id=payload.base_id,
        enabled=payload.enabled,
    )


@router.post("/airtable/sync")
async def sync_airtable(auth: tuple = Depends(get_current_user_and_org)) -> dict:
    _user_id, org_id = auth
    return await airtable_sync.sync_org(org_id)
