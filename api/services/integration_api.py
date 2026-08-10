"""Shared org-scoped operations for the public REST API and hosted MCP server.

The Supabase client uses the service role, so every database operation in this
module carries an explicit ``org_id`` predicate.  REST handlers and MCP tools
stay deliberately thin and share these functions rather than slowly drifting
into two integration contracts with different tenancy guarantees.
"""

from __future__ import annotations

import html
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from postgrest.exceptions import APIError

from app.core.settings import settings
from services import content_pipeline, evaluations
from services.magic_links import mint
from services.org_scope import fetch_event
from services.speaker_crm import full_name, looks_like_email, normalize_email
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

SESSION_STATUSES = (
    "draft",
    "pending",
    "accept_queue",
    "accepted",
    "decline_queue",
    "declined",
    "withdrawn",
)
SPEAKER_STATUSES = ("invited", "confirmed", "declined")
CONTENT_STATUSES = ("received", "missing", "needs_changes")
DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100
MAX_PAGE = 999
DEFAULT_SESSION_MINUTES = 30
PORTAL_INVITE_TTL_HOURS = 24 * 30


def validate_paging(page: int, page_size: int) -> tuple[int, int]:
    if page < 1 or page > MAX_PAGE:
        raise HTTPException(
            status_code=400, detail=f"page must be between 1 and {MAX_PAGE}"
        )
    if page_size < 1 or page_size > MAX_PAGE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"pageSize must be between 1 and {MAX_PAGE_SIZE}",
        )
    return page, page_size


def paginate(items: list[dict], page: int, page_size: int) -> dict:
    page, page_size = validate_paging(page, page_size)
    start = (page - 1) * page_size
    return {
        "data": items[start : start + page_size],
        "page": page,
        "pageSize": page_size,
        "total": len(items),
    }


def _not_found(resource: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{resource} not found")


def _check_session_status(status: str | None) -> None:
    if status is not None and status not in SESSION_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown status '{status}'")


def _check_speaker_status(status: str | None) -> str | None:
    if status is None:
        return None
    normalized = status.strip().lower()
    if not normalized:
        return None
    if normalized not in SPEAKER_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown speaker status '{status}' — use one of: "
                f"{', '.join(SPEAKER_STATUSES)}."
            ),
        )
    return normalized


def _as_datetime(value: object) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail="start must be an ISO-8601 timestamp"
            ) from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _serialize_event(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "slug": row.get("slug"),
        "starts_at": row.get("starts_at"),
        "ends_at": row.get("ends_at"),
        "timezone": row.get("timezone"),
    }


def _serialize_speaker(row: dict, *, invited: bool = False) -> dict:
    return {
        "id": row.get("id"),
        "full_name": full_name(
            row.get("first_name"), row.get("last_name"), row.get("email")
        ),
        "first_name": row.get("first_name") or "",
        "last_name": row.get("last_name") or "",
        "email": row.get("email"),
        "company_name": row.get("company_name"),
        "title": row.get("title"),
        "about": row.get("about"),
        "photo_url": row.get("photo_url"),
        "pronouns": row.get("pronouns"),
        "linkedin_url": row.get("linkedin_url"),
        "twitter_url": row.get("twitter_url"),
        "phone": row.get("phone"),
        "speaker_status": row.get("speaker_status"),
        "logistics_notes": row.get("logistics_notes"),
        "last_portal_access_at": row.get("last_portal_access_at"),
        "invited_to_portal": invited,
    }


async def _fetch_by_ids(
    table: str, ids: list[str], org_id: str, columns: str = "*"
) -> dict[str, dict]:
    if not ids:
        return {}
    result = await db(
        lambda: supabase.table(table)
        .select(columns)
        .in_("id", sorted(set(ids)))
        .eq("org_id", org_id)
        .execute(),
        f"integration_fetch_{table}",
    )
    return {str(row["id"]): row for row in rows(result) if row.get("id")}


