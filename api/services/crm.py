"""The org-level speaker CRM: one person record above every event.

dais is otherwise event-shaped. A `contacts` row is `(event_id, email)`, so the
same speaker at three of your conferences is three unrelated rows — three sets
of notes, three chances to re-key the same bio. That is the right model for
running one event and the wrong one for running a speaker *program*.

This module owns the layer above it. `directory_people` is the canonical human;
the per-event `contacts` rows are that human's appearances, resolved by email.
Everything the CRM adds — tags, organizer-defined fields, internal notes, a
sourcing stage and its history, saved segments — hangs off the person, not off
any one event, which is what makes "who have we worked with" answerable at all.

Two rules run through the whole file:

* **Org predicate on every query.** The service-role client bypasses RLS, so a
  dropped ``.eq("org_id", …)`` is a cross-tenant leak, not a bug in a list.
* **The sync hook can never fail a submission.** ``sync_contact`` is called from
  the CFP and import paths; a speaker's talk must land even if the directory
  write does not. Every failure in it is swallowed and logged.

Matching and grouping happen in Python rather than in SQL. A speaker directory
is thousands of rows at the very top end and the joins it needs (group by
lower(email) across events, near-duplicate detection, tag containment) are far
clearer as list comprehensions than as PostgREST filter chains.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from services import speaker_crm
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

# The sourcing lifecycle, left to right on the board. Open stages first, the two
# terminal ones last — the order the kanban renders and the order a prospect
# actually travels.
STAGES: tuple[str, ...] = (
    "researching",
    "identified",
    "contacted",
    "interested",
    "confirmed",
    "declined",
)
TERMINAL_STAGES = frozenset({"confirmed", "declined"})
DEFAULT_STAGE = "identified"

STAGE_LABELS: dict[str, str] = {
    "researching": "Researching",
    "identified": "Identified",
    "contacted": "Contacted",
    "interested": "Interested",
    "confirmed": "Confirmed",
    "declined": "Declined",
}

# Profile columns copied both ways between a person and their event contacts.
# `email` is deliberately absent: it is the join key, not a field to sync.
PROFILE_COLUMNS = (
    "first_name",
    "last_name",
    "company_name",
    "title",
    "about",
    "photo_url",
    "linkedin_url",
    "twitter_url",
    "phone",
)

# Editable through PATCH /people/{id}. `tags` and `custom` are handled apart
# because they are collections, not scalars.
EDITABLE_COLUMNS = PROFILE_COLUMNS + ("email",)

_WHITESPACE = re.compile(r"\s+")

# Merge tags the CRM composer offers. A superset of the per-event campaign tags
# in services/comms.py: outreach from the directory is written ABOUT a person
# rather than about their session, so `company` and `title` are the two an
# organizer actually reaches for and `session_title` has nothing to resolve to.
MERGE_TAGS: tuple[str, ...] = (
    "first_name",
    "last_name",
    "full_name",
    "email",
    "company",
    "title",
    "event_name",
)
_MERGE_TAG_RE = re.compile(r"{{\s*(" + "|".join(MERGE_TAGS) + r")\s*}}")


def render_merge_tags(text: str, context: dict[str, Any]) -> str:
    """Substitute the supported tags, leaving anything unknown visibly untouched.

    Leaving an unknown tag alone rather than blanking it is deliberate: a typo
    like ``{{firstname}}`` should look wrong in the preview, not vanish and ship
    a sentence with a hole in it.
    """

    def replace(match: re.Match[str]) -> str:
        value = context.get(match.group(1), "")
        return "" if value is None else str(value)

    return _MERGE_TAG_RE.sub(replace, text or "")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_email(value: Any) -> str:
    return speaker_crm.normalize_email(str(value or ""))


def person_name(person: dict) -> str:
    """"First Last", falling back to the email — a row must always have a label."""
    name = " ".join(
        part.strip()
        for part in (person.get("first_name") or "", person.get("last_name") or "")
        if str(part).strip()
    ).strip()
    return name or str(person.get("email") or "") or "Unnamed contact"


def name_key(person: dict) -> str:
    """Case- and spacing-insensitive name, for near-duplicate grouping."""
    return _WHITESPACE.sub(" ", person_name(person).strip().casefold())


def email_local(email: Any) -> str:
    """The part before the ``@``. Two addresses sharing it are worth a look."""
    return normalize_email(email).split("@", 1)[0]


def person_emails(person: dict) -> list[str]:
    """Every address that resolves to this person: canonical plus absorbed."""
    found = [normalize_email(person.get("email"))]
    for alt in person.get("alt_emails") or []:
        alt_email = normalize_email(alt)
        if alt_email and alt_email not in found:
            found.append(alt_email)
    return [email for email in found if email]


def clean_stage(value: Any, *, fallback: str = DEFAULT_STAGE) -> str:
    stage = str(value or "").strip().lower()
    return stage if stage in STAGES else fallback


def clean_tags(values: Any) -> list[str]:
    """De-duplicated, order-preserving, trimmed. Case-insensitive uniqueness so
    "AI" and "ai" never both appear on the same person."""
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        tag = str(value or "").strip()
        if not tag or tag.casefold() in seen:
            continue
        seen.add(tag.casefold())
        cleaned.append(tag)
    return cleaned


# ── reads ──────────────────────────────────────────────────────────────────


async def list_people(org_id: str, *, include_merged: bool = False) -> list[dict]:
    """Every person in the org's directory, merged-away records excluded.

    A merged loser keeps its row (see migration 011) so the merge stays
    auditable — but it is not a contact any more, and every reader here means
    "the people I have", so the filter lives in one place rather than in each
    caller.
    """
    found = rows(
        await db(
            lambda: supabase.table("directory_people")
            .select("*")
            .eq("org_id", org_id)
            .execute(),
            "crm_list_people",
        )
    )
    if include_merged:
        return found
    return [person for person in found if not person.get("merged_into")]


async def fetch_person(person_id: str, org_id: str) -> dict:
    """One person owned by this org, or 404. Foreign is indistinguishable from
    missing — never 403, which would confirm the row exists."""
    person = first(
        await db(
            lambda: supabase.table("directory_people")
            .select("*")
            .eq("id", person_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "crm_fetch_person",
        )
    )
    if not person or person.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail="Contact not found")
    return person


async def org_events(org_id: str) -> list[dict]:
    return rows(
        await db(
            lambda: supabase.table("events")
            .select("id, org_id, name, slug, starts_at, ends_at")
            .eq("org_id", org_id)
            .execute(),
            "crm_org_events",
        )
    )


async def org_contacts(org_id: str) -> list[dict]:
    return rows(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("org_id", org_id)
            .execute(),
            "crm_org_contacts",
        )
    )


def contacts_by_email(contacts: list[dict]) -> dict[str, list[dict]]:
    """Per-event contact rows grouped by normalized email — the cross-event join.

    This single grouping is what "the same human at three events" means in this
    codebase; every appearance list, event badge and merge repoint reads it.
    """
    grouped: dict[str, list[dict]] = {}
    for contact in contacts:
        email = normalize_email(contact.get("email"))
        if email:
            grouped.setdefault(email, []).append(contact)
    return grouped


def appearances_for(person: dict, grouped: dict[str, list[dict]]) -> list[dict]:
    """Every per-event contact row belonging to this person, aliases included."""
    found: list[dict] = []
    seen: set[str] = set()
    for email in person_emails(person):
        for contact in grouped.get(email, []):
            contact_id = str(contact.get("id") or "")
            if contact_id and contact_id not in seen:
                seen.add(contact_id)
                found.append(contact)
    return found


# ── the sync hook (best-effort, never fatal) ───────────────────────────────


def _person_payload_from_contact(org_id: str, contact: dict) -> dict:
    payload: dict[str, Any] = {
        "org_id": org_id,
        "email": normalize_email(contact.get("email")),
    }
    for column in PROFILE_COLUMNS:
        value = contact.get(column)
        if isinstance(value, str):
            value = value.strip()
        if value:
            payload[column] = value
    payload.setdefault("first_name", "")
    payload.setdefault("last_name", "")
    return payload


async def upsert_person(org_id: str, payload: dict) -> dict | None:
    """Create the person, or fill in blanks on the one already there.

    Filling blanks rather than overwriting is the whole contract: a CFP
    submission that carries only a name must never wipe the company an organizer
    typed by hand, but it should absolutely fill it in when nothing is there.
    """
    email = payload.get("email")
    if not email:
        return None
    existing = first(
        await db(
            lambda: supabase.table("directory_people")
            .select("*")
            .eq("org_id", org_id)
            .eq("email", email)
            .limit(1)
            .execute(),
            "crm_sync_lookup",
        )
    )
    if existing:
        if existing.get("merged_into"):
            return existing  # absorbed by a merge; the winner owns this identity
        patch = {
            column: value
            for column, value in payload.items()
            if column not in ("org_id", "email")
            and value
            and not str(existing.get(column) or "").strip()
        }
        if not patch:
            return existing
        patch["updated_at"] = now_iso()
        updated = first(
            await db(
                lambda: supabase.table("directory_people")
                .update(patch)
                .eq("id", existing["id"])
                .eq("org_id", org_id)
                .execute(),
                "crm_sync_fill",
            )
        )
        return updated or {**existing, **patch}

    return first(
        await db(
            lambda: supabase.table("directory_people").insert(payload).execute(),
            "crm_sync_insert",
        )
    )


async def sync_contact(org_id: str, contact: dict) -> dict | None:
    """Mirror one per-event contact into the org directory. Never raises.

    Called from the CFP submission and speaker-import paths, where the caller's
    real job is accepting a talk. A directory row is a nice-to-have on that path
    and a hard failure would cost the organizer a submission, so every error is
    logged and swallowed — the next sync (or the lazy one in `sync_org`) heals
    the gap.
    """
    try:
        if not org_id or not contact:
            return None
        payload = _person_payload_from_contact(org_id, contact)
        if not payload.get("email"):
            return None
        return await upsert_person(org_id, payload)
    except Exception:
        logger.warning("crm: contact sync failed org_id=%s", org_id, exc_info=True)
        return None


async def sync_org(org_id: str) -> int:
    """Reconcile the whole directory from `contacts`. Idempotent, best-effort.

    The migration backfills once; this keeps the directory honest afterwards for
    anything that created a contact without going through the hook (a seed
    reset, a direct DB import, a route added later). Cheap enough to run on a
    directory read: one select over the org's contacts and a write only for
    emails that are genuinely missing.
    """
    try:
        contacts = await org_contacts(org_id)
        if not contacts:
            return 0
        existing = await list_people(org_id, include_merged=True)
        known: set[str] = set()
        for person in existing:
            known.update(person_emails(person))

        created = 0
        for email, group in contacts_by_email(contacts).items():
            if email in known:
                continue
            # Richest row wins the identity: the appearance that actually has a
            # bio and a company, not whichever event sorted first.
            best = max(group, key=lambda row: sum(1 for c in PROFILE_COLUMNS if row.get(c)))
            if await upsert_person(org_id, _person_payload_from_contact(org_id, best)):
                created += 1
                known.add(email)
        return created
    except Exception:
        logger.warning("crm: org sync failed org_id=%s", org_id, exc_info=True)
        return 0


# ── filtering ──────────────────────────────────────────────────────────────


def _haystack(person: dict, event_names: list[str]) -> str:
    parts = [
        person_name(person),
        str(person.get("email") or ""),
        str(person.get("company_name") or ""),
        str(person.get("title") or ""),
        str(person.get("about") or ""),
        " ".join(str(tag) for tag in person.get("tags") or []),
        " ".join(str(value) for value in (person.get("custom") or {}).values()),
        " ".join(event_names),
    ]
    return " ".join(parts).casefold()


def matches_filter(person: dict, filters: dict, *, event_names: list[str] | None = None) -> bool:
    """One person against one filter set, AND-style across criteria.

    Every criterion is optional and an empty one never narrows — that is what
    makes "clear filters" a matter of dropping keys rather than a second code
    path.
    """
    names = event_names or []

    query = str(filters.get("q") or "").strip().casefold()
    if query and query not in _haystack(person, names):
        return False

    company = str(filters.get("company") or "").strip().casefold()
    if company and str(person.get("company_name") or "").strip().casefold() != company:
        return False

    title = str(filters.get("title") or "").strip().casefold()
    if title and str(person.get("title") or "").strip().casefold() != title:
        return False

    tag = str(filters.get("tag") or "").strip().casefold()
    if tag and tag not in {str(value).strip().casefold() for value in person.get("tags") or []}:
        return False

    stage = str(filters.get("stage") or "").strip().lower()
    if stage and str(person.get("pipeline_stage") or "") != stage:
        return False

    event_id = str(filters.get("event_id") or "").strip()
    if event_id and event_id not in {str(value) for value in filters.get("_event_ids") or []}:
        return False

    # Only the pipeline board asks for this; the directory shows everyone.
    return not (filters.get("in_pipeline") and not person.get("in_pipeline"))


def clean_filters(raw: dict | None) -> dict:
    """Drop empty criteria so a saved segment stores intent, not blank keys."""
    allowed = ("q", "company", "title", "tag", "stage", "event_id")
    cleaned: dict[str, str] = {}
    for key in allowed:
        value = str((raw or {}).get(key) or "").strip()
        if value:
            cleaned[key] = value
    return cleaned


# ── near-duplicates ────────────────────────────────────────────────────────


def duplicate_groups(people: list[dict]) -> list[list[dict]]:
    """People who look like the same human, grouped.

    Two signals, both cheap and both what actually happens in a speaker list:
    the *same name* under two addresses (she submitted from work, then from
    gmail) and the *same email local part* across domains (priya@acme.com and
    priya@gmail.com). Nothing is merged automatically — this only surfaces the
    pairs a person should look at.
    """
    by_name: dict[str, list[dict]] = {}
    by_local: dict[str, list[dict]] = {}
    for person in people:
        key = name_key(person)
        if key:
            by_name.setdefault(key, []).append(person)
        local = email_local(person.get("email"))
        if local:
            by_local.setdefault(local, []).append(person)

    groups: list[list[dict]] = []
    seen: set[frozenset[str]] = set()
    for bucket in list(by_name.values()) + list(by_local.values()):
        if len(bucket) < 2:
            continue
        signature = frozenset(str(person.get("id")) for person in bucket)
        if signature in seen:
            continue
        seen.add(signature)
        groups.append(bucket)
    return groups


def duplicate_ids(people: list[dict]) -> set[str]:
    """Ids that belong to at least one duplicate group — the directory's badge."""
    flagged: set[str] = set()
    for group in duplicate_groups(people):
        for person in group:
            flagged.add(str(person.get("id")))
    return flagged


