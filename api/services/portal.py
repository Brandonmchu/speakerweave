"""Speaker portal service — the self-service surface behind a magic-link cookie.

Requirement #2: a speaker signs in with a magic link, edits their own bio /
headshot / socials, sees the sessions they're on, and works a checklist of
onboarding tasks (todo, file upload). Everything here is scoped to
``(org_id, contact_id)`` taken from the *cookie*, never from the request body —
so one speaker can never read or mutate another's row even though the
service-role client bypasses RLS.

Uploads go through the backend (never the browser) to the public
``portal-files`` bucket: the bytes are validated first (extension allowlist +
magic-byte sniff + size cap), then written with the service-role client, and the
file's public URL is handed back.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from security.upload_validation import UploadValidationError, validate_upload
from services.forms import sanitize_html
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

PORTAL_BUCKET = "portal-files"
DEFAULT_ACCENT = "#4962E2"

# Scalar profile fields a speaker may set on themselves. `about` (the bio) is
# handled separately because it is sanitized rather than merely trimmed.
PROFILE_TEXT_FIELDS = (
    "first_name",
    "last_name",
    "company_name",
    "title",
    "pronouns",
    "linkedin_url",
    "twitter_url",
    "phone",
)

# The contact columns the portal ever exposes to the speaker themselves. Email
# is shown but not editable here; internal columns (custom_fields, org_id …)
# never leave the service.
_CONTACT_COLUMNS = (
    "id, first_name, last_name, email, about, company_name, title, pronouns, "
    "photo_url, linkedin_url, twitter_url, phone, last_portal_access_at"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _public_url_for(bucket_path: str | None) -> str | None:
    """Public URL of a stored object, derived from its path.

    Recomputed from ``SUPABASE_URL`` rather than stored so a bucket rename or
    project move can't strand old rows on a dead absolute URL. Matches the shape
    supabase ``get_public_url`` returns for a public bucket.
    """
    if not bucket_path:
        return None
    base = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    return f"{base}/storage/v1/object/public/{PORTAL_BUCKET}/{bucket_path}"


def _public_contact(contact: dict) -> dict:
    return {
        "id": contact.get("id"),
        "first_name": contact.get("first_name") or "",
        "last_name": contact.get("last_name") or "",
        "email": contact.get("email"),
        "about": contact.get("about") or "",
        "company_name": contact.get("company_name") or "",
        "title": contact.get("title") or "",
        "pronouns": contact.get("pronouns") or "",
        "photo_url": contact.get("photo_url"),
        "linkedin_url": contact.get("linkedin_url") or "",
        "twitter_url": contact.get("twitter_url") or "",
        "phone": contact.get("phone") or "",
    }


def _public_portal(portal: dict | None) -> dict:
    portal = portal or {}
    return {
        "name": portal.get("name") or "Speaker Portal",
        # Organizer-authored rich text rendered via dangerouslySetInnerHTML on
        # the portal — the server is the authoritative sanitizer.
        "welcome_html": sanitize_html(portal.get("welcome_html")),
        "accent_color": portal.get("accent_color") or DEFAULT_ACCENT,
        "logo_url": portal.get("logo_url"),
    }


async def load_contact(org_id: str, contact_id: str) -> dict:
    """The speaker's own contact row, or 404. This IS the ownership check —
    every mutating helper calls it before it writes."""
    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("id", contact_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "portal_contact_lookup",
        )
    )
    if not contact or contact.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail="Speaker not found")
    return contact


async def stamp_portal_access(org_id: str, contact_id: str) -> None:
    """Record that the speaker opened the portal. Best-effort: a failed stamp
    must not blank the page they came to see."""
    try:
        await db(
            lambda: supabase.table("contacts")
            .update({"last_portal_access_at": _now_iso()})
            .eq("id", contact_id)
            .eq("org_id", org_id)
            .execute(),
            "portal_stamp_access",
        )
    except Exception:  # pragma: no cover - defensive
        logger.warning(
            "portal: could not stamp last_portal_access_at contact=%s", contact_id, exc_info=True
        )


async def _my_sessions(org_id: str, contact_id: str) -> list[dict]:
    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("session_id, role, is_primary")
            .eq("org_id", org_id)
            .eq("contact_id", contact_id)
            .execute(),
            "portal_me_participants",
        )
    )
    session_ids = sorted({p["session_id"] for p in participants if p.get("session_id")})
    if not session_ids:
        return []

    session_rows = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id, title, status, friendly_id, starts_at, ends_at")
            .eq("org_id", org_id)
            .in_("id", session_ids)
            .execute(),
            "portal_me_sessions",
        )
    )
    sessions_by_id = {s["id"]: s for s in session_rows}

    # One person can be both submitter and speaker on a session; show the more
    # meaningful stage role, and remember if they're the primary contact.
    role_by_session: dict[str, str] = {}
    primary_sessions: set[str] = set()
    for participant in participants:
        session_id = participant.get("session_id")
        if session_id not in sessions_by_id:
            continue
        role = participant.get("role")
        current = role_by_session.get(session_id)
        if current is None or (current == "submitter" and role != "submitter"):
            role_by_session[session_id] = role
        if participant.get("is_primary"):
            primary_sessions.add(session_id)

    result = [
        {
            "id": session_id,
            "title": sessions_by_id[session_id].get("title"),
            "status": sessions_by_id[session_id].get("status"),
            "friendly_id": sessions_by_id[session_id].get("friendly_id"),
            "starts_at": sessions_by_id[session_id].get("starts_at"),
            "ends_at": sessions_by_id[session_id].get("ends_at"),
            "role": role_by_session.get(session_id),
            "is_primary": session_id in primary_sessions,
        }
        for session_id in session_ids
        if session_id in sessions_by_id
    ]
    result.sort(key=lambda row: (not row["is_primary"], str(row.get("title") or "")))
    return result


async def _my_tasks(org_id: str, contact_id: str) -> list[dict]:
    assignments = rows(
        await db(
            lambda: supabase.table("task_assignments")
            .select("id, task_id, status, completed_at, file_id")
            .eq("org_id", org_id)
            .eq("contact_id", contact_id)
            .execute(),
            "portal_me_assignments",
        )
    )
    if not assignments:
        return []

    task_ids = sorted({a["task_id"] for a in assignments if a.get("task_id")})
    file_ids = sorted({a["file_id"] for a in assignments if a.get("file_id")})

    tasks_by_id: dict[str, dict] = {}
    if task_ids:
        for task in rows(
            await db(
                lambda: supabase.table("tasks")
                .select("id, name, description, kind, link_url, due_at, required, order")
                .eq("org_id", org_id)
                .in_("id", task_ids)
                .execute(),
                "portal_me_tasks",
            )
        ):
            tasks_by_id[task["id"]] = task

    files_by_id: dict[str, dict] = {}
    if file_ids:
        for file_row in rows(
            await db(
                lambda: supabase.table("files")
                .select("id, filename, bucket_path")
                .eq("org_id", org_id)
                .in_("id", file_ids)
                .execute(),
                "portal_me_files",
            )
        ):
            files_by_id[file_row["id"]] = file_row

    result: list[dict] = []
    for assignment in assignments:
        task = tasks_by_id.get(assignment.get("task_id"))
        if not task:
            continue
        file_row = files_by_id.get(assignment.get("file_id"))
        file_out = (
            {"filename": file_row.get("filename"), "url": _public_url_for(file_row.get("bucket_path"))}
            if file_row
            else None
        )
        result.append(
            {
                "assignment_id": assignment["id"],
                "status": assignment.get("status"),
                "completed_at": assignment.get("completed_at"),
                "task": {
                    "id": task["id"],
                    "name": task.get("name"),
                    "description": task.get("description"),
                    "kind": task.get("kind"),
                    "link_url": task.get("link_url"),
                    "due_at": task.get("due_at"),
                    "required": bool(task.get("required")),
                },
                "file": file_out,
            }
        )

    result.sort(
        key=lambda row: (
            tasks_by_id.get(row["task"]["id"], {}).get("order") or 0,
            str(row["task"].get("name") or ""),
        )
    )
    return result


async def build_me(org_id: str, contact_id: str) -> dict:
    """The whole portal payload, and stamp the visit while we're here."""
    contact = await load_contact(org_id, contact_id)
    await stamp_portal_access(org_id, contact_id)

    event_id = contact.get("event_id")
    event = None
    portal = None
    if event_id:
        event = first(
            await db(
                lambda: supabase.table("events")
                .select("id, name")
                .eq("id", event_id)
                .eq("org_id", org_id)
                .limit(1)
                .execute(),
                "portal_me_event",
            )
        )
        portal = first(
            await db(
                lambda: supabase.table("portals")
                .select("name, welcome_html, accent_color, logo_url")
                .eq("event_id", event_id)
                .eq("org_id", org_id)
                .limit(1)
                .execute(),
                "portal_me_portal",
            )
        )

    return {
        "contact": _public_contact(contact),
        "event": {"name": (event or {}).get("name")},
        "portal": _public_portal(portal),
        "sessions": await _my_sessions(org_id, contact_id),
        "tasks": await _my_tasks(org_id, contact_id),
    }


