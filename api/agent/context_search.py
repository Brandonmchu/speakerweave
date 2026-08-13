"""Organization-scoped @-mention search for the frozen entity vocabulary.

Two modes share this module. Unscoped search fans out across every type and
needs a real query to stay cheap, so it keeps a two-character floor. Scoped
search — the picker after the organizer drills into "Speakers" — is a browse:
an empty query lists that type, and typing narrows it. A drilled-in category
that answers "type at least 2 characters" is a dead end, not a filter.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from services.speaker_crm import full_name
from services.supabase_helpers import db, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

SEARCHABLE_TYPES = (
    "event",
    "submission",
    "speaker",
    "session",
    "form",
    "content",
    "contact",
)
PER_TYPE_LIMIT = 10
TOTAL_LIMIT = 20
# One type on its own can fill the list — nothing else is competing for rows.
SCOPED_LIMIT = 20
MIN_QUERY_CHARS = 2


def _pattern(query: str) -> str:
    # PostgREST's `*` is an ilike `%` alias and avoids raw percent signs in URLs.
    return f"*{query.replace('*', '').replace(',', ' ').strip()}*"


def _result(
    entity_type: str,
    entity_id: Any,
    display: str,
    sublabel: str | None = None,
) -> dict[str, Any]:
    return {
        "type": entity_type,
        "id": str(entity_id),
        "display": display,
        "sublabel": sublabel,
    }


async def _events(org_id: str, query: str, limit: int) -> list[dict[str, Any]]:
    def _query():
        builder = (
            supabase.table("events")
            .select("id, name, starts_at, ends_at")
            .eq("org_id", org_id)
        )
        if query:
            builder = builder.ilike("name", _pattern(query))
        return builder.order("starts_at", desc=True).limit(limit).execute()

    found = rows(await db(_query, "agent_context_events"))
    return [
        _result("event", row.get("id"), str(row.get("name") or "Untitled event"))
        for row in found
        if row.get("id")
    ]


async def _sessions(
    org_id: str, query: str, entity_type: str, limit: int
) -> list[dict[str, Any]]:
    # `sessions` holds both: a row with no `starts_at` is a submission awaiting a
    # slot, a scheduled row is an agenda session. Ascending order puts the
    # scheduled ones first (Postgres sorts NULLS LAST ascending), so the
    # "session" filter below still has rows to keep when the query is empty.
    def _query():
        builder = (
            supabase.table("sessions")
            .select("id, friendly_id, title, status, starts_at")
            .eq("org_id", org_id)
        )
        if query:
            pattern = _pattern(query)
            builder = builder.or_(
                f"title.ilike.{pattern},friendly_id.ilike.{pattern}"
            )
        if entity_type == "session":
            builder = builder.order("starts_at", desc=False)
        else:
            builder = builder.order("created_at", desc=True)
        return builder.limit(limit * 3).execute()

    found = rows(await db(_query, f"agent_context_{entity_type}"))
    if entity_type == "session":
        found = [row for row in found if row.get("starts_at")]
    result = []
    for row in found[:limit]:
        title = str(row.get("title") or "Untitled session")
        display = title
        if entity_type == "submission" and row.get("friendly_id"):
            display = f"{row['friendly_id']} — {title}"
        result.append(
            _result(entity_type, row.get("id"), display, str(row.get("status") or "") or None)
        )
    return result


async def _speakers(org_id: str, query: str, limit: int) -> list[dict[str, Any]]:
    """Event-roster speakers — the same `contacts` rows the speaker tools take.

    The CRM directory is a different population (see `_contacts`); handing the
    agent a directory id where it expects a roster id resolves to nobody.
    """

    def _query():
        builder = (
            supabase.table("contacts")
            .select("id, first_name, last_name, email, company_name, title")
            .eq("org_id", org_id)
        )
        if query:
            pattern = _pattern(query)
            builder = builder.or_(
                f"first_name.ilike.{pattern},last_name.ilike.{pattern},"
                f"email.ilike.{pattern},company_name.ilike.{pattern}"
            )
        return builder.order("first_name", desc=False).limit(limit * 2).execute()

    found = rows(await db(_query, "agent_context_speaker"))
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in found:
        if not row.get("id"):
            continue
        # One human speaking at two events is two `contacts` rows. Showing both
        # gives the organizer two identical-looking choices.
        key = str(row.get("email") or "").casefold() or str(row["id"])
        if key in seen:
            continue
        seen.add(key)
        result.append(
            _result(
                "speaker",
                row["id"],
                full_name(row.get("first_name"), row.get("last_name"), row.get("email")),
                str(row.get("company_name") or row.get("title") or row.get("email") or "")
                or None,
            )
        )
        if len(result) >= limit:
            break
    return result


async def _contacts(org_id: str, query: str, limit: int) -> list[dict[str, Any]]:
    """Everyone in the org's CRM directory, speaker or not."""

    def _query():
        builder = (
            supabase.table("directory_people")
            .select("id, first_name, last_name, email, company_name, pipeline_stage")
            .eq("org_id", org_id)
            # Losing rows of a merge are hidden everywhere else; hide them here.
            .is_("merged_into", "null")
        )
        if query:
            pattern = _pattern(query)
            builder = builder.or_(
                f"first_name.ilike.{pattern},last_name.ilike.{pattern},"
                f"email.ilike.{pattern},company_name.ilike.{pattern}"
            )
        return builder.order("first_name", desc=False).limit(limit).execute()

    found = rows(await db(_query, "agent_context_contact"))
    return [
        _result(
            "contact",
            row.get("id"),
            full_name(row.get("first_name"), row.get("last_name"), row.get("email")),
            str(row.get("company_name") or row.get("email") or "") or None,
        )
        for row in found
        if row.get("id")
    ]


