"""Content-collection pipeline — the shared engine behind the portal + library.

Speakers upload deliverables (slides, headshots, docs) as file-request tasks;
this module turns that raw stream into a managed pipeline:

* **Versioning** — every re-upload is a new ``files`` row with an incremented
  ``version`` (see ``services.portal.upload_task_file``); ``versions_for`` reads
  the history back, newest first, marking the current one. That history is also
  the item's change log, and ``restore_version`` rolls it back: "current" is
  only whichever row the assignment's ``file_id`` points at, so a restore moves
  a pointer and deletes nothing (and is itself reversible).
* **Comments / feedback** — a thread per content item (a ``task_assignment``)
  in ``content_comments``; organizers leave feedback, speakers reply. Scoping is
  always ``org_id`` (organizer) or ``contact_id`` (speaker), never the body.
* **Library** — ``list_content`` aggregates every deliverable across an event's
  speakers with type + status, so an organizer sees the whole collection at once
  and who is still outstanding.
* **Reminders** — ``outstanding_by_contact`` groups missing required items per
  speaker so the route can queue one nudge each.
* **Export** — ``build_export_zip`` bundles the current version of every
  collected file into a ZIP named by speaker / item; pass ``assignment_ids`` to
  bundle only a hand-picked selection instead of the whole event.

Pure helpers (``classify_item_type``, ``content_status``) carry no I/O so both
surfaces classify identically.
"""

from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import datetime, timezone

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from services.org_scope import fetch_event
from services.portal import PORTAL_BUCKET, _public_url_for
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

# The task kind whose assignments ARE content items. todo/form tasks are not
# collected content.
CONTENT_TASK_KIND = "file_request"

# assignment status → library status. A todo is "we never got it"; a denial is
# "we got it but it needs changes"; anything with a live file is "received".
_STATUS_MAP = {
    "todo": "missing",
    "submitted": "received",
    "approved": "received",
    "done": "received",
    "denied": "needs_changes",
}
CONTENT_STATUSES = ("received", "missing", "needs_changes")
CONTENT_TYPES = ("slides", "headshot", "bio", "other")

# Keyword → item type, checked in order. Lets an organizer model "Headshot" or
# "Speaker bio" as file tasks and have them classified for the type filter.
_TYPE_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("headshot", ("headshot", "head shot", "photo", "portrait", "picture")),
    ("bio", ("bio", "biography", "about you")),
    ("slides", ("slide", "deck", "presentation", "talk", "keynote")),
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def classify_item_type(task_name: str | None) -> str:
    """Bucket a file-request task into slides / headshot / bio / other by name."""
    name = (task_name or "").lower()
    for item_type, keywords in _TYPE_KEYWORDS:
        if any(keyword in name for keyword in keywords):
            return item_type
    return "other"


def content_status(assignment_status: str | None) -> str:
    """Map a task_assignment status to the library's received/missing/needs_changes."""
    return _STATUS_MAP.get(assignment_status or "todo", "missing")


def _contact_name(contact: dict) -> str:
    name = " ".join(
        part for part in (contact.get("first_name"), contact.get("last_name")) if part
    ).strip()
    return name or str(contact.get("email") or "Speaker")


def _slug(value: str, fallback: str) -> str:
    """A single, path-safe filename component.

    Hardened against ZIP path traversal: no ``/`` survives the allow-list, and
    leading/trailing dots plus any interior ``..`` are neutralized so a speaker
    literally named ``..`` can never produce a ``../`` archive entry.
    """
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (value or "").strip())
    cleaned = cleaned.strip("._-")  # kill leading/trailing dots (and dashes/underscores)
    cleaned = cleaned.replace("..", "_")  # kill any interior traversal sequence
    return cleaned or fallback


def _short(value: str | None) -> str:
    """A short, stable, path-safe id fragment (first 8 alnum chars of a uuid)."""
    fragment = re.sub(r"[^A-Za-z0-9]", "", value or "")[:8]
    return fragment or "0"


