"""fetch -> verify -> 404, in one call.

The service-role client bypasses RLS, so every route that takes an id from the
URL owes the same three steps before touching anything: read the row WITH the
org predicate, verify the org matches, 404 otherwise. Writing that out five
times per module is how one of them eventually gets written out four times.
"""

from __future__ import annotations

from auth import verify_org_access
from services.supabase_helpers import db, first
from supabase_client import supabase


async def fetch_scoped(
    table: str,
    row_id: str,
    org_id: str,
    resource: str,
    *,
    columns: str = "*",
) -> dict:
    """One row of `table` owned by `org_id`. Raises 404 for missing OR foreign."""
    row = first(
        await db(
            lambda: supabase.table(table)
            .select(columns)
            .eq("id", row_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            f"{table}_scoped_lookup",
        )
    )
    return verify_org_access(row, org_id, resource)


async def fetch_event(event_id: str, org_id: str, *, columns: str = "id, org_id") -> dict:
    """The event named in a path, or 404. Every /events/{id}/… route starts here."""
    return await fetch_scoped("events", event_id, org_id, "Event", columns=columns)
