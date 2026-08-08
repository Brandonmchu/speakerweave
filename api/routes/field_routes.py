"""The field library — the questions an organizer can put on a form.

Fields are defined once per event (or org-wide, `event_id is null`) and reused
across forms; `form_fields` decides where a field appears and whether it is
required *on that form*. Answers are keyed by field id, so a field's identity
must outlive its label: `public_name` is editable, `internal_name` and
`field_type` are not.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import get_current_user_and_org
from services.org_scope import fetch_event, fetch_scoped
from services.slugs import dedupe_name, slugify
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/api", tags=["fields"])
logger = logging.getLogger(__name__)

# Mirrors the CHECK constraint in migrations/001_init.sql. Out of sync means a
# 500 from Postgres where the organizer deserves a 400 naming the problem.
FIELD_TYPES = (
    "text",
    "textarea",
    "wysiwyg",
    "number",
    "email",
    "phone",
    "url",
    "date",
    "datetime",
    "checkbox",
    "dropdown",
    "multi_select",
    "file",
    "header",
    "divider",
)
FIELD_SCOPES = ("contact", "session")


class FieldCreateRequest(BaseModel):
    scope: str
    public_name: str = Field(..., min_length=1, max_length=200)
    field_type: str
    options: dict[str, Any] | None = None
    required: bool = False


class FieldPatchRequest(BaseModel):
    public_name: str | None = Field(default=None, min_length=1, max_length=200)
    options: dict[str, Any] | None = None
    required: bool | None = None
    # Accepted only so it can be refused with an explanation: silently ignoring
    # it would leave the caller believing the type changed.
    field_type: str | None = None


def _sorted(fields: list[dict]) -> list[dict]:
    return sorted(
        fields,
        key=lambda row: (str(row.get("created_at") or ""), str(row.get("public_name") or "")),
    )


@router.get("/events/{event_id}/fields")
async def list_fields(
    event_id: str,
    scope: str | None = Query(default=None),
    auth: tuple = Depends(get_current_user_and_org),
):
    """The library for one event: its own fields plus the org-global ones."""
    _user_id, org_id = auth
    if scope and scope not in FIELD_SCOPES:
        raise HTTPException(status_code=400, detail=f"Unknown scope '{scope}'")
    event = await fetch_event(event_id, org_id)
    # The id from the verified row, not the path: `or_` takes a raw PostgREST
    # expression, so nothing user-supplied may be interpolated into it.
    verified_event_id = event["id"]

    def _query():
        query = (
            supabase.table("fields")
            .select("*")
            .eq("org_id", org_id)
            # org-global fields (event_id is null) belong to every event
            .or_(f"event_id.eq.{verified_event_id},event_id.is.null")
        )
        if scope:
            query = query.eq("scope", scope)
        return query.execute()

    return {"fields": _sorted(rows(await db(_query, "list_fields")))}


@router.post("/events/{event_id}/fields", status_code=201)
async def create_field(
    event_id: str,
    payload: FieldCreateRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    if payload.scope not in FIELD_SCOPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown scope '{payload.scope}' — expected {' or '.join(FIELD_SCOPES)}",
        )
    if payload.field_type not in FIELD_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown field type '{payload.field_type}'",
        )
    await fetch_event(event_id, org_id)

    existing = rows(
        await db(
            lambda: supabase.table("fields")
            .select("internal_name")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "field_internal_names",
        )
    )
    internal_name = dedupe_name(
        slugify(payload.public_name, separator="_", fallback="field"),
        {str(row.get("internal_name")) for row in existing},
    )

    record = {
        "org_id": org_id,
        "event_id": event_id,
        "scope": payload.scope,
        "internal_name": internal_name,
        "public_name": payload.public_name.strip(),
        "field_type": payload.field_type,
        "options": payload.options or {},
        "required": payload.required,
    }
    created = first(
        await db(lambda: supabase.table("fields").insert(record).execute(), "create_field")
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not create field")
    return {"field": created}


@router.patch("/fields/{field_id}")
async def update_field(
    field_id: str,
    payload: FieldPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    if payload.field_type is not None:
        # Every stored answer was shaped by the old type; changing it would
        # reinterpret history rather than edit a field.
        raise HTTPException(
            status_code=400,
            detail="A field's type cannot be changed — create a new field instead",
        )
    await fetch_scoped("fields", field_id, org_id, "Field", columns="id, org_id")

    provided = payload.model_dump(exclude_unset=True)
    patch = {key: provided[key] for key in ("options", "required") if key in provided}
    if payload.public_name is not None:
        patch["public_name"] = payload.public_name.strip()
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")

    updated = first(
        await db(
            lambda: supabase.table("fields")
            .update(patch)
            .eq("id", field_id)
            .eq("org_id", org_id)
            .execute(),
            "update_field",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Field not found")
    return {"field": updated}