def _entry_name(
    speaker_name: str,
    contact_id: str | None,
    item_name: str | None,
    item_id: str | None,
    version: int,
    filename: str | None,
) -> str:
    """A unique, traversal-safe ZIP entry path for one collected file.

    ``{Speaker}-{contact}/{Item}-{item}-v{n}-{filename}`` — the contact id makes
    each speaker folder unique (two speakers named "Alex Kim" never merge), and
    the assignment id makes each item unique within a folder, so no two entries
    can collide and silently overwrite one another.
    """
    folder = f"{_slug(speaker_name, 'speaker')}-{_short(contact_id)}"
    title = _slug(item_name or "content", "content")
    fname = _slug(filename or f"file{_ext_of(filename)}", "file")
    return f"{folder}/{title}-{_short(item_id)}-v{version}-{fname}"


def _ext_of(filename: str | None) -> str:
    if not filename or "." not in filename:
        return ""
    return filename[filename.rfind(".") :]


# ── versions ─────────────────────────────────────────────────────────────────


def versions_for(file_rows: list[dict], current_file_id: str | None) -> list[dict]:
    """Version history for one item, newest first, with ``is_current`` marked.

    Current is the row the assignment points at (``file_id``); if that is stale
    or missing we fall back to the highest version number.
    """
    ordered = sorted(
        file_rows,
        key=lambda f: (int(f.get("version") or 1), str(f.get("created_at") or "")),
        reverse=True,
    )
    current_id = current_file_id
    if current_id not in {f.get("id") for f in ordered} and ordered:
        current_id = ordered[0].get("id")
    return [
        {
            "file_id": f.get("id"),
            "version": int(f.get("version") or 1),
            "filename": f.get("filename"),
            "url": _public_url_for(f.get("bucket_path")),
            "size": f.get("size"),
            "mimetype": f.get("mimetype"),
            "created_at": f.get("created_at"),
            "is_current": f.get("id") == current_id,
        }
        for f in ordered
    ]


def next_version(existing_file_rows: list[dict]) -> int:
    """The version number a fresh upload should take: one past the current max."""
    if not existing_file_rows:
        return 1
    return 1 + max(int(f.get("version") or 1) for f in existing_file_rows)


# ── shared aggregation ───────────────────────────────────────────────────────


async def _collect(org_id: str, event_id: str) -> dict:
    """Load the raw rows the library / reminders / export all build on.

    One grouped query per table (never per speaker), keyed off the event's
    file-request tasks. Everything stays org-scoped via the ``org_id`` predicate.
    """
    tasks = [
        t
        for t in rows(
            await db(
                lambda: supabase.table("tasks")
                .select("id, name, required, due_at")
                .eq("org_id", org_id)
                .eq("event_id", event_id)
                .eq("kind", CONTENT_TASK_KIND)
                .execute(),
                "content_tasks",
            )
        )
        if t.get("id")
    ]
    tasks_by_id = {t["id"]: t for t in tasks}
    task_ids = sorted(tasks_by_id)

    assignments: list[dict] = []
    if task_ids:
        assignments = rows(
            await db(
                lambda: supabase.table("task_assignments")
                .select("id, task_id, contact_id, status, file_id")
                .eq("org_id", org_id)
                .in_("task_id", task_ids)
                .execute(),
                "content_assignments",
            )
        )

    contact_ids = sorted({a["contact_id"] for a in assignments if a.get("contact_id")})
    contacts_by_id: dict[str, dict] = {}
    if contact_ids:
        for contact in rows(
            await db(
                lambda: supabase.table("contacts")
                .select("id, first_name, last_name, email, photo_url")
                .eq("org_id", org_id)
                .in_("id", contact_ids)
                .execute(),
                "content_contacts",
            )
        ):
            contacts_by_id[contact["id"]] = contact

    assignment_ids = sorted({a["id"] for a in assignments if a.get("id")})
    files_by_assignment: dict[str, list[dict]] = {}
    comments_by_assignment: dict[str, int] = {}
    if assignment_ids:
        for file_row in rows(
            await db(
                lambda: supabase.table("files")
                .select("id, task_assignment_id, filename, bucket_path, mimetype, size, version, created_at")
                .eq("org_id", org_id)
                .in_("task_assignment_id", assignment_ids)
                .execute(),
                "content_files",
            )
        ):
            files_by_assignment.setdefault(file_row.get("task_assignment_id"), []).append(file_row)
        for comment in rows(
            await db(
                lambda: supabase.table("content_comments")
                .select("id, task_assignment_id")
                .eq("org_id", org_id)
                .in_("task_assignment_id", assignment_ids)
                .execute(),
                "content_comment_counts",
            )
        ):
            key = comment.get("task_assignment_id")
            comments_by_assignment[key] = comments_by_assignment.get(key, 0) + 1

    return {
        "tasks_by_id": tasks_by_id,
        "assignments": assignments,
        "contacts_by_id": contacts_by_id,
        "files_by_assignment": files_by_assignment,
        "comments_by_assignment": comments_by_assignment,
    }


