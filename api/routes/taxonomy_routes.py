"""Event taxonomy: tracks, rooms, formats, levels, tags.

Five tables, one shape, one set of four operations. They are registered from a
config dict rather than copy-pasted five times — the fifth copy is where the
org predicate goes missing, and a missing org predicate here is a cross-org
leak (the service-role client bypasses RLS).

Schema note (migration 001): only tracks, rooms and levels have an `"order"`
column. `order` in the request body is therefore accepted for those three and
ignored for formats/tags, which sort by name alone.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from auth import get_current_user_and_org
from services.org_scope import fetch_event, fetch_scoped
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/api", tags=["taxonomy"])
logger = logging.getLogger(__name__)


class TaxonomyCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    color: str | None = Field(default=None, max_length=32)
    capacity: int | None = Field(default=None, ge=0)
    default_duration_min: int | None = Field(default=None, ge=1, le=1440)
    order: int | None = None


class TaxonomyPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    color: str | None = Field(default=None, max_length=32)
    capacity: int | None = Field(default=None, ge=0)
    default_duration_min: int | None = Field(default=None, ge=1, le=1440)
    order: int | None = None


# kind -> (response key for one row, writable columns beyond `name`,
#          the sessions column that would make a delete unsafe)
KINDS: dict[str, dict[str, Any]] = {
    "tracks": {"singular": "track", "columns": ("color", "order"), "session_fk": "track_id"},
    "rooms": {"singular": "room", "columns": ("capacity", "order"), "session_fk": "room_id"},
    "formats": {
        "singular": "format",
        "columns": ("default_duration_min",),
        "session_fk": "format_id",
    },
    "levels": {"singular": "level", "columns": ("order",), "session_fk": "level_id"},
    # tags attach through session_tags, not a column on sessions
    "tags": {"singular": "tag", "columns": (), "session_fk": None},
}


def ordered(items: list[dict]) -> list[dict]:
    """`order` then name. Sorted here, not in PostgREST: `order` is also the
    name of PostgREST's sort parameter, and these lists are tiny."""
    return sorted(
        items,
        key=lambda row: (
            row["order"] if isinstance(row.get("order"), int) else 0,
            str(row.get("name") or "").casefold(),
        ),
    )


def _writable(payload: BaseModel, columns: tuple[str, ...], *, only_set: bool) -> dict:
    """Body -> column patch, dropping anything this kind has no column for."""
    provided = payload.model_dump(exclude_unset=only_set)
    patch = {key: value for key, value in provided.items() if key in columns}
    if only_set:
        return patch
    return {key: value for key, value in patch.items() if value is not None}


async def _in_use(kind: str, config: dict, item_id: str, org_id: str) -> bool:
    """Would deleting this orphan a session? Tags go through the join table."""
    if config["session_fk"] is None:
        used = first(
            await db(
                lambda: supabase.table("session_tags")
                .select("session_id")
                .eq("tag_id", item_id)
                .limit(1)
                .execute(),
                f"{kind}_usage_check",
            )
        )
        return bool(used)

    used = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id")
            .eq(config["session_fk"], item_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            f"{kind}_usage_check",
        )
    )
    return bool(used)


def _register(kind: str, config: dict) -> None:
    singular: str = config["singular"]
    columns: tuple[str, ...] = config["columns"]
    resource = singular.capitalize()

    async def list_items(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
        _user_id, org_id = auth
        await fetch_event(event_id, org_id)
        res = await db(
            lambda: supabase.table(kind)
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            f"list_{kind}",
        )
        return {kind: ordered(rows(res))}

    async def create_item(
        event_id: str,
        payload: TaxonomyCreateRequest,
        auth: tuple = Depends(get_current_user_and_org),
    ):
        _user_id, org_id = auth
        await fetch_event(event_id, org_id)
        # org_id and event_id come from the token and the path — never the body.
        record = {
            "org_id": org_id,
            "event_id": event_id,
            "name": payload.name.strip(),
            **_writable(payload, columns, only_set=False),
        }
        created = first(
            await db(
                lambda: supabase.table(kind).insert(record).execute(),
                f"create_{singular}",
            )
        )
        if not created:
            raise HTTPException(status_code=500, detail=f"Could not create {singular}")
        return {singular: created}

    async def update_item(
        item_id: str,
        payload: TaxonomyPatchRequest,
        auth: tuple = Depends(get_current_user_and_org),
    ):
        _user_id, org_id = auth
        await fetch_scoped(kind, item_id, org_id, resource, columns="id, org_id")

        patch = _writable(payload, columns, only_set=True)
        if payload.name is not None:
            patch["name"] = payload.name.strip()
        if not patch:
            raise HTTPException(status_code=400, detail="Nothing to update")

        updated = first(
            await db(
                lambda: supabase.table(kind)
                .update(patch)
                .eq("id", item_id)
                .eq("org_id", org_id)
                .execute(),
                f"update_{singular}",
            )
        )
        if not updated:
            raise HTTPException(status_code=404, detail=f"{resource} not found")
        return {singular: updated}

    async def delete_item(item_id: str, auth: tuple = Depends(get_current_user_and_org)):
        _user_id, org_id = auth
        await fetch_scoped(kind, item_id, org_id, resource, columns="id, org_id")

        if await _in_use(kind, config, item_id, org_id):
            # 409, not 400: the request is well-formed, the world is not ready.
            raise HTTPException(
                status_code=409,
                detail=(
                    f"This {singular} is in use by at least one session — "
                    f"reassign those sessions before deleting it"
                ),
            )

        await db(
            lambda: supabase.table(kind)
            .delete()
            .eq("id", item_id)
            .eq("org_id", org_id)
            .execute(),
            f"delete_{singular}",
        )
        return Response(status_code=204)

    router.add_api_route(
        f"/events/{{event_id}}/{kind}", list_items, methods=["GET"], name=f"list_{kind}"
    )
    router.add_api_route(
        f"/events/{{event_id}}/{kind}",
        create_item,
        methods=["POST"],
        status_code=201,
        name=f"create_{singular}",
    )
    router.add_api_route(
        f"/{kind}/{{item_id}}", update_item, methods=["PATCH"], name=f"update_{singular}"
    )
    router.add_api_route(
        f"/{kind}/{{item_id}}",
        delete_item,
        methods=["DELETE"],
        status_code=204,
        name=f"delete_{singular}",
    )


for _kind, _config in KINDS.items():
    _register(_kind, _config)
