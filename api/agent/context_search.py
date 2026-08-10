"""Organization-scoped @-mention search for the frozen entity vocabulary."""

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


async def _events(org_id: str, query: str) -> list[dict[str, Any]]:
    found = rows(
        await db(
            lambda: supabase.table("events")
            .select("id, name, starts_at, ends_at")
            .eq("org_id", org_id)
            .ilike("name", _pattern(query))
            .limit(PER_TYPE_LIMIT)
            .execute(),
            "agent_context_events",
        )
    )
    return [
        _result("event", row.get("id"), str(row.get("name") or "Untitled event"))
        for row in found
        if row.get("id")
    ]


async def _sessions(
    org_id: str, query: str, entity_type: str
) -> list[dict[str, Any]]:
    pattern = _pattern(query)
    found = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id, friendly_id, title, status, starts_at")
            .eq("org_id", org_id)
            .or_(f"title.ilike.{pattern},friendly_id.ilike.{pattern}")
            .limit(PER_TYPE_LIMIT * 2)
            .execute(),
            f"agent_context_{entity_type}",
        )
    )
    if entity_type == "session":
        found = [row for row in found if row.get("starts_at")]
    result = []
    for row in found[:PER_TYPE_LIMIT]:
        title = str(row.get("title") or "Untitled session")
        display = title
        if entity_type == "submission" and row.get("friendly_id"):
            display = f"{row['friendly_id']} — {title}"
        result.append(
            _result(entity_type, row.get("id"), display, str(row.get("status") or "") or None)
        )
    return result


async def _people(
    org_id: str, query: str, entity_type: str
) -> list[dict[str, Any]]:
    pattern = _pattern(query)
    found = rows(
        await db(
            lambda: supabase.table("directory_people")
            .select("id, first_name, last_name, email, company_name, pipeline_stage")
            .eq("org_id", org_id)
            .or_(
                f"first_name.ilike.{pattern},last_name.ilike.{pattern},"
                f"email.ilike.{pattern},company_name.ilike.{pattern}"
            )
            .limit(PER_TYPE_LIMIT)
            .execute(),
            f"agent_context_{entity_type}",
        )
    )
    return [
        _result(
            entity_type,
            row.get("id"),
            full_name(row.get("first_name"), row.get("last_name"), row.get("email")),
            str(row.get("company_name") or row.get("email") or "") or None,
        )
        for row in found
        if row.get("id")
    ]


async def _forms(org_id: str, query: str) -> list[dict[str, Any]]:
    found = rows(
        await db(
            lambda: supabase.table("forms")
            .select("id, name, kind")
            .eq("org_id", org_id)
            .ilike("name", _pattern(query))
            .limit(PER_TYPE_LIMIT)
            .execute(),
            "agent_context_forms",
        )
    )
    return [
        _result("form", row.get("id"), str(row.get("name") or "Untitled form"), row.get("kind"))
        for row in found
        if row.get("id")
    ]


async def _content(org_id: str, query: str) -> list[dict[str, Any]]:
    tasks = rows(
        await db(
            lambda: supabase.table("tasks")
            .select("id, name, kind, event_id")
            .eq("org_id", org_id)
            .ilike("name", _pattern(query))
            .limit(PER_TYPE_LIMIT)
            .execute(),
            "agent_context_content_tasks",
        )
    )
    task_by_id = {str(row["id"]): row for row in tasks if row.get("id")}
    if not task_by_id:
        return []
    assignments = rows(
        await db(
            lambda: supabase.table("task_assignments")
            .select("id, task_id, status")
            .eq("org_id", org_id)
            .in_("task_id", list(task_by_id))
            .limit(PER_TYPE_LIMIT)
            .execute(),
            "agent_context_content_assignments",
        )
    )
    return [
        _result(
            "content",
            assignment.get("id"),
            str(task_by_id[str(assignment.get("task_id"))].get("name") or "Content item"),
            str(assignment.get("status") or "") or None,
        )
        for assignment in assignments
        if assignment.get("id") and str(assignment.get("task_id")) in task_by_id
    ]


async def _search_type(
    org_id: str, query: str, entity_type: str
) -> list[dict[str, Any]]:
    if entity_type == "event":
        return await _events(org_id, query)
    if entity_type in {"submission", "session"}:
        return await _sessions(org_id, query, entity_type)
    if entity_type in {"speaker", "contact"}:
        return await _people(org_id, query, entity_type)
    if entity_type == "form":
        return await _forms(org_id, query)
    if entity_type == "content":
        return await _content(org_id, query)
    return []


async def search_context(
    org_id: str,
    query: str,
    entity_type: str | None = None,
) -> list[dict[str, Any]]:
    cleaned = query.strip()
    if len(cleaned) < 2:
        return []
    if entity_type is not None and entity_type not in SEARCHABLE_TYPES:
        return []
    selected = (entity_type,) if entity_type else SEARCHABLE_TYPES
    batches = await asyncio.gather(
        *(_search_type(org_id, cleaned, kind) for kind in selected),
        return_exceptions=True,
    )
    combined: list[dict[str, Any]] = []
    for kind, batch in zip(selected, batches, strict=True):
        if isinstance(batch, BaseException):
            logger.warning("Context search failed for %s: %s", kind, batch)
            continue
        combined.extend(batch[:PER_TYPE_LIMIT])
        if len(combined) >= TOTAL_LIMIT:
            break
    return combined[:TOTAL_LIMIT]