async def _forms(org_id: str, query: str, limit: int) -> list[dict[str, Any]]:
    def _query():
        builder = (
            supabase.table("forms").select("id, name, kind").eq("org_id", org_id)
        )
        if query:
            builder = builder.ilike("name", _pattern(query))
        return builder.order("created_at", desc=True).limit(limit).execute()

    found = rows(await db(_query, "agent_context_forms"))
    return [
        _result("form", row.get("id"), str(row.get("name") or "Untitled form"), row.get("kind"))
        for row in found
        if row.get("id")
    ]


async def _content(org_id: str, query: str, limit: int) -> list[dict[str, Any]]:
    def _tasks_query():
        builder = (
            supabase.table("tasks")
            .select("id, name, kind, event_id")
            .eq("org_id", org_id)
        )
        if query:
            builder = builder.ilike("name", _pattern(query))
        return builder.order("name", desc=False).limit(limit).execute()

    tasks = rows(await db(_tasks_query, "agent_context_content_tasks"))
    task_by_id = {str(row["id"]): row for row in tasks if row.get("id")}
    if not task_by_id:
        return []
    assignments = rows(
        await db(
            lambda: supabase.table("task_assignments")
            .select("id, task_id, contact_id, status")
            .eq("org_id", org_id)
            .in_("task_id", list(task_by_id))
            .limit(limit)
            .execute(),
            "agent_context_content_assignments",
        )
    )
    # One deliverable assigned to twelve speakers is twelve rows with the same
    # name; without the person on them the organizer is picking blind.
    people = await _assignment_people(org_id, assignments)
    result = []
    for assignment in assignments:
        task = task_by_id.get(str(assignment.get("task_id")))
        if not assignment.get("id") or not task:
            continue
        person = people.get(str(assignment.get("contact_id")))
        status = str(assignment.get("status") or "")
        result.append(
            _result(
                "content",
                assignment["id"],
                str(task.get("name") or "Content item"),
                " · ".join(part for part in (person, status) if part) or None,
            )
        )
    return result


async def _assignment_people(
    org_id: str, assignments: list[dict[str, Any]]
) -> dict[str, str]:
    contact_ids = {
        str(assignment["contact_id"])
        for assignment in assignments
        if assignment.get("contact_id")
    }
    if not contact_ids:
        return {}
    found = rows(
        await db(
            lambda: supabase.table("contacts")
            .select("id, first_name, last_name, email")
            .eq("org_id", org_id)
            .in_("id", list(contact_ids))
            .limit(len(contact_ids))
            .execute(),
            "agent_context_content_people",
        )
    )
    return {
        str(row["id"]): full_name(
            row.get("first_name"), row.get("last_name"), row.get("email")
        )
        for row in found
        if row.get("id")
    }


async def _search_type(
    org_id: str, query: str, entity_type: str, limit: int
) -> list[dict[str, Any]]:
    if entity_type == "event":
        return await _events(org_id, query, limit)
    if entity_type in {"submission", "session"}:
        return await _sessions(org_id, query, entity_type, limit)
    if entity_type == "speaker":
        return await _speakers(org_id, query, limit)
    if entity_type == "contact":
        return await _contacts(org_id, query, limit)
    if entity_type == "form":
        return await _forms(org_id, query, limit)
    if entity_type == "content":
        return await _content(org_id, query, limit)
    return []


async def search_context(
    org_id: str,
    query: str,
    entity_type: str | None = None,
) -> list[dict[str, Any]]:
    cleaned = query.strip()
    if entity_type is not None and entity_type not in SEARCHABLE_TYPES:
        return []
    if entity_type:
        # Browse mode: no query lists the type, a short one still filters it.
        # One table, one indexed org scope — the fan-out's floor buys nothing.
        return await _search_type(org_id, cleaned, entity_type, SCOPED_LIMIT)
    if len(cleaned) < MIN_QUERY_CHARS:
        return []
    batches = await asyncio.gather(
        *(
            _search_type(org_id, cleaned, kind, PER_TYPE_LIMIT)
            for kind in SEARCHABLE_TYPES
        ),
        return_exceptions=True,
    )
    combined: list[dict[str, Any]] = []
    for kind, batch in zip(SEARCHABLE_TYPES, batches, strict=True):
        if isinstance(batch, BaseException):
            logger.warning("Context search failed for %s: %s", kind, batch)
            continue
        combined.extend(batch[:PER_TYPE_LIMIT])
        if len(combined) >= TOTAL_LIMIT:
            break
    return combined[:TOTAL_LIMIT]