def merge_values(primary: dict, duplicate: dict, choices: dict | None = None) -> dict:
    """The surviving field set: an explicit choice, else primary, else duplicate.

    "Else duplicate" is the point of merging rather than deleting — if the
    losing record is the only one that ever had a bio, the bio survives.
    """
    picks = choices or {}
    patch: dict[str, Any] = {}
    for column in PROFILE_COLUMNS:
        chosen = picks.get(column)
        if chosen is not None and str(chosen).strip():
            patch[column] = str(chosen).strip()
            continue
        current = primary.get(column)
        if current is None or not str(current).strip():
            fallback = duplicate.get(column)
            if fallback is not None and str(fallback).strip():
                patch[column] = fallback
    return patch


# ── writes ─────────────────────────────────────────────────────────────────


async def record_stage_move(
    org_id: str,
    person_id: str,
    from_stage: str | None,
    to_stage: str,
    actor: str = "",
) -> dict | None:
    return first(
        await db(
            lambda: supabase.table("directory_stage_history")
            .insert(
                {
                    "org_id": org_id,
                    "person_id": person_id,
                    "from_stage": from_stage,
                    "to_stage": to_stage,
                    "actor": actor,
                    "created_at": now_iso(),
                }
            )
            .execute(),
            "crm_stage_history_insert",
        )
    )