def _item_from(assignment: dict, ctx: dict) -> dict:
    task = ctx["tasks_by_id"].get(assignment.get("task_id"), {})
    contact = ctx["contacts_by_id"].get(assignment.get("contact_id"), {})
    file_rows = ctx["files_by_assignment"].get(assignment.get("id"), [])
    versions = versions_for(file_rows, assignment.get("file_id"))
    current = next((v for v in versions if v["is_current"]), None)
    return {
        "item_id": assignment.get("id"),
        "type": classify_item_type(task.get("name")),
        "title": task.get("name") or "Content item",
        "required": bool(task.get("required")),
        "due_at": task.get("due_at"),
        "assignment_status": assignment.get("status"),
        "status": content_status(assignment.get("status")),
        "current_version": current["version"] if current else 0,
        "versions_count": len(versions),
        "current_file": current,
        "comment_count": ctx["comments_by_assignment"].get(assignment.get("id"), 0),
        "updated_at": current["created_at"] if current else None,
        "speaker": {
            "contact_id": contact.get("id") or assignment.get("contact_id"),
            "name": _contact_name(contact) if contact else "Speaker",
            "email": contact.get("email"),
            "photo_url": contact.get("photo_url"),
        },
    }


_STATUS_ORDER = {"needs_changes": 0, "missing": 1, "received": 2}


async def list_content(
    org_id: str,
    event_id: str,
    *,
    item_type: str | None = None,
    status: str | None = None,
) -> dict:
    """The cross-speaker content library for an event, filtered + who's outstanding."""
    event = await fetch_event(event_id, org_id, columns="id, org_id, name")
    ctx = await _collect(org_id, event_id)

    items = [_item_from(a, ctx) for a in ctx["assignments"]]

    # who's outstanding: speakers with >=1 missing REQUIRED item (pre-filter).
    outstanding: dict[str, dict] = {}
    for item in items:
        if item["required"] and item["status"] == "missing":
            speaker = item["speaker"]
            entry = outstanding.setdefault(
                speaker["contact_id"],
                {
                    "contact_id": speaker["contact_id"],
                    "name": speaker["name"],
                    "email": speaker["email"],
                    "missing": [],
                },
            )
            entry["missing"].append(item["title"])

    if item_type and item_type not in ("all", ""):
        items = [i for i in items if i["type"] == item_type]
    if status and status not in ("all", ""):
        items = [i for i in items if i["status"] == status]

    items.sort(
        key=lambda i: (_STATUS_ORDER.get(i["status"], 3), str(i["speaker"]["name"]).lower(), i["title"])
    )

    counts = {s: sum(1 for i in items if i["status"] == s) for s in CONTENT_STATUSES}
    return {
        "event": {"id": event["id"], "name": event.get("name")},
        "items": items,
        "counts": counts,
        "outstanding": sorted(outstanding.values(), key=lambda o: str(o["name"]).lower()),
    }


async def _get_org_assignment(org_id: str, assignment_id: str) -> dict:
    """A task_assignment in THIS org, or 404 — the organizer ownership gate."""
    assignment = first(
        await db(
            lambda: supabase.table("task_assignments")
            .select("id, org_id, task_id, contact_id, status, file_id")
            .eq("id", assignment_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "content_assignment_lookup",
        )
    )
    if not assignment or assignment.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail="Content item not found")
    return assignment


