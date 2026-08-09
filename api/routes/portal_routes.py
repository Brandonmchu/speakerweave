"""Public speaker-portal surface (requirement #2).

No JWT here — the only credential is the ``dais_portal`` HttpOnly cookie minted
when a speaker redeems their magic link. ``get_portal_contact`` turns that cookie
into ``(org_id, contact_id)``; every route below derives its scope from that
tuple and nothing else, so the request body can never widen a speaker's reach
past their own row.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Request, UploadFile
from pydantic import BaseModel, Field

from deps.portal_deps import get_portal_contact
from security.rate_limiting import RATE_PUBLIC_WRITE, limiter
from services import portal

router = APIRouter(prefix="/public/portal", tags=["public-portal"])


class CommentRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)


class ProfilePatch(BaseModel):
    first_name: str | None = Field(default=None, max_length=120)
    last_name: str | None = Field(default=None, max_length=120)
    about: str | None = Field(default=None, max_length=5000)
    company_name: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=200)
    pronouns: str | None = Field(default=None, max_length=60)
    linkedin_url: str | None = Field(default=None, max_length=300)
    twitter_url: str | None = Field(default=None, max_length=300)
    phone: str | None = Field(default=None, max_length=60)


@router.get("/me")
async def get_me(portal_contact: tuple[str, str] = Depends(get_portal_contact)):
    """Everything the portal renders: profile, event, sessions, tasks. Stamps
    ``last_portal_access_at`` as a side effect (see services.portal.build_me)."""
    org_id, contact_id = portal_contact
    return await portal.build_me(org_id, contact_id)


@router.patch("/profile")
async def update_profile(
    payload: ProfilePatch,
    portal_contact: tuple[str, str] = Depends(get_portal_contact),
):
    org_id, contact_id = portal_contact
    patch = payload.model_dump(exclude_unset=True)
    contact = await portal.update_profile(org_id, contact_id, patch)
    return {"contact": contact}


@router.post("/tasks/{assignment_id}/complete")
@limiter.limit(RATE_PUBLIC_WRITE)
async def complete_task(
    request: Request,
    assignment_id: str,
    portal_contact: tuple[str, str] = Depends(get_portal_contact),
):
    org_id, contact_id = portal_contact
    return await portal.complete_todo(org_id, contact_id, assignment_id)


@router.post("/tasks/{assignment_id}/upload")
@limiter.limit(RATE_PUBLIC_WRITE)
async def upload_task_file(
    request: Request,
    assignment_id: str,
    file: Annotated[UploadFile, File()],
    portal_contact: tuple[str, str] = Depends(get_portal_contact),
):
    org_id, contact_id = portal_contact
    content = await file.read()
    return await portal.upload_task_file(org_id, contact_id, assignment_id, file.filename, content)


@router.post("/tasks/{assignment_id}/comments")
@limiter.limit(RATE_PUBLIC_WRITE)
async def add_task_comment(
    request: Request,
    assignment_id: str,
    payload: CommentRequest,
    portal_contact: tuple[str, str] = Depends(get_portal_contact),
):
    """Speaker replies on their own content item — visible to the organizer in the
    content library. Scoped to the speaker's own assignment."""
    org_id, contact_id = portal_contact
    return await portal.add_comment(org_id, contact_id, assignment_id, payload.body)


@router.post("/headshot")
@limiter.limit(RATE_PUBLIC_WRITE)
async def upload_headshot(
    request: Request,
    file: Annotated[UploadFile, File()],
    portal_contact: tuple[str, str] = Depends(get_portal_contact),
):
    org_id, contact_id = portal_contact
    content = await file.read()
    return await portal.set_headshot(org_id, contact_id, file.filename, content)