async def stage_history(org_id: str, person_ids: list[str]) -> list[dict]:
    if not person_ids:
        return []
    return rows(
        await db(
            lambda: supabase.table("directory_stage_history")
            .select("*")
            .eq("org_id", org_id)
            .in_("person_id", person_ids)
            .execute(),
            "crm_stage_history",
        )
    )


async def notes_for(org_id: str, person_ids: list[str]) -> list[dict]:
    if not person_ids:
        return []
    return rows(
        await db(
            lambda: supabase.table("directory_notes")
            .select("*")
            .eq("org_id", org_id)
            .in_("person_id", person_ids)
            .execute(),
            "crm_notes",
        )
    )


async def update_person(org_id: str, person_id: str, patch: dict) -> dict:
    patch = {**patch, "updated_at": now_iso()}
    updated = first(
        await db(
            lambda: supabase.table("directory_people")
            .update(patch)
            .eq("id", person_id)
            .eq("org_id", org_id)
            .execute(),
            "crm_update_person",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Contact not found")
    return updated


async def add_person_to_event(org_id: str, person: dict, event: dict) -> tuple[dict, bool]:
    """Push a directory person into one event's contact list.

    Returns ``(contact, created)``. Idempotent: an existing contact for that
    (event, email) is filled in from the richer directory record rather than
    duplicated — pushing the same person twice is a no-op, not a second row.
    """
    event_id = str(event.get("id"))
    email = normalize_email(person.get("email"))
    existing = first(
        await db(
            lambda: supabase.table("contacts")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("email", email)
            .limit(1)
            .execute(),
            "crm_event_contact_lookup",
        )
    )
    if existing:
        patch = {
            column: person.get(column)
            for column in PROFILE_COLUMNS
            if person.get(column) and not str(existing.get(column) or "").strip()
        }
        if not patch:
            return existing, False
        patch["updated_at"] = now_iso()
        updated = first(
            await db(
                lambda: supabase.table("contacts")
                .update(patch)
                .eq("id", existing["id"])
                .eq("org_id", org_id)
                .execute(),
                "crm_event_contact_fill",
            )
        )
        return (updated or {**existing, **patch}), False

    payload: dict[str, Any] = {
        "org_id": org_id,
        "event_id": event_id,
        "email": email,
    }
    for column in PROFILE_COLUMNS:
        value = person.get(column)
        if value:
            payload[column] = value
    payload.setdefault("first_name", "")
    payload.setdefault("last_name", "")
    created = first(
        await db(
            lambda: supabase.table("contacts").insert(payload).execute(),
            "crm_event_contact_insert",
        )
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not add the contact to that event")
    return created, True


async def merge_people(
    org_id: str,
    primary_id: str,
    duplicate_id: str,
    choices: dict | None = None,
    actor: str = "",
) -> dict:
    """Fold `duplicate` into `primary` and return the surviving record.

    Non-destructive on purpose. The loser's row is kept and stamped with
    `merged_into`, its addresses move to the winner's `alt_emails` (so its
    per-event contact rows — keyed on the old address — keep resolving to the
    surviving person), and its notes and stage history are repointed rather than
    dropped. Nothing about a merge deletes evidence; it only stops the loser
    being a separate contact.
    """
    if primary_id == duplicate_id:
        raise HTTPException(status_code=400, detail="Pick two different records to merge.")

    primary = await fetch_person(primary_id, org_id)
    duplicate = await fetch_person(duplicate_id, org_id)
    if duplicate.get("merged_into"):
        raise HTTPException(status_code=409, detail="That record has already been merged.")

    patch = merge_values(primary, duplicate, choices)

    absorbed = person_emails(duplicate)
    alt = [email for email in (primary.get("alt_emails") or [])]
    for email in absorbed:
        if email not in alt and email != normalize_email(primary.get("email")):
            alt.append(email)
    patch["alt_emails"] = alt

    patch["tags"] = clean_tags(list(primary.get("tags") or []) + list(duplicate.get("tags") or []))
    merged_custom = {**(duplicate.get("custom") or {}), **(primary.get("custom") or {})}
    for key, value in (choices or {}).get("custom", {}).items():
        merged_custom[key] = value
    patch["custom"] = merged_custom

    # A prospect already at a terminal stage keeps it; otherwise the further of
    # the two wins, so merging never walks someone backwards in the pipeline.
    stages = [clean_stage(primary.get("pipeline_stage")), clean_stage(duplicate.get("pipeline_stage"))]
    patch["pipeline_stage"] = max(stages, key=lambda stage: STAGES.index(stage))
    if duplicate.get("in_pipeline"):
        patch["in_pipeline"] = True

    surviving = await update_person(org_id, primary_id, patch)

    for table, label in (("directory_notes", "crm_merge_notes"), ("directory_stage_history", "crm_merge_history")):
        await db(
            lambda table=table: supabase.table(table)
            .update({"person_id": primary_id})
            .eq("org_id", org_id)
            .eq("person_id", duplicate_id)
            .execute(),
            label,
        )

    await db(
        lambda: supabase.table("directory_people")
        .update(
            {
                "merged_into": primary_id,
                "merged_at": now_iso(),
                "in_pipeline": False,
                "updated_at": now_iso(),
            }
        )
        .eq("id", duplicate_id)
        .eq("org_id", org_id)
        .execute(),
        "crm_merge_loser",
    )

    await db(
        lambda: supabase.table("directory_notes")
        .insert(
            {
                "org_id": org_id,
                "person_id": primary_id,
                "author": actor or "System",
                "body": (
                    f"Merged duplicate record {person_name(duplicate)} "
                    f"<{duplicate.get('email')}> into this contact."
                ),
                "created_at": now_iso(),
            }
        )
        .execute(),
        "crm_merge_audit_note",
    )
    return surviving