async def _comments_for(org_id: str, assignment_id: str) -> list[dict]:
    comments = rows(
        await db(
            lambda: supabase.table("content_comments")
            .select("id, author_role, author_label, body, created_at")
            .eq("org_id", org_id)
            .eq("task_assignment_id", assignment_id)
            .execute(),
            "content_comments_list",
        )
    )
    comments.sort(key=lambda c: str(c.get("created_at") or ""))
    return [
        {
            "id": c.get("id"),
            "author_role": c.get("author_role"),
            "author_label": c.get("author_label"),
            "body": c.get("body"),
            "created_at": c.get("created_at"),
        }
        for c in comments
    ]


async def _files_for(org_id: str, assignment_id: str) -> list[dict]:
    return rows(
        await db(
            lambda: supabase.table("files")
            .select("id, task_assignment_id, filename, bucket_path, mimetype, size, version, created_at")
            .eq("org_id", org_id)
            .eq("task_assignment_id", assignment_id)
            .execute(),
            "content_item_files",
        )
    )


async def content_item(org_id: str, assignment_id: str) -> dict:
    """Full detail for one content item: versions + comment thread + speaker."""
    assignment = await _get_org_assignment(org_id, assignment_id)
    task = first(
        await db(
            lambda: supabase.table("tasks")
            .select("id, name, required, event_id")
            .eq("id", assignment.get("task_id"))
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "content_item_task",
        )
    ) or {}
    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id, first_name, last_name, email, photo_url")
            .eq("id", assignment.get("contact_id"))
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "content_item_contact",
        )
    ) or {}
    files = await _files_for(org_id, assignment_id)
    versions = versions_for(files, assignment.get("file_id"))
    current = next((v for v in versions if v["is_current"]), None)
    return {
        "item": {
            "item_id": assignment_id,
            "type": classify_item_type(task.get("name")),
            "title": task.get("name") or "Content item",
            "required": bool(task.get("required")),
            "assignment_status": assignment.get("status"),
            "status": content_status(assignment.get("status")),
            "current_version": current["version"] if current else 0,
            "speaker": {
                "contact_id": contact.get("id") or assignment.get("contact_id"),
                "name": _contact_name(contact) if contact else "Speaker",
                "email": contact.get("email"),
                "photo_url": contact.get("photo_url"),
            },
        },
        "versions": versions,
        "comments": await _comments_for(org_id, assignment_id),
    }


async def _task_for(org_id: str, assignment: dict) -> dict:
    """The task behind an assignment, org-scoped (never trusted from the body)."""
    return (
        first(
            await db(
                lambda: supabase.table("tasks")
                .select("id, name, event_id")
                .eq("id", assignment.get("task_id"))
                .eq("org_id", org_id)
                .limit(1)
                .execute(),
                "content_assignment_task",
            )
        )
        or {}
    )


async def _audit_comment(org_id: str, assignment: dict, task: dict, body: str) -> None:
    """Write an audit line into the item's thread. Best-effort: a failed audit
    must not undo the action it describes."""
    try:
        await db(
            lambda: supabase.table("content_comments")
            .insert(
                {
                    "org_id": org_id,
                    "event_id": task.get("event_id"),
                    "task_assignment_id": assignment.get("id"),
                    "contact_id": assignment.get("contact_id"),
                    "author_role": "organizer",
                    "author_label": "Organizer",
                    "body": body,
                    "created_at": _now_iso(),
                }
            )
            .execute(),
            "content_audit_comment",
        )
    except Exception:
        logger.warning("content: could not record audit line for %s", assignment.get("id"), exc_info=True)


