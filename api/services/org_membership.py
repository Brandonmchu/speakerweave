"""Which organizations an organizer belongs to — and the switch between them.

One person can run more than one conference organization: an agency with two
clients, a company whose events team is split by brand. Their token names ONE
org at a time (`auth.get_current_user_and_org`), so switching means minting a
new token for a different org — and the ONLY thing that may authorise that is a
row in `org_memberships`, read here, from the database, at request time.

Membership is never claimed by the caller. It accrues in
``auth._ensure_org_exists``, which upserts (org_id, user_id) the first time a
user authenticates with an org, so the table fills in as people sign in rather
than by a data migration.

A request for an org the user has no row in is a 404 at the route, never a 403:
the caller learns nothing about whether that org exists.
"""

from __future__ import annotations

import logging

from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

# Every organizer who authenticates with an org is an admin of it. There is no
# UI or endpoint that assigns any other role yet; the column exists so one can
# be added without a migration.
DEFAULT_ROLE = "admin"


async def upsert_membership(org_id: str, user_id: str, role: str = DEFAULT_ROLE) -> None:
    """Record that ``user_id`` belongs to ``org_id``.

    Called from the auth dependency's cached org bootstrap, so this runs once
    per (user, org) per cache TTL — not on every request.

    ``ignore_duplicates`` makes it INSERT … ON CONFLICT DO NOTHING: the row is
    created when it is missing and left alone when it is not, so a role someone
    is given later is never quietly reset to the default by the next sign-in.
    """
    await db(
        lambda: supabase.table("org_memberships")
        .upsert(
            {"org_id": org_id, "user_id": user_id, "role": role},
            on_conflict="org_id,user_id",
            ignore_duplicates=True,
        )
        .execute(),
        "ensure_org_membership",
    )


async def is_member(org_id: str, user_id: str) -> bool:
    """Does this user hold a membership row in this org? The switch's gate."""
    if not org_id or not user_id:
        return False
    row = first(
        await db(
            lambda: supabase.table("org_memberships")
            .select("org_id, user_id, role")
            .eq("org_id", org_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute(),
            "org_membership_lookup",
        )
    )
    return bool(row)


async def _memberships(user_id: str) -> dict[str, str]:
    """``{org_id: role}`` for every org this user belongs to."""
    found = rows(
        await db(
            lambda: supabase.table("org_memberships")
            .select("org_id, user_id, role")
            .eq("user_id", user_id)
            .execute(),
            "org_memberships_for_user",
        )
    )
    return {
        str(row["org_id"]): str(row.get("role") or DEFAULT_ROLE)
        for row in found
        if row.get("org_id")
    }


async def _org_rows(org_ids: list[str]) -> dict[str, dict]:
    if not org_ids:
        return {}
    found = rows(
        await db(
            lambda: supabase.table("orgs")
            .select("org_id, name, created_at")
            .in_("org_id", org_ids)
            .execute(),
            "orgs_for_memberships",
        )
    )
    return {str(row["org_id"]): row for row in found if row.get("org_id")}


async def _event_counts(org_ids: list[str]) -> dict[str, int]:
    """How many events each of THESE orgs has.

    Scoped to the orgs the caller already proved membership in, so it is not a
    cross-tenant read: an org the user does not belong to is never in the list.
    """
    if not org_ids:
        return {}
    counts: dict[str, int] = {org_id: 0 for org_id in org_ids}
    for row in rows(
        await db(
            lambda: supabase.table("events")
            .select("id, org_id")
            .in_("org_id", org_ids)
            .execute(),
            "events_for_memberships",
        )
    ):
        org_id = str(row.get("org_id") or "")
        if org_id in counts:
            counts[org_id] += 1
    return counts


async def list_organizations(user_id: str, current_org_id: str) -> list[dict]:
    """The orgs this user can switch between, newest first.

    ``current_org_id`` (the org in the caller's verified token) is ALWAYS
    included, even when its membership row is missing — a token that predates
    the backfill, or whose best-effort upsert failed, must never see an empty
    switcher and lose access to the org it is already authenticated for.
    """
    memberships = await _memberships(user_id)
    if current_org_id and current_org_id not in memberships:
        memberships[current_org_id] = DEFAULT_ROLE

    org_ids = sorted(memberships)
    org_rows = await _org_rows(org_ids)
    counts = await _event_counts(org_ids)

    organizations = [
        {
            "org_id": org_id,
            # orgs.name defaults to '' (Clerk owns the real name and we learn
            # about the org lazily), so fall back to the id the user recognises.
            "name": str((org_rows.get(org_id) or {}).get("name") or "").strip() or org_id,
            "role": memberships[org_id],
            "events": counts.get(org_id, 0),
            "is_current": org_id == current_org_id,
        }
        for org_id in org_ids
    ]

    # Two stable passes: name is the tiebreaker, newest org wins overall. An org
    # row we have never seen created (no created_at) sorts last, not first.
    organizations.sort(key=lambda org: org["name"].casefold())
    organizations.sort(
        key=lambda org: str((org_rows.get(org["org_id"]) or {}).get("created_at") or ""),
        reverse=True,
    )
    return organizations