async def _speakers_for_sessions(
    session_ids: list[str], org_id: str
) -> dict[str, list[dict]]:
    if not session_ids:
        return {}
    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("session_id, contact_id, role, is_primary")
            .in_("session_id", sorted(set(session_ids)))
            .eq("org_id", org_id)
            .execute(),
            "integration_session_participants",
        )
    )
    speaker_rows = [
        row
        for row in participants
        if row.get("role") == "speaker" and row.get("contact_id")
    ]
    contacts = await _fetch_by_ids(
        "contacts",
        [str(row["contact_id"]) for row in speaker_rows],
        org_id,
        "id, first_name, last_name, email",
    )
    speaker_rows.sort(
        key=lambda row: (
            not row.get("is_primary"),
            str(row.get("contact_id") or ""),
        )
    )
    result: dict[str, list[dict]] = {}
    for participant in speaker_rows:
        contact = contacts.get(str(participant["contact_id"]))
        if not contact:
            continue
        result.setdefault(str(participant["session_id"]), []).append(
            {
                "id": contact["id"],
                "full_name": full_name(
                    contact.get("first_name"),
                    contact.get("last_name"),
                    contact.get("email"),
                ),
                "email": contact.get("email"),
            }
        )
    return result


async def _serialize_sessions(sessions: list[dict], org_id: str) -> list[dict]:
    rooms = await _fetch_by_ids(
        "rooms",
        [str(row["room_id"]) for row in sessions if row.get("room_id")],
        org_id,
        "id, name, capacity",
    )
    tracks = await _fetch_by_ids(
        "tracks",
        [str(row["track_id"]) for row in sessions if row.get("track_id")],
        org_id,
        "id, name, color",
    )
    formats = await _fetch_by_ids(
        "formats",
        [str(row["format_id"]) for row in sessions if row.get("format_id")],
        org_id,
        "id, name, default_duration_min",
    )
    speakers = await _speakers_for_sessions(
        [str(row["id"]) for row in sessions if row.get("id")], org_id
    )
    serialized = []
    for session in sessions:
        room = rooms.get(str(session.get("room_id")))
        track = tracks.get(str(session.get("track_id")))
        format_row = formats.get(str(session.get("format_id")))
        serialized.append(
            {
                "id": session.get("id"),
                "event_id": session.get("event_id"),
                "friendly_id": session.get("friendly_id"),
                "title": session.get("title"),
                "abstract": session.get("description"),
                "description": session.get("description"),
                "status": session.get("status"),
                "starts_at": session.get("starts_at"),
                "ends_at": session.get("ends_at"),
                "is_abstract": bool(session.get("is_abstract")),
                "room": (
                    {
                        "id": room["id"],
                        "name": room.get("name"),
                        "capacity": room.get("capacity"),
                    }
                    if room
                    else None
                ),
                "track": (
                    {
                        "id": track["id"],
                        "name": track.get("name"),
                        "color": track.get("color"),
                    }
                    if track
                    else None
                ),
                "format": (
                    {
                        "id": format_row["id"],
                        "name": format_row.get("name"),
                        "default_duration_min": format_row.get(
                            "default_duration_min"
                        ),
                    }
                    if format_row
                    else None
                ),
                "speakers": speakers.get(str(session.get("id")), []),
                "submitted_at": session.get("submitted_at"),
                "updated_at": session.get("updated_at"),
            }
        )
    return serialized


async def list_events(
    org_id: str, *, page: int = 1, page_size: int = DEFAULT_PAGE_SIZE
) -> dict:
    events = rows(
        await db(
            lambda: supabase.table("events")
            .select("*")
            .eq("org_id", org_id)
            .order("starts_at", desc=True)
            .execute(),
            "integration_list_events",
        )
    )
    envelope = paginate(events, page, page_size)
    envelope["data"] = [_serialize_event(row) for row in envelope["data"]]
    return envelope


async def get_event(org_id: str, event_id: str) -> dict:
    event = await fetch_event(event_id, org_id)
    return _serialize_event(event)