async def restore_version(org_id: str, assignment_id: str, version: int) -> dict:
    """Make a prior version current again — a pointer move, not a rewrite.

    Every upload is kept as its own ``files`` row; the only thing that says
    which one is live is the assignment's ``file_id``. Restoring re-points it at
    the requested version and touches nothing else: no row is deleted, the
    version numbers keep their original meaning, and the restore can itself be
    undone by restoring the other way. An audit line lands in the item's comment
    thread so the change log reads as one story.

    Org-scoped through ``_get_org_assignment`` — a foreign item is a 404, and an
    unknown version on an item you DO own is a 404 too.
    """
    assignment = await _get_org_assignment(org_id, assignment_id)
    file_rows = await _files_for(org_id, assignment_id)
    try:
        wanted = int(version)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="version must be a number") from None

    target = next((f for f in file_rows if int(f.get("version") or 1) == wanted), None)
    if not target or not target.get("id"):
        raise HTTPException(status_code=404, detail=f"Version {wanted} not found for this item")

    already_current = assignment.get("file_id") == target["id"]
    if not already_current:
        updated = first(
            await db(
                lambda: supabase.table("task_assignments")
                .update({"file_id": target["id"]})
                .eq("id", assignment_id)
                .eq("org_id", org_id)
                .execute(),
                "content_restore_version",
            )
        )
        if not updated:
            raise HTTPException(status_code=404, detail="Content item not found")
        task = await _task_for(org_id, assignment)
        filename = target.get("filename") or "file"
        await _audit_comment(
            org_id,
            assignment,
            task,
            f"Restored v{wanted} ({filename}) as the current version.",
        )

    detail = await content_item(org_id, assignment_id)
    detail["restored"] = {"version": wanted, "file_id": target["id"], "changed": not already_current}
    return detail


