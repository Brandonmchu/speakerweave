"""The public, read-only ``/v1`` API — dais speaking Sessionboard's protocol.

This is a thin, org-scoped mirror of Sessionboard's own public API contract:

* Base path ``/v1``; auth via the ``x-access-token`` header (see
  ``deps.api_key_deps``), NOT the organizer ``Authorization: Bearer`` JWT.
* Two ways to read a collection, both accepted, per Sessionboard:
  ``GET  /v1/…/sessions``          — simple list with query-string paging, and
  ``POST /v1/…/sessions/search``   — a search body ``{status?, page?, pageSize?}``.
* 1-based ``page`` (1–999) + ``pageSize`` (default 25, max 100), returned in the
  envelope ``{data, page, pageSize, total}``.
* ``friendly_id`` ("SESS-8"), ``snake_case`` fields, resources nested inline.

Everything is READ ONLY. Writes are deliberately out of scope for the public
API; a "read" token can do everything here. Every query carries the org
predicate the resolved key supplies — the service-role client bypasses RLS, so
a missing predicate would be a cross-org leak, exactly as on the organizer side.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from deps.api_key_deps import get_api_org
from services.org_scope import fetch_event
from services.supabase_helpers import db, rows
from supabase_client import supabase

router = APIRouter(prefix="/v1", tags=["v1-public"])
logger = logging.getLogger(__name__)

# Mirrors sessions.status CHECK in migration 001.
SESSION_STATUSES = (
    "draft",
    "pending",
    "accept_queue",
    "accepted",
    "decline_queue",
    "declined",
    "withdrawn",
)

DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100
MAX_PAGE = 999


class SearchRequest(BaseModel):
    """Body for the ``POST …/search`` variants.

    No pydantic range constraints on purpose: out-of-range paging must surface
    as a friendly 400 (below), not FastAPI's 422 validation envelope.
    """

    status: str | None = None
    page: int = 1
    pageSize: int = DEFAULT_PAGE_SIZE


# ── paging helpers ───────────────────────────────────────────────────────────


def _validate_paging(page: int, page_size: int) -> tuple[int, int]:
    if page < 1 or page > MAX_PAGE:
        raise HTTPException(status_code=400, detail=f"page must be between 1 and {MAX_PAGE}")
    if page_size < 1 or page_size > MAX_PAGE_SIZE:
        raise HTTPException(
            status_code=400, detail=f"pageSize must be between 1 and {MAX_PAGE_SIZE}"
        )
    return page, page_size


def _paginate(items: list[dict], page: int, page_size: int) -> dict:
    """Slice ``items`` and wrap in Sessionboard's ``{data, page, pageSize, total}``."""
    total = len(items)
    start = (page - 1) * page_size
    return {
        "data": items[start : start + page_size],
        "page": page,
        "pageSize": page_size,
        "total": total,
    }


def _check_status(status: str | None) -> None:
    if status is not None and status not in SESSION_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown status '{status}'")


# ── serializers ──────────────────────────────────────────────────────────────


def _serialize_event(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "slug": row.get("slug"),
        "starts_at": row.get("starts_at"),
        "ends_at": row.get("ends_at"),
        "timezone": row.get("timezone"),
    }


def _full_name(contact: dict) -> str:
    name = f"{contact.get('first_name') or ''} {contact.get('last_name') or ''}".strip()
    return name or (contact.get("email") or "")


def _serialize_contact(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "full_name": _full_name(row),
        "email": row.get("email"),
        "company_name": row.get("company_name"),
        "title": row.get("title"),
        "about": row.get("about"),
    }


def _serialize_session(
    session: dict,
    *,
    rooms_by_id: dict[str, dict],
    tracks_by_id: dict[str, dict],
    speakers_by_session: dict[str, list[dict]],
) -> dict:
    room = rooms_by_id.get(session.get("room_id")) if session.get("room_id") else None
    track = tracks_by_id.get(session.get("track_id")) if session.get("track_id") else None
    return {
        "id": session.get("id"),
        "friendly_id": session.get("friendly_id"),
        "title": session.get("title"),
        "description": session.get("description"),
        "status": session.get("status"),
        "starts_at": session.get("starts_at"),
        "ends_at": session.get("ends_at"),
        "is_abstract": bool(session.get("is_abstract")),
        "room": {"id": room["id"], "name": room.get("name"), "capacity": room.get("capacity")}
        if room
        else None,
        "track": {"id": track["id"], "name": track.get("name"), "color": track.get("color")}
        if track
        else None,
        "speakers": speakers_by_session.get(session.get("id"), []),
    }


# ── data loading ─────────────────────────────────────────────────────────────


def _sort_key(session: dict) -> tuple:
    """Stable order: by scheduled start (unscheduled last), then friendly id."""
    raw = session.get("friendly_id_raw")
    return (session.get("starts_at") is None, str(session.get("starts_at") or ""), raw or 0)


async def _load_sessions(event_id: str, org_id: str, status: str | None) -> list[dict]:
    def _query():
        q = (
            supabase.table("sessions")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
        )
        if status:
            q = q.eq("status", status)
        return q.execute()

    sessions = rows(await db(_query, "v1_list_sessions"))
    sessions.sort(key=_sort_key)
    return sessions