async def resolve_event(org_id: str, reference: str | None) -> dict:
    """Resolve an MCP event id/slug, or the org's sole event when omitted."""
    if reference:
        candidates = rows(
            await db(
                lambda: supabase.table("events")
                .select("*")
                .eq("org_id", org_id)
                .execute(),
                "integration_resolve_event",
            )
        )
        result = next(
            (
                event
                for event in candidates
                if str(event.get("id")) == reference
                or str(event.get("slug") or "") == reference
            ),
            None,
        )
        if not result:
            raise _not_found("Event")
        return result
    result = rows(
        await db(
            lambda: supabase.table("events")
            .select("*")
            .eq("org_id", org_id)
            .order("starts_at", desc=True)
            .execute(),
            "integration_default_event",
        )
    )
    if len(result) == 1:
        return result[0]
    if not result:
        raise _not_found("Event")
    raise HTTPException(
        status_code=400,
        detail="This organization has multiple events; pass an event id or slug.",
    )


async def _track_id_for_filter(
    org_id: str, event_id: str | None, track: str | None
) -> str | None:
    if not track:
        return None

    def _query():
        query = supabase.table("tracks").select("id, name").eq("org_id", org_id)
        if event_id:
            query = query.eq("event_id", event_id)
        return query.execute()

    track_rows = rows(await db(_query, "integration_track_filter"))
    match = next(
        (
            row
            for row in track_rows
            if str(row.get("id")) == track
            or str(row.get("name") or "").casefold() == track.casefold()
        ),
        None,
    )
    return str(match["id"]) if match else "__no_such_track__"


