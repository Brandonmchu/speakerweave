"""Async wrappers for the synchronous supabase-py client.

supabase-py is sync. Calling it directly inside `async def` blocks the event
loop for the entire round trip; do it under load and the whole process stops
serving. Every DB call in this app goes through `db()`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, TypeVar

from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

T = TypeVar("T")


async def db(fn: Callable[[], T], label: str = "query") -> T:
    """Run a synchronous Supabase call in a threadpool.

    Usage:
        res = await db(
            lambda: supabase.table("events").select("*").eq("org_id", org_id).execute(),
            "list_events",
        )
    """
    logger.debug("[db] %s", label)
    return await run_in_threadpool(fn)


def rows(response: Any) -> list[dict]:
    """Normalize a PostgREST response to a list of dicts."""
    data = getattr(response, "data", None) or []
    if isinstance(data, dict):
        return [data]
    return list(data)


def first(response: Any) -> dict | None:
    """First row of a PostgREST response, or None."""
    found = rows(response)
    return found[0] if found else None