async def update_profile(org_id: str, contact_id: str, patch: dict) -> dict:
    """Update the speaker's own profile. `about` is sanitized (stored rich text
    the organizer later renders); the rest are trimmed scalars."""
    await load_contact(org_id, contact_id)  # ownership gate

    clean: dict = {}
    for field in PROFILE_TEXT_FIELDS:
        if field in patch and patch[field] is not None:
            clean[field] = str(patch[field]).strip()
    if "about" in patch and patch["about"] is not None:
        clean["about"] = sanitize_html(patch["about"])

    if not clean:
        raise HTTPException(status_code=400, detail="Nothing to update")
    clean["updated_at"] = _now_iso()

    updated = first(
        await db(
            lambda: supabase.table("contacts")
            .update(clean)
            .eq("id", contact_id)
            .eq("org_id", org_id)
            .execute(),
            "portal_profile_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Speaker not found")
    return _public_contact(updated)


async def _get_assignment(org_id: str, contact_id: str, assignment_id: str) -> dict:
    """A task assignment that belongs to THIS speaker, or 404. Scoping by
    contact_id is what stops one speaker completing another's task."""
    assignment = first(
        await db(
            lambda: supabase.table("task_assignments")
            .select("id, task_id, status, file_id, contact_id, org_id")
            .eq("id", assignment_id)
            .eq("org_id", org_id)
            .eq("contact_id", contact_id)
            .limit(1)
            .execute(),
            "portal_assignment_lookup",
        )
    )
    if not assignment:
        raise HTTPException(status_code=404, detail="Task not found")
    return assignment


async def _get_task(org_id: str, task_id: str) -> dict:
    task = first(
        await db(
            lambda: supabase.table("tasks")
            .select("id, kind, name")
            .eq("id", task_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "portal_task_lookup",
        )
    )
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


async def complete_todo(org_id: str, contact_id: str, assignment_id: str) -> dict:
    assignment = await _get_assignment(org_id, contact_id, assignment_id)
    task = await _get_task(org_id, assignment["task_id"])
    if task.get("kind") != "todo":
        raise HTTPException(status_code=400, detail="This task can't be checked off directly.")

    now = _now_iso()
    updated = first(
        await db(
            lambda: supabase.table("task_assignments")
            .update({"status": "done", "completed_at": now})
            .eq("id", assignment_id)
            .eq("org_id", org_id)
            .eq("contact_id", contact_id)
            .execute(),
            "portal_task_complete",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"assignment_id": assignment_id, "status": "done", "completed_at": now}


async def store_upload(
    org_id: str, contact_id: str, ext: str, content: bytes, mimetype: str
) -> tuple[str, str]:
    """Write validated bytes to the public bucket; return (bucket_path, url).

    Path convention ``{org_id}/{contact_id}/{uuid4}{ext}`` keeps every object
    namespaced to the speaker who uploaded it. The public URL comes straight
    from ``get_public_url`` as required.
    """
    path = f"{org_id}/{contact_id}/{uuid.uuid4().hex}{ext}"

    def _upload() -> str:
        supabase.storage.from_(PORTAL_BUCKET).upload(
            path,
            content,
            {"content-type": mimetype, "upsert": "true"},
        )
        return supabase.storage.from_(PORTAL_BUCKET).get_public_url(path)

    try:
        public_url = await run_in_threadpool(_upload)
    except Exception as exc:
        logger.exception("portal: storage upload failed org=%s contact=%s", org_id, contact_id)
        raise HTTPException(status_code=502, detail="File storage is unavailable. Try again.") from exc

    # get_public_url occasionally returns a trailing "?" ; normalize it away.
    return path, (public_url or _public_url_for(path) or "").rstrip("?")


async def upload_task_file(
    org_id: str, contact_id: str, assignment_id: str, filename: str | None, content: bytes
) -> dict:
    assignment = await _get_assignment(org_id, contact_id, assignment_id)
    task = await _get_task(org_id, assignment["task_id"])
    if task.get("kind") != "file_request":
        raise HTTPException(status_code=400, detail="This task doesn't take a file.")
    if assignment.get("status") == "approved":
        raise HTTPException(status_code=409, detail="This file was already approved.")

    try:
        ext, mimetype = validate_upload(filename, content, category="document")
    except UploadValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    contact = await load_contact(org_id, contact_id)
    bucket_path, public_url = await store_upload(org_id, contact_id, ext, content, mimetype)

    file_row = first(
        await db(
            lambda: supabase.table("files")
            .insert(
                {
                    "org_id": org_id,
                    "event_id": contact.get("event_id"),
                    "contact_id": contact_id,
                    "task_assignment_id": assignment_id,
                    "bucket_path": bucket_path,
                    "filename": filename or f"upload{ext}",
                    "mimetype": mimetype,
                    "size": len(content),
                }
            )
            .execute(),
            "portal_file_insert",
        )
    )
    if not file_row:
        raise HTTPException(status_code=500, detail="Could not record the uploaded file.")

    await db(
        lambda: supabase.table("task_assignments")
        .update({"status": "submitted", "file_id": file_row["id"], "completed_at": None})
        .eq("id", assignment_id)
        .eq("org_id", org_id)
        .eq("contact_id", contact_id)
        .execute(),
        "portal_task_submit",
    )
    return {
        "assignment_id": assignment_id,
        "status": "submitted",
        "file": {"filename": filename or f"upload{ext}", "url": public_url},
    }


async def set_headshot(org_id: str, contact_id: str, filename: str | None, content: bytes) -> dict:
    await load_contact(org_id, contact_id)  # ownership gate
    try:
        ext, mimetype = validate_upload(filename, content, category="image")
    except UploadValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    _, public_url = await store_upload(org_id, contact_id, ext, content, mimetype)
    updated = first(
        await db(
            lambda: supabase.table("contacts")
            .update({"photo_url": public_url, "updated_at": _now_iso()})
            .eq("id", contact_id)
            .eq("org_id", org_id)
            .execute(),
            "portal_headshot_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Speaker not found")
    return {"photo_url": public_url}