async def _fetch_by_ids(table: str, ids: list[str], org_id: str, columns: str) -> dict[str, dict]:
    """`{id: row}` for the given ids, org-scoped. Empty ids → no query."""
    if not ids:
        return {}
    res = await db(
        lambda: supabase.table(table)
        .select(columns)
        .in_("id", sorted(set(ids)))
        .eq("org_id", org_id)
        .execute(),
        f"v1_fetch_{table}",
    )
    return {row["id"]: row for row in rows(res)}


async def _speakers_for_sessions(session_ids: list[str], org_id: str) -> dict[str, list[dict]]:
    """`{session_id: [speaker,...]}` — role='speaker', primary first.

    Two queries, not a PostgREST embed: an embedded resource can't carry its own
    org predicate, and the org predicate is the whole isolation story here.
    """
    if not session_ids:
        return {}

    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("session_id, contact_id, role, is_primary")
            .in_("session_id", sorted(set(session_ids)))
            .eq("org_id", org_id)
            .execute(),
            "v1_session_participants",
        )
    )
    speakers = [p for p in participants if p.get("role") == "speaker" and p.get("contact_id")]
    if not speakers:
        return {}

    contacts_by_id = await _fetch_by_ids(
        "contacts",
        [p["contact_id"] for p in speakers],
        org_id,
        "id, first_name, last_name, email",
    )

    by_session: dict[str, list[dict]] = {}
    # Primary speakers first, then a stable email order.
    speakers.sort(key=lambda p: (not p.get("is_primary"), str(p.get("contact_id") or "")))
    for p in speakers:
        contact = contacts_by_id.get(p["contact_id"])
        if not contact:
            continue
        by_session.setdefault(p["session_id"], []).append(
            {
                "id": contact["id"],
                "full_name": _full_name(contact),
                "email": contact.get("email"),
            }
        )
    return by_session


async def _sessions_page(event_id: str, org_id: str, status: str | None, page: int, page_size: int) -> dict:
    _check_status(status)
    all_sessions = await _load_sessions(event_id, org_id, status)
    envelope = _paginate(all_sessions, page, page_size)
    page_sessions: list[dict] = envelope["data"]

    rooms_by_id = await _fetch_by_ids(
        "rooms", [s["room_id"] for s in page_sessions if s.get("room_id")], org_id, "id, name, capacity"
    )
    tracks_by_id = await _fetch_by_ids(
        "tracks", [s["track_id"] for s in page_sessions if s.get("track_id")], org_id, "id, name, color"
    )
    speakers_by_session = await _speakers_for_sessions([s["id"] for s in page_sessions], org_id)

    envelope["data"] = [
        _serialize_session(
            s,
            rooms_by_id=rooms_by_id,
            tracks_by_id=tracks_by_id,
            speakers_by_session=speakers_by_session,
        )
        for s in page_sessions
    ]
    return envelope


async def _contacts_page(event_id: str, org_id: str, page: int, page_size: int) -> dict:
    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "v1_list_contacts",
        )
    )
    contacts.sort(
        key=lambda c: (
            str(c.get("last_name") or "").casefold(),
            str(c.get("first_name") or "").casefold(),
            str(c.get("email") or "").casefold(),
        )
    )
    envelope = _paginate(contacts, page, page_size)
    envelope["data"] = [_serialize_contact(c) for c in envelope["data"]]
    return envelope


# ── routes ───────────────────────────────────────────────────────────────────


@router.get("/events")
async def list_events(auth: tuple = Depends(get_api_org)) -> dict:
    """Every event in the token's org."""
    org_id, _scopes = auth
    res = await db(
        lambda: supabase.table("events")
        .select("*")
        .eq("org_id", org_id)
        .order("starts_at", desc=True)
        .execute(),
        "v1_list_events",
    )
    return {"data": [_serialize_event(row) for row in rows(res)]}


@router.get("/events/{event_id}/sessions")
async def list_sessions(
    event_id: str,
    status: str | None = Query(default=None),
    page: int = Query(default=1),
    pageSize: int = Query(default=DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    page, page_size = _validate_paging(page, pageSize)
    await fetch_event(event_id, org_id)  # 404 if not in this org
    return await _sessions_page(event_id, org_id, status, page, page_size)


@router.post("/events/{event_id}/sessions/search")
async def search_sessions(
    event_id: str,
    body: SearchRequest | None = None,
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    query = body or SearchRequest()
    page, page_size = _validate_paging(query.page, query.pageSize)
    await fetch_event(event_id, org_id)
    return await _sessions_page(event_id, org_id, query.status, page, page_size)


@router.get("/events/{event_id}/contacts")
async def list_contacts(
    event_id: str,
    page: int = Query(default=1),
    pageSize: int = Query(default=DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    page, page_size = _validate_paging(page, pageSize)
    await fetch_event(event_id, org_id)
    return await _contacts_page(event_id, org_id, page, page_size)


@router.post("/events/{event_id}/contacts/search")
async def search_contacts(
    event_id: str,
    body: SearchRequest | None = None,
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    query = body or SearchRequest()
    page, page_size = _validate_paging(query.page, query.pageSize)
    await fetch_event(event_id, org_id)
    return await _contacts_page(event_id, org_id, page, page_size)