async def add_organizer_comment(org_id: str, assignment_id: str, body: str) -> dict:
    """Organizer leaves feedback on a speaker's item. Returns the comment plus the
    speaker + task context so the route can queue a notification."""
    text = (body or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Comment cannot be empty")
    assignment = await _get_org_assignment(org_id, assignment_id)
    task = first(
        await db(
            lambda: supabase.table("tasks")
            .select("id, name, event_id")
            .eq("id", assignment.get("task_id"))
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "content_comment_task",
        )
    ) or {}
    contact = first(
        await db(
            lambda: supabase.table("contacts")
            .select("id, first_name, email")
            .eq("id", assignment.get("contact_id"))
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "content_comment_contact",
        )
    ) or {}
    comment = first(
        await db(
            lambda: supabase.table("content_comments")
            .insert(
                {
                    "org_id": org_id,
                    "event_id": task.get("event_id"),
                    "task_assignment_id": assignment_id,
                    "contact_id": assignment.get("contact_id"),
                    "author_role": "organizer",
                    "author_label": "Organizer",
                    "body": text,
                    "created_at": _now_iso(),
                }
            )
            .execute(),
            "content_comment_insert",
        )
    )
    if not comment:
        raise HTTPException(status_code=500, detail="Could not save comment")
    return {
        "comment": {
            "id": comment.get("id"),
            "author_role": "organizer",
            "author_label": "Organizer",
            "body": text,
            "created_at": comment.get("created_at"),
        },
        "contact": contact,
        "task": task,
    }


# ── reminders ────────────────────────────────────────────────────────────────


async def outstanding_by_contact(
    org_id: str,
    event_id: str,
    *,
    required_only: bool = True,
    item_type: str | None = None,
) -> list[dict]:
    """Speakers with missing content, grouped for one reminder each.

    ``missing`` means the deliverable was never uploaded (status todo). By
    default only required items count; pass ``required_only=False`` to nudge on
    any outstanding item. Contacts without an email are dropped (nothing to send).
    """
    await fetch_event(event_id, org_id, columns="id, org_id, name")
    ctx = await _collect(org_id, event_id)

    grouped: dict[str, dict] = {}
    for assignment in ctx["assignments"]:
        if content_status(assignment.get("status")) != "missing":
            continue
        task = ctx["tasks_by_id"].get(assignment.get("task_id"), {})
        if required_only and not task.get("required"):
            continue
        if item_type and item_type not in ("all", "") and classify_item_type(task.get("name")) != item_type:
            continue
        contact = ctx["contacts_by_id"].get(assignment.get("contact_id"))
        if not contact or not contact.get("email"):
            continue
        entry = grouped.setdefault(
            contact["id"],
            {
                "contact_id": contact["id"],
                "name": _contact_name(contact),
                "email": contact.get("email"),
                "first_name": contact.get("first_name") or "",
                "missing": [],
            },
        )
        entry["missing"].append(task.get("name") or "a content item")
    return sorted(grouped.values(), key=lambda g: str(g["name"]).lower())


# ── export ───────────────────────────────────────────────────────────────────


def _export_records(ctx: dict) -> list[dict]:
    """One record per collected file (current version only) — metadata only, no
    I/O. The ZIP builder downloads from these; the manifest just serializes them.
    """
    records: list[dict] = []
    for assignment in ctx["assignments"]:
        file_rows = ctx["files_by_assignment"].get(assignment.get("id"), [])
        versions = versions_for(file_rows, assignment.get("file_id"))
        current = next((v for v in versions if v["is_current"]), None)
        if not current:
            continue
        source = next((f for f in file_rows if f.get("id") == current["file_id"]), {}) or {}
        task = ctx["tasks_by_id"].get(assignment.get("task_id"), {})
        contact = ctx["contacts_by_id"].get(assignment.get("contact_id"), {})
        contact_id = contact.get("id") or assignment.get("contact_id")
        records.append(
            {
                "speaker": _contact_name(contact),
                "contact_id": contact_id,
                "item_id": assignment.get("id"),
                "item": task.get("name"),
                "type": classify_item_type(task.get("name")),
                "filename": current.get("filename"),
                "version": current["version"],
                "url": current.get("url"),
                "size": source.get("size"),
                "bucket_path": source.get("bucket_path"),
                "entry": _entry_name(
                    _contact_name(contact),
                    contact_id,
                    task.get("name"),
                    assignment.get("id"),
                    current["version"],
                    current.get("filename"),
                ),
            }
        )
    return records


def _selected(ctx: dict, assignment_ids: list[str] | None) -> dict:
    """Narrow a collected context to a hand-picked set of items.

    ``ctx["assignments"]`` is already org- AND event-scoped by ``_collect``, so
    intersecting with a client-supplied id list can only ever remove rows: an id
    from another org (or another event) simply matches nothing. An empty/omitted
    list means "everything", which is what the whole-event export wants.
    """
    if not assignment_ids:
        return ctx
    wanted = {aid for aid in assignment_ids if aid}
    return {**ctx, "assignments": [a for a in ctx["assignments"] if a.get("id") in wanted]}


async def export_manifest(
    org_id: str, event_id: str, assignment_ids: list[str] | None = None
) -> dict:
    """A metadata-only listing of the collected files — filenames, sizes, URLs and
    the archive path each would take. Does NO downloads (cheap; safe at any scale).

    ``assignment_ids`` narrows it to a chosen subset (see ``_selected``)."""
    await fetch_event(event_id, org_id, columns="id, org_id, name")
    ctx = _selected(await _collect(org_id, event_id), assignment_ids)
    files = [{k: v for k, v in r.items() if k != "bucket_path"} for r in _export_records(ctx)]
    return {"event_id": event_id, "files": files, "count": len(files)}


async def build_export_zip(
    org_id: str, event_id: str, assignment_ids: list[str] | None = None
) -> bytes:
    """Bundle the current version of the collected files into an in-memory ZIP.

    Every item on the event by default; only the given items when
    ``assignment_ids`` is passed (the "download selected" path) — always the
    CURRENT version of each, never the whole history.

    Entries are ``{Speaker}-{id}/{Item}-{id}-v{n}-{filename}`` — unique and
    traversal-safe (see ``_entry_name``). A file whose bytes can't be fetched is
    skipped rather than aborting the whole export.
    """
    await fetch_event(event_id, org_id, columns="id, org_id, name")
    ctx = _selected(await _collect(org_id, event_id), assignment_ids)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for record in _export_records(ctx):
            data = await _download(record.get("bucket_path"))
            if data is not None:
                archive.writestr(record["entry"], data)
    return buffer.getvalue()


async def _download(bucket_path: str | None) -> bytes | None:
    if not bucket_path:
        return None

    def _get() -> bytes:
        return supabase.storage.from_(PORTAL_BUCKET).download(bucket_path)

    try:
        return await run_in_threadpool(_get)
    except Exception:  # a missing/failed object is skipped, not fatal
        logger.warning("content export: could not download %s", bucket_path, exc_info=True)
        return None