async def list_submissions(
    org_id: str,
    *,
    event_id: str | None = None,
    status: str | None = None,
    track: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    _check_session_status(status)
    if event_id:
        await fetch_event(event_id, org_id)
    track_id = await _track_id_for_filter(org_id, event_id, track)

    def _query():
        query = supabase.table("sessions").select("*").eq("org_id", org_id)
        if event_id:
            query = query.eq("event_id", event_id)
        if status:
            query = query.eq("status", status)
        if track_id:
            query = query.eq("track_id", track_id)
        return query.execute()

    sessions = rows(await db(_query, "integration_list_submissions"))
    sessions.sort(
        key=lambda row: (
            row.get("starts_at") is None,
            str(row.get("starts_at") or ""),
            row.get("friendly_id_raw") or 0,
        )
    )
    envelope = paginate(sessions, page, page_size)
    envelope["data"] = await _serialize_sessions(envelope["data"], org_id)
    return envelope


async def get_submission(
    org_id: str, submission_id: str, *, event_id: str | None = None
) -> dict:
    def _query():
        query = (
            supabase.table("sessions")
            .select("*")
            .eq("id", submission_id)
            .eq("org_id", org_id)
        )
        if event_id:
            query = query.eq("event_id", event_id)
        return query.limit(1).execute()

    submission = first(await db(_query, "integration_get_submission"))
    if not submission:
        raise _not_found("Submission")
    return (await _serialize_sessions([submission], org_id))[0]


async def _verify_taxonomy(
    table: str, item_id: str | None, event_id: str, org_id: str, label: str
) -> None:
    if not item_id:
        return
    item = first(
        await db(
            lambda: supabase.table(table)
            .select("id")
            .eq("id", item_id)
            .eq("event_id", event_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            f"integration_verify_{table}",
        )
    )
    if not item:
        raise HTTPException(status_code=400, detail=f"{label} not found")


async def _upsert_submitter(
    org_id: str,
    event_id: str,
    email: str,
    first_name: str,
    last_name: str,
) -> dict:
    normalized = normalize_email(email)
    if not looks_like_email(normalized):
        raise HTTPException(status_code=400, detail="Enter a valid submitter email")
    existing = first(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("email", normalized)
            .limit(1)
            .execute(),
            "integration_submitter_lookup",
        )
    )
    if existing:
        return existing
    created = first(
        await db(
            lambda: supabase.table("contacts")
            .insert(
                {
                    "org_id": org_id,
                    "event_id": event_id,
                    "email": normalized,
                    "first_name": first_name.strip(),
                    "last_name": last_name.strip(),
                }
            )
            .execute(),
            "integration_submitter_create",
        )
    )
    if not created:
        raise HTTPException(
            status_code=500, detail="Could not create the submitter contact"
        )
    return created


async def create_submission(
    org_id: str,
    event_id: str,
    *,
    title: str,
    abstract: str = "",
    submitter_email: str,
    submitter_first_name: str = "",
    submitter_last_name: str = "",
    track_id: str | None = None,
    format_id: str | None = None,
) -> dict:
    await fetch_event(event_id, org_id)
    if not title.strip():
        raise HTTPException(status_code=400, detail="title is required")
    await _verify_taxonomy("tracks", track_id, event_id, org_id, "Track")
    await _verify_taxonomy("formats", format_id, event_id, org_id, "Format")
    contact = await _upsert_submitter(
        org_id,
        event_id,
        submitter_email,
        submitter_first_name,
        submitter_last_name,
    )
    counter = await db(
        lambda: supabase.rpc(
            "next_friendly_id", {"p_event_id": event_id}
        ).execute(),
        "integration_submission_friendly_id",
    )
    friendly_id_raw: Any = getattr(counter, "data", None)
    if isinstance(friendly_id_raw, list) and friendly_id_raw:
        friendly_id_raw = friendly_id_raw[0]
    if friendly_id_raw is None:
        raise HTTPException(
            status_code=500, detail="Could not allocate submission id"
        )
    record: dict = {
        "org_id": org_id,
        "event_id": event_id,
        "friendly_id_raw": int(friendly_id_raw),
        "title": title.strip(),
        "description": abstract.strip(),
        "status": "pending",
        "is_abstract": True,
        "form_answers": {},
        "submitter_contact_id": contact["id"],
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    if track_id:
        record["track_id"] = track_id
    if format_id:
        record["format_id"] = format_id
    created = first(
        await db(
            lambda: supabase.table("sessions").insert(record).execute(),
            "integration_submission_create",
        )
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not create submission")
    await db(
        lambda: supabase.table("session_participants")
        .insert(
            {
                "org_id": org_id,
                "session_id": created["id"],
                "contact_id": contact["id"],
                "role": "submitter",
                "is_primary": True,
            }
        )
        .execute(),
        "integration_submission_participant",
    )
    if track_id:
        await db(
            lambda: supabase.table("session_tracks")
            .upsert(
                {
                    "org_id": org_id,
                    "session_id": created["id"],
                    "track_id": track_id,
                },
                on_conflict="session_id,track_id",
            )
            .execute(),
            "integration_submission_track",
        )
    return await get_submission(org_id, str(created["id"]), event_id=event_id)


async def update_submission(
    org_id: str,
    submission_id: str,
    *,
    status: str | None = None,
    title: str | None = None,
    abstract: str | None = None,
    fields_set: set[str] | None = None,
    feedback: str | None = None,
) -> dict:
    existing = first(
        await db(
            lambda: supabase.table("sessions")
            .select("*")
            .eq("id", submission_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "integration_submission_update_lookup",
        )
    )
    if not existing:
        raise _not_found("Submission")
    present = fields_set or {
        key
        for key, value in {
            "status": status,
            "title": title,
            "abstract": abstract,
            "feedback": feedback,
        }.items()
        if value is not None
    }
    patch: dict = {}
    if "status" in present:
        if status is None:
            raise HTTPException(status_code=400, detail="status cannot be null")
        _check_session_status(status)
        patch["status"] = status
    if "title" in present:
        if title is None or not title.strip():
            raise HTTPException(status_code=400, detail="title cannot be blank")
        patch["title"] = title.strip()
    if "abstract" in present:
        patch["description"] = (abstract or "").strip()
    if "feedback" in present:
        custom_fields = dict(existing.get("custom_fields") or {})
        custom_fields["decision_feedback"] = (feedback or "").strip()
        patch["custom_fields"] = custom_fields
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    patch["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = first(
        await db(
            lambda: supabase.table("sessions")
            .update(patch)
            .eq("id", submission_id)
            .eq("org_id", org_id)
            .execute(),
            "integration_submission_update",
        )
    )
    if not updated:
        raise _not_found("Submission")
    return await get_submission(org_id, submission_id)


async def decide_submission(
    org_id: str, submission_id: str, decision: str, feedback: str | None = None
) -> dict:
    normalized = decision.strip().lower()
    statuses = {
        "accept": "accepted",
        "approve": "accepted",
        "accepted": "accepted",
        "maybe": "accept_queue",
        "accept_queue": "accept_queue",
        "decline": "declined",
        "deny": "declined",
        "declined": "declined",
    }
    if normalized not in statuses:
        raise HTTPException(
            status_code=400,
            detail="decision must be accept, maybe, or decline",
        )
    fields = {"status"}
    if feedback is not None:
        fields.add("feedback")
    return await update_submission(
        org_id,
        submission_id,
        status=statuses[normalized],
        feedback=feedback,
        fields_set=fields,
    )


async def _invited_contact_ids(org_id: str, contact_ids: list[str]) -> set[str]:
    if not contact_ids:
        return set()
    links = rows(
        await db(
            lambda: supabase.table("magic_link_tokens")
            .select("contact_id")
            .eq("org_id", org_id)
            .eq("purpose", "portal")
            .in_("contact_id", contact_ids)
            .execute(),
            "integration_speaker_invites",
        )
    )
    return {str(row["contact_id"]) for row in links if row.get("contact_id")}


async def list_speakers(
    org_id: str,
    *,
    event_id: str | None = None,
    status: str | None = None,
    filter_text: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    status = _check_speaker_status(status)
    if event_id:
        await fetch_event(event_id, org_id)

    def _query():
        query = supabase.table("contacts").select("*").eq("org_id", org_id)
        if event_id:
            query = query.eq("event_id", event_id)
        if status:
            query = query.eq("speaker_status", status)
        return query.execute()

    contacts = rows(await db(_query, "integration_list_speakers"))
    if filter_text:
        needle = filter_text.casefold().strip()
        contacts = [
            row
            for row in contacts
            if needle
            in " ".join(
                str(row.get(key) or "")
                for key in (
                    "first_name",
                    "last_name",
                    "email",
                    "company_name",
                    "title",
                    "speaker_status",
                )
            ).casefold()
        ]
    contacts.sort(
        key=lambda row: (
            str(row.get("last_name") or "").casefold(),
            str(row.get("first_name") or "").casefold(),
            str(row.get("email") or "").casefold(),
        )
    )
    envelope = paginate(contacts, page, page_size)
    invited = await _invited_contact_ids(
        org_id, [str(row["id"]) for row in envelope["data"] if row.get("id")]
    )
    envelope["data"] = [
        _serialize_speaker(row, invited=str(row.get("id")) in invited)
        for row in envelope["data"]
    ]
    return envelope


async def get_speaker(
    org_id: str, speaker_id: str, *, event_id: str | None = None
) -> dict:
    def _query():
        query = (
            supabase.table("contacts")
            .select("*")
            .eq("id", speaker_id)
            .eq("org_id", org_id)
        )
        if event_id:
            query = query.eq("event_id", event_id)
        return query.limit(1).execute()

    speaker = first(await db(_query, "integration_get_speaker"))
    if not speaker:
        raise _not_found("Speaker")
    invited = await _invited_contact_ids(org_id, [speaker_id])
    return _serialize_speaker(speaker, invited=speaker_id in invited)


async def create_speaker(
    org_id: str,
    event_id: str,
    *,
    email: str,
    first_name: str = "",
    last_name: str = "",
    company_name: str | None = None,
    title: str | None = None,
    about: str | None = None,
    speaker_status: str | None = None,
    logistics_notes: str | None = None,
) -> dict:
    await fetch_event(event_id, org_id)
    normalized_email = normalize_email(email)
    if not looks_like_email(normalized_email):
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    clash = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("email", normalized_email)
            .limit(1)
            .execute(),
            "integration_speaker_create_clash",
        )
    )
    if clash:
        raise HTTPException(
            status_code=409, detail="A speaker already uses that email."
        )
    record = {
        "org_id": org_id,
        "event_id": event_id,
        "email": normalized_email,
        "first_name": first_name.strip(),
        "last_name": last_name.strip(),
        "company_name": company_name,
        "title": title,
        "about": about,
        "speaker_status": _check_speaker_status(speaker_status),
        "logistics_notes": logistics_notes,
    }
    created = first(
        await db(
            lambda: supabase.table("contacts").insert(record).execute(),
            "integration_speaker_create",
        )
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not create speaker")
    return _serialize_speaker(created)


async def update_speaker(
    org_id: str,
    speaker_id: str,
    values: dict,
    *,
    event_id: str | None = None,
) -> dict:
    existing = first(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("id", speaker_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "integration_speaker_update_lookup",
        )
    )
    if not existing or (event_id and existing.get("event_id") != event_id):
        raise _not_found("Speaker")
    allowed = {
        "first_name",
        "last_name",
        "email",
        "company_name",
        "title",
        "about",
        "photo_url",
        "pronouns",
        "linkedin_url",
        "twitter_url",
        "phone",
        "speaker_status",
        "logistics_notes",
    }
    patch = {key: value for key, value in values.items() if key in allowed}
    for key in (
        "first_name",
        "last_name",
        "company_name",
        "title",
        "about",
        "logistics_notes",
    ):
        if key in patch and isinstance(patch[key], str):
            patch[key] = patch[key].strip()
    if "speaker_status" in patch:
        patch["speaker_status"] = _check_speaker_status(patch["speaker_status"])
    if "email" in patch:
        email = normalize_email(patch["email"] or "")
        if not looks_like_email(email):
            raise HTTPException(status_code=400, detail="Enter a valid email address")
        clash = first(
            await db(
                lambda: supabase.table("contacts")
                .select("id")
                .eq("org_id", org_id)
                .eq("event_id", existing["event_id"])
                .eq("email", email)
                .limit(1)
                .execute(),
                "integration_speaker_update_clash",
            )
        )
        if clash and str(clash.get("id")) != speaker_id:
            raise HTTPException(
                status_code=409, detail="Another speaker already uses that email."
            )
        patch["email"] = email
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    patch["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = first(
        await db(
            lambda: supabase.table("contacts")
            .update(patch)
            .eq("id", speaker_id)
            .eq("org_id", org_id)
            .execute(),
            "integration_speaker_update",
        )
    )
    if not updated:
        raise _not_found("Speaker")
    invited = await _invited_contact_ids(org_id, [speaker_id])
    return _serialize_speaker(updated, invited=speaker_id in invited)


async def invite_speaker_to_portal(org_id: str, speaker_id: str) -> dict:
    speaker = first(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("id", speaker_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "integration_portal_invite_speaker",
        )
    )
    if not speaker:
        raise _not_found("Speaker")
    if not speaker.get("email"):
        raise HTTPException(status_code=400, detail="This speaker has no email address.")
    event = await fetch_event(str(speaker["event_id"]), org_id)
    token = await mint(
        org_id,
        "portal",
        contact_id=speaker_id,
        ttl_hours=PORTAL_INVITE_TTL_HOURS,
    )
    invite_url = f"{settings.frontend_url.rstrip('/')}/portal/{token}"
    greeting = html.escape((speaker.get("first_name") or "").strip() or "there")
    event_name = html.escape(str(event.get("name") or "the event"))
    await db(
        lambda: supabase.table("email_outbox")
        .insert(
            {
                "org_id": org_id,
                "event_id": event["id"],
                "contact_id": speaker_id,
                "template_key": "portal_invite",
                "payload": {
                    "subject": f"[{event.get('name') or 'Event'}] Your speaker portal",
                    "html": (
                        f"<p>Hi {greeting},</p><p>Open your speaker portal for "
                        f"{event_name}: <a href=\"{html.escape(invite_url)}\">"
                        "speaker portal</a>.</p>"
                    ),
                },
                "status": "queued",
            }
        )
        .execute(),
        "integration_portal_invite_email",
    )
    return {"speaker_id": speaker_id, "invited": True, "invite_url": invite_url}


async def list_taxonomy(
    org_id: str,
    event_id: str,
    table: str,
    *,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    await fetch_event(event_id, org_id)
    if table not in {"tracks", "formats", "rooms"}:
        raise ValueError("Unsupported taxonomy")
    items = rows(
        await db(
            lambda: supabase.table(table)
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            f"integration_list_{table}",
        )
    )
    items.sort(
        key=lambda row: (
            row.get("order") if isinstance(row.get("order"), int) else 0,
            str(row.get("name") or "").casefold(),
        )
    )
    return paginate(items, page, page_size)


async def list_schedule(org_id: str, event_id: str) -> dict:
    event = await fetch_event(event_id, org_id)
    sessions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "integration_list_schedule",
        )
    )
    sessions.sort(
        key=lambda row: (
            row.get("starts_at") is None,
            str(row.get("starts_at") or ""),
            str(row.get("title") or "").casefold(),
        )
    )
    return {
        "event": _serialize_event(event),
        "rooms": (
            await list_taxonomy(
                org_id, event_id, "rooms", page=1, page_size=MAX_PAGE_SIZE
            )
        )["data"],
        "tracks": (
            await list_taxonomy(
                org_id, event_id, "tracks", page=1, page_size=MAX_PAGE_SIZE
            )
        )["data"],
        "sessions": await _serialize_sessions(sessions, org_id),
    }


async def place_session(
    org_id: str, submission_id: str, room: str, start: str | datetime
) -> dict:
    existing = first(
        await db(
            lambda: supabase.table("sessions")
            .select("*")
            .eq("id", submission_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "integration_place_session_lookup",
        )
    )
    if not existing:
        raise _not_found("Session")
    rooms_for_event = rows(
        await db(
            lambda: supabase.table("rooms")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", existing["event_id"])
            .execute(),
            "integration_place_room_lookup",
        )
    )
    room_row = next(
        (
            item
            for item in rooms_for_event
            if str(item.get("id")) == room
            or str(item.get("name") or "").casefold() == room.casefold()
        ),
        None,
    )
    if not room_row:
        raise HTTPException(status_code=400, detail="Room not found")
    starts_at = _as_datetime(start)
    duration = DEFAULT_SESSION_MINUTES
    if existing.get("starts_at") and existing.get("ends_at"):
        old_start = _as_datetime(existing["starts_at"])
        old_end = _as_datetime(existing["ends_at"])
        old_duration = int((old_end - old_start).total_seconds() // 60)
        if old_duration > 0:
            duration = old_duration
    elif existing.get("format_id"):
        format_row = first(
            await db(
                lambda: supabase.table("formats")
                .select("default_duration_min")
                .eq("id", existing["format_id"])
                .eq("event_id", existing["event_id"])
                .eq("org_id", org_id)
                .limit(1)
                .execute(),
                "integration_place_format_lookup",
            )
        )
        if format_row and isinstance(format_row.get("default_duration_min"), int):
            duration = format_row["default_duration_min"]
    patch = {
        "room_id": room_row["id"],
        "starts_at": starts_at.isoformat(),
        "ends_at": (starts_at + timedelta(minutes=duration)).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        updated = first(
            await db(
                lambda: supabase.table("sessions")
                .update(patch)
                .eq("id", submission_id)
                .eq("org_id", org_id)
                .execute(),
                "integration_place_session",
            )
        )
    except APIError as exc:
        if getattr(exc, "code", None) != "23P01" and "exclusion" not in str(
            exc
        ).lower():
            raise
        raise HTTPException(
            status_code=409, detail="Room double-booked at that time."
        ) from None
    if not updated:
        raise _not_found("Session")
    return await get_submission(org_id, submission_id)


async def unschedule_session(org_id: str, submission_id: str) -> dict:
    existing = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id")
            .eq("id", submission_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "integration_unschedule_lookup",
        )
    )
    if not existing:
        raise _not_found("Session")
    updated = first(
        await db(
            lambda: supabase.table("sessions")
            .update(
                {
                    "room_id": None,
                    "starts_at": None,
                    "ends_at": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("id", submission_id)
            .eq("org_id", org_id)
            .execute(),
            "integration_unschedule_session",
        )
    )
    if not updated:
        raise _not_found("Session")
    return await get_submission(org_id, submission_id)


async def list_content_items(
    org_id: str,
    event_id: str,
    *,
    status: str | None = None,
    item_type: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    if status and status not in CONTENT_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown content status '{status}'")
    result = await content_pipeline.list_content(
        org_id, event_id, status=status, item_type=item_type
    )
    envelope = paginate(result["items"], page, page_size)
    envelope["meta"] = {
        "event": result["event"],
        "counts": result["counts"],
        "outstanding": result["outstanding"],
    }
    return envelope


async def content_status(org_id: str, event_id: str) -> dict:
    """Return concise deliverable counts and the outstanding-speaker rollup."""
    result = await content_pipeline.list_content(org_id, event_id)
    return {
        "event": result["event"],
        "counts": result["counts"],
        "outstanding": result["outstanding"],
    }


async def list_evaluation_plans(
    org_id: str,
    event_id: str,
    *,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    plans = await evaluations.list_plans(org_id, event_id)
    return paginate(plans, page, page_size)


async def evaluation_summary(org_id: str, plan_id: str) -> dict:
    plan = await evaluations.fetch_plan(plan_id, org_id)
    summary = await evaluations.get_summary(org_id, plan_id)
    return {
        "plan": {
            "id": plan.get("id"),
            "event_id": plan.get("event_id"),
            "name": plan.get("name"),
            "status": plan.get("status"),
            "scale": plan.get("scale"),
        },
        **summary,
    }


async def remind_outstanding_content(org_id: str, event_id: str) -> dict:
    event = await fetch_event(event_id, org_id)
    groups = await content_pipeline.outstanding_by_contact(org_id, event_id)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    reminded = 0
    for group in groups:
        dedupe_key = f"content-reminder:{group.get('contact_id')}:{day}"
        duplicate = first(
            await db(
                lambda dedupe_key=dedupe_key: supabase.table("email_outbox")
                .select("id")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .eq("dedupe_key", dedupe_key)
                .limit(1)
                .execute(),
                "integration_content_reminder_dedupe",
            )
        )
        if duplicate:
            continue
        missing = "".join(
            f"<li>{html.escape(str(item))}</li>" for item in group.get("missing", [])
        )
        await db(
            lambda group=group, dedupe_key=dedupe_key, missing=missing: supabase.table(
                "email_outbox"
            )
            .insert(
                {
                    "org_id": org_id,
                    "event_id": event_id,
                    "contact_id": group.get("contact_id"),
                    "template_key": "content_reminder",
                    "payload": {
                        "subject": f"[{event.get('name') or 'Event'}] Content still needed",
                        "html": f"<p>We are still missing:</p><ul>{missing}</ul>",
                    },
                    "dedupe_key": dedupe_key,
                    "status": "queued",
                }
            )
            .execute(),
            "integration_content_reminder",
        )
        reminded += 1
    return {
        "event_id": event_id,
        "reminded": reminded,
        "outstanding": len(groups),
        "contacts": [group.get("contact_id") for group in groups],
    }


async def run_ai_triage(org_id: str, plan_id: str) -> dict:
    return await evaluations.run_ai_triage(org_id, plan_id)
