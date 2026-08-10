"""HTTP surface for the org-level speaker CRM.

Everything here is scoped by the JWT's `org_id` and nothing is scoped by an
event — that inversion is the whole feature. `/api/crm/directory` answers "who
have we worked with, across everything we have ever run", and each person hangs
their appearances, notes, tags, sourcing stage and history off that one record.

The aggregate reads (directory, person detail, overview) each assemble their
payload from a fixed handful of queries and join in Python. A speaker directory
is small — thousands of rows at the very top end — and the joins it needs
(group by lower(email) across events, near-duplicate detection, tag
containment) read far better as list comprehensions than as PostgREST filter
chains. The cost is flat in the number of events, not one query per person.

See `services/crm.py` for the model and the rules; this file is the wire.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_current_user_and_org
from services import crm, mailer, speaker_crm
from services.org_scope import fetch_event
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/crm", tags=["crm"])

# What a bulk-outreach row is filed under in email_outbox, so the CRM's own
# send history is separable from per-event campaign mail.
OUTREACH_TEMPLATE_KEY = "crm_outreach"

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _field_key(label: str) -> str:
    """A stable machine name for an organizer-typed field label."""
    return _SLUG_RE.sub("_", str(label or "").strip().casefold()).strip("_") or "field"


# ── request models ─────────────────────────────────────────────────────────


class PersonCreateRequest(BaseModel):
    email: str = Field(max_length=320)
    first_name: str = Field(default="", max_length=200)
    last_name: str = Field(default="", max_length=200)
    company_name: str | None = Field(default=None, max_length=300)
    title: str | None = Field(default=None, max_length=300)
    about: str | None = Field(default=None, max_length=8000)
    tags: list[str] | None = None
    pipeline_stage: str | None = None


class PersonPatchRequest(BaseModel):
    email: str | None = Field(default=None, max_length=320)
    first_name: str | None = Field(default=None, max_length=200)
    last_name: str | None = Field(default=None, max_length=200)
    company_name: str | None = Field(default=None, max_length=300)
    title: str | None = Field(default=None, max_length=300)
    about: str | None = Field(default=None, max_length=8000)
    linkedin_url: str | None = Field(default=None, max_length=500)
    twitter_url: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=100)
    tags: list[str] | None = None
    custom: dict[str, Any] | None = None


class NoteRequest(BaseModel):
    body: str = Field(min_length=1, max_length=8000)
    author: str = Field(default="Organizer", max_length=200)


class StageRequest(BaseModel):
    stage: str
    score: int | None = Field(default=None, ge=0, le=100)
    rationale: str | None = Field(default=None, max_length=2000)
    enroll: bool = True


class MergeRequest(BaseModel):
    primary_id: str
    duplicate_id: str
    fields: dict[str, Any] | None = None


class SegmentRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(default="dynamic")
    filter: dict[str, Any] | None = None
    member_ids: list[str] | None = None


class CustomFieldRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    field_type: str = Field(default="text")
    options: list[str] | None = None


class AddToEventRequest(BaseModel):
    event_id: str


class ImportRequest(BaseModel):
    csv: str | None = None
    rows: list[dict[str, Any]] | None = None
    event_id: str | None = None
    dry_run: bool = False


class OutreachRequest(BaseModel):
    person_ids: list[str] = Field(min_length=1)
    subject: str = Field(min_length=1, max_length=500)
    body_html: str = Field(min_length=1, max_length=100_000)
    event_id: str | None = None


# ── shared assembly ────────────────────────────────────────────────────────


async def _tag_library(org_id: str, people: list[dict]) -> list[str]:
    """The org's tag vocabulary: the existing event tag library plus whatever is
    already in use on a person. One list so the picker offers real options
    instead of asking every organizer to retype the same word."""
    library = rows(
        await db(
            lambda: supabase.table("tags").select("id, org_id, name").eq("org_id", org_id).execute(),
            "crm_tag_library",
        )
    )
    names = [str(row.get("name") or "").strip() for row in library]
    for person in people:
        names.extend(str(tag or "").strip() for tag in person.get("tags") or [])
    return crm.clean_tags(sorted({name for name in names if name}, key=str.casefold))


async def _custom_field_defs(org_id: str) -> list[dict]:
    found = rows(
        await db(
            lambda: supabase.table("directory_custom_fields")
            .select("*")
            .eq("org_id", org_id)
            .execute(),
            "crm_custom_fields",
        )
    )
    return sorted(found, key=lambda row: (row.get("order") or 0, str(row.get("label") or "")))


async def _segments(org_id: str) -> list[dict]:
    return rows(
        await db(
            lambda: supabase.table("directory_segments")
            .select("*")
            .eq("org_id", org_id)
            .execute(),
            "crm_segments",
        )
    )


def _person_row(
    person: dict,
    contacts: list[dict],
    events_by_id: dict[str, dict],
    duplicates: set[str],
) -> dict:
    """One directory row: the person plus where they show up."""
    event_ids: list[str] = []
    event_rows: list[dict] = []
    for contact in contacts:
        event_id = str(contact.get("event_id") or "")
        if event_id and event_id not in event_ids:
            event_ids.append(event_id)
            event = events_by_id.get(event_id)
            event_rows.append(
                {"id": event_id, "name": str((event or {}).get("name") or "Event")}
            )
    return {
        "id": str(person.get("id")),
        "name": crm.person_name(person),
        "first_name": person.get("first_name") or "",
        "last_name": person.get("last_name") or "",
        "email": str(person.get("email") or ""),
        "alt_emails": list(person.get("alt_emails") or []),
        "company_name": person.get("company_name"),
        "title": person.get("title"),
        "about": person.get("about"),
        "photo_url": person.get("photo_url"),
        "tags": crm.clean_tags(person.get("tags")),
        "custom": person.get("custom") or {},
        "pipeline_stage": crm.clean_stage(person.get("pipeline_stage")),
        "in_pipeline": bool(person.get("in_pipeline")),
        "score": person.get("score"),
        "rationale": person.get("rationale"),
        "events": event_rows,
        "event_ids": event_ids,
        "event_count": len(event_ids),
        "contact_ids": [str(contact.get("id")) for contact in contacts],
        "is_duplicate": str(person.get("id")) in duplicates,
        "created_at": person.get("created_at"),
        "updated_at": person.get("updated_at"),
    }


async def _directory_rows(org_id: str) -> tuple[list[dict], dict[str, dict], list[dict]]:
    """Every directory row for the org, plus the events index and raw people."""
    people = await crm.list_people(org_id)
    contacts = await crm.org_contacts(org_id)
    events = await crm.org_events(org_id)
    events_by_id = {str(event.get("id")): event for event in events}
    grouped = crm.contacts_by_email(contacts)
    duplicates = crm.duplicate_ids(people)
    rows_out = [
        _person_row(person, crm.appearances_for(person, grouped), events_by_id, duplicates)
        for person in people
    ]
    rows_out.sort(key=lambda row: (str(row["name"]).casefold(), row["email"]))
    return rows_out, events_by_id, people


def _apply_filters(directory: list[dict], filters: dict) -> list[dict]:
    kept = []
    for row in directory:
        scoped = {**filters, "_event_ids": row["event_ids"]}
        if crm.matches_filter(
            row, scoped, event_names=[event["name"] for event in row["events"]]
        ):
            kept.append(row)
    return kept


def _segment_rows_with_counts(segments: list[dict], directory: list[dict]) -> list[dict]:
    """Saved segments resolved against the same directory snapshot as the list."""
    payload = []
    for segment in segments:
        row = _segment_row(segment)
        if row["kind"] == "curated":
            wanted = {str(value) for value in row["member_ids"]}
            row["member_count"] = sum(1 for person in directory if person["id"] in wanted)
        else:
            row["member_count"] = len(
                _apply_filters(directory, crm.clean_filters(row["filter"]))
            )
        payload.append(row)
    payload.sort(key=lambda row: str(row["name"]).casefold())
    return payload


def _overview_payload(directory: list[dict], events_by_id: dict[str, dict]) -> dict:
    """KPIs computed from one already-synchronized directory snapshot."""

    def _tally(key: str) -> list[dict]:
        counts: dict[str, int] = {}
        for row in directory:
            value = str(row.get(key) or "").strip()
            if value:
                counts[value] = counts.get(value, 0) + 1
        ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0].casefold()))
        return [{"name": name, "count": count} for name, count in ranked[:8]]

    tag_counts: dict[str, int] = {}
    for row in directory:
        for tag in row["tags"]:
            tag_counts[tag] = tag_counts.get(tag, 0) + 1

    return {
        "totals": {
            "contacts": len(directory),
            "events": len(events_by_id),
            "returning_speakers": sum(1 for row in directory if row["event_count"] > 1),
            "in_pipeline": sum(1 for row in directory if row["in_pipeline"]),
            "confirmed": sum(1 for row in directory if row["pipeline_stage"] == "confirmed"),
            "tagged": sum(1 for row in directory if row["tags"]),
        },
        "top_companies": _tally("company_name"),
        "top_titles": _tally("title"),
        "top_tags": [
            {"name": name, "count": count}
            for name, count in sorted(
                tag_counts.items(), key=lambda item: (-item[1], item[0].casefold())
            )[:8]
        ],
        "by_stage": [
            {
                "stage": stage,
                "label": crm.STAGE_LABELS[stage],
                "count": sum(
                    1
                    for row in directory
                    if row["in_pipeline"] and row["pipeline_stage"] == stage
                ),
            }
            for stage in crm.STAGES
        ],
        "by_event": sorted(
            (
                {
                    "id": str(event.get("id")),
                    "name": str(event.get("name") or "Event"),
                    "count": sum(
                        1 for row in directory if str(event.get("id")) in row["event_ids"]
                    ),
                }
                for event in events_by_id.values()
            ),
            key=lambda item: (-item["count"], item["name"].casefold()),
        ),
    }


# ── directory ──────────────────────────────────────────────────────────────


@router.get("/directory")
async def list_directory(
    q: str = "",
    company: str = "",
    title: str = "",
    tag: str = "",
    stage: str = "",
    event_id: str = "",
    segment_id: str = "",
    auth: tuple = Depends(get_current_user_and_org),
):
    """The cross-event speaker directory — the org's whole roster, one row each.

    `segment_id` reopens a saved segment: a dynamic one re-runs its stored
    filter (so it picks up anyone who has since matched), a curated one returns
    exactly the ids frozen at save time.
    """
    _user_id, org_id = auth
    # Heal anything created outside the sync hook (a seed reset, a direct
    # import). Idempotent and best-effort — it can never fail the read.
    await crm.sync_org(org_id)

    directory, events_by_id, people = await _directory_rows(org_id)
    segments = await _segments(org_id)

    filters = crm.clean_filters(
        {
            "q": q,
            "company": company,
            "title": title,
            "tag": tag,
            "stage": stage,
            "event_id": event_id,
        }
    )

    segment = None
    if segment_id:
        segment = next((row for row in segments if str(row.get("id")) == segment_id), None)
        if not segment:
            raise HTTPException(status_code=404, detail="Segment not found")
        if segment.get("kind") == "curated":
            wanted = {str(value) for value in segment.get("member_ids") or []}
            matched = [row for row in directory if row["id"] in wanted]
        else:
            filters = crm.clean_filters(segment.get("filter") or {})
            matched = _apply_filters(directory, filters)
    else:
        matched = _apply_filters(directory, filters)

    companies = sorted(
        {str(row["company_name"]).strip() for row in directory if row.get("company_name")},
        key=str.casefold,
    )
    titles = sorted(
        {str(row["title"]).strip() for row in directory if row.get("title")}, key=str.casefold
    )

    return {
        "people": matched,
        "total": len(matched),
        "total_all": len(directory),
        "filters": filters,
        "segment_id": segment_id or None,
        "segments": _segment_rows_with_counts(segments, directory),
        "duplicate_count": len({row["id"] for row in directory if row["is_duplicate"]}),
        "facets": {
            "companies": companies,
            "titles": titles,
            "tags": await _tag_library(org_id, people),
            "stages": [{"value": s, "label": crm.STAGE_LABELS[s]} for s in crm.STAGES],
            "events": [
                {"id": str(event.get("id")), "name": str(event.get("name") or "Event")}
                for event in events_by_id.values()
            ],
        },
        "custom_fields": await _custom_field_defs(org_id),
        # The page's list and KPI card must describe one point in time. Returning
        # both here prevents two concurrent lazy-sync reads from painting a
        # three-row table beside a twenty-contact total.
        "overview": _overview_payload(directory, events_by_id),
    }


@router.post("/directory", status_code=201)
async def create_person(
    payload: PersonCreateRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Add a contact to the directory by hand.

    Deliberately does NOT refuse a same-name/different-email record: that is a
    real person often enough that blocking it would be wrong, and the duplicate
    detector exists precisely to surface the pair afterwards.
    """
    _user_id, org_id = auth
    email = crm.normalize_email(payload.email)
    if not speaker_crm.looks_like_email(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address")

    existing = first(
        await db(
            lambda: supabase.table("directory_people")
            .select("*")
            .eq("org_id", org_id)
            .eq("email", email)
            .limit(1)
            .execute(),
            "crm_create_lookup",
        )
    )
    if existing and not existing.get("merged_into"):
        raise HTTPException(status_code=409, detail="A contact with that email already exists.")

    record: dict[str, Any] = {
        "org_id": org_id,
        "email": email,
        "first_name": payload.first_name.strip(),
        "last_name": payload.last_name.strip(),
        "company_name": (payload.company_name or "").strip() or None,
        "title": (payload.title or "").strip() or None,
        "about": (payload.about or "").strip() or None,
        "tags": crm.clean_tags(payload.tags),
        "custom": {},
        "pipeline_stage": crm.clean_stage(payload.pipeline_stage),
        "in_pipeline": False,
        "created_at": crm.now_iso(),
        "updated_at": crm.now_iso(),
    }
    created = first(
        await db(
            lambda: supabase.table("directory_people").insert(record).execute(),
            "crm_create_person",
        )
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not create the contact")
    return {"person": _person_row(created, [], {}, set())}


@router.get("/overview")
async def crm_overview(auth: tuple = Depends(get_current_user_and_org)):
    """Org-wide numbers for the CRM landing view.

    "Returning speakers" is the metric a per-event dashboard structurally cannot
    produce — people who show up at more than one of your events — and is the
    clearest single argument for the directory existing at all.
    """
    _user_id, org_id = auth
    await crm.sync_org(org_id)
    directory, events_by_id, _people = await _directory_rows(org_id)
    return _overview_payload(directory, events_by_id)


# ── one person ─────────────────────────────────────────────────────────────


async def _appearances(org_id: str, person: dict, contacts: list[dict]) -> list[dict]:
    """Per-event history for one person: submissions, sessions, onboarding.

    This is the "cross-event history" surface — the answer to "where has this
    person shown up for us before", assembled from the event-scoped tables the
    rest of dais already writes.
    """
    if not contacts:
        return []
    contact_ids = [str(contact.get("id")) for contact in contacts]
    events = {str(event.get("id")): event for event in await crm.org_events(org_id)}

    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("id, org_id, session_id, contact_id, role, is_primary")
            .eq("org_id", org_id)
            .in_("contact_id", contact_ids)
            .execute(),
            "crm_person_participants",
        )
    )
    session_ids = [str(row.get("session_id")) for row in participants if row.get("session_id")]

    sessions_by_id: dict[str, dict] = {}
    if session_ids:
        for session in rows(
            await db(
                lambda: supabase.table("sessions")
                .select("id, org_id, event_id, title, status, friendly_id, starts_at, submitter_contact_id")
                .eq("org_id", org_id)
                .in_("id", session_ids)
                .execute(),
                "crm_person_sessions",
            )
        ):
            sessions_by_id[str(session.get("id"))] = session

    submitted = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id, event_id, title, status, friendly_id, submitted_at, submitter_contact_id")
            .eq("org_id", org_id)
            .in_("submitter_contact_id", contact_ids)
            .execute(),
            "crm_person_submissions",
        )
    )

    assignments = rows(
        await db(
            lambda: supabase.table("task_assignments")
            .select("id, org_id, task_id, contact_id, status")
            .eq("org_id", org_id)
            .in_("contact_id", contact_ids)
            .execute(),
            "crm_person_tasks",
        )
    )
    done = {"approved", "done"}

    by_event: dict[str, dict] = {}
    for contact in contacts:
        event_id = str(contact.get("event_id") or "")
        event = events.get(event_id) or {}
        by_event[event_id] = {
            "event_id": event_id,
            "event_name": str(event.get("name") or "Event"),
            "event_slug": event.get("slug"),
            "starts_at": event.get("starts_at"),
            "contact_id": str(contact.get("id")),
            "submissions": [],
            "sessions": [],
            "tasks_total": 0,
            "tasks_done": 0,
        }

    def _bucket(event_id: str) -> dict | None:
        return by_event.get(str(event_id or ""))

    for session in submitted:
        bucket = _bucket(session.get("event_id"))
        if bucket is not None:
            bucket["submissions"].append(
                {
                    "id": str(session.get("id")),
                    "title": session.get("title"),
                    "status": session.get("status"),
                    "friendly_id": session.get("friendly_id"),
                    "submitted_at": session.get("submitted_at"),
                }
            )

    for participant in participants:
        session = sessions_by_id.get(str(participant.get("session_id")))
        if not session:
            continue
        bucket = _bucket(session.get("event_id"))
        if bucket is not None:
            bucket["sessions"].append(
                {
                    "id": str(session.get("id")),
                    "title": session.get("title"),
                    "status": session.get("status"),
                    "friendly_id": session.get("friendly_id"),
                    "starts_at": session.get("starts_at"),
                    "role": participant.get("role"),
                }
            )

    contact_event = {str(contact.get("id")): str(contact.get("event_id") or "") for contact in contacts}
    for assignment in assignments:
        bucket = _bucket(contact_event.get(str(assignment.get("contact_id")), ""))
        if bucket is not None:
            bucket["tasks_total"] += 1
            if assignment.get("status") in done:
                bucket["tasks_done"] += 1

    return sorted(
        by_event.values(),
        key=lambda item: (str(item.get("starts_at") or ""), item["event_name"].casefold()),
        reverse=True,
    )


@router.get("/people/{person_id}")
async def person_detail(person_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """One contact: identity, every event they appear in, notes, stage history."""
    _user_id, org_id = auth
    person = await crm.fetch_person(person_id, org_id)

    all_contacts = await crm.org_contacts(org_id)
    grouped = crm.contacts_by_email(all_contacts)
    contacts = crm.appearances_for(person, grouped)
    events_by_id = {str(event.get("id")): event for event in await crm.org_events(org_id)}

    people = await crm.list_people(org_id)
    duplicates = [
        {
            "id": str(other.get("id")),
            "name": crm.person_name(other),
            "email": str(other.get("email") or ""),
            "company_name": other.get("company_name"),
            "title": other.get("title"),
        }
        for group in crm.duplicate_groups(people)
        if any(str(row.get("id")) == person_id for row in group)
        for other in group
        if str(other.get("id")) != person_id
    ]

    notes = sorted(
        await crm.notes_for(org_id, [person_id]),
        key=lambda row: str(row.get("created_at") or ""),
        reverse=True,
    )
    history = sorted(
        await crm.stage_history(org_id, [person_id]),
        key=lambda row: str(row.get("created_at") or ""),
        reverse=True,
    )

    communications: list[dict] = []
    contact_ids = [str(contact.get("id")) for contact in contacts]
    if contact_ids:
        outbox = rows(
            await db(
                lambda: supabase.table("email_outbox")
                .select("id, org_id, event_id, contact_id, template_key, payload, status, sent_at, created_at")
                .eq("org_id", org_id)
                .in_("contact_id", contact_ids)
                .execute(),
                "crm_person_comms",
            )
        )
        for row in sorted(
            outbox, key=lambda row: str(row.get("sent_at") or row.get("created_at") or ""), reverse=True
        )[:25]:
            payload = row.get("payload") or {}
            communications.append(
                {
                    "id": str(row.get("id")),
                    "template_key": row.get("template_key"),
                    "subject": payload.get("subject"),
                    "status": row.get("status"),
                    "sent_at": row.get("sent_at"),
                    "created_at": row.get("created_at"),
                    "event_name": str(
                        (events_by_id.get(str(row.get("event_id") or "")) or {}).get("name") or ""
                    ),
                }
            )

    return {
        "person": _person_row(person, contacts, events_by_id, {person_id} if duplicates else set()),
        "appearances": await _appearances(org_id, person, contacts),
        "notes": [
            {
                "id": str(note.get("id")),
                "body": note.get("body"),
                "author": note.get("author") or "Organizer",
                "created_at": note.get("created_at"),
            }
            for note in notes
        ],
        "stage_history": [
            {
                "id": str(row.get("id")),
                "from_stage": row.get("from_stage"),
                "from_label": crm.STAGE_LABELS.get(str(row.get("from_stage") or ""), ""),
                "to_stage": row.get("to_stage"),
                "to_label": crm.STAGE_LABELS.get(str(row.get("to_stage") or ""), ""),
                "actor": row.get("actor") or "Organizer",
                "created_at": row.get("created_at"),
            }
            for row in history
        ],
        "communications": communications,
        "duplicates": duplicates,
        "custom_fields": await _custom_field_defs(org_id),
        "tag_library": await _tag_library(org_id, people),
        "events": [
            {"id": str(event.get("id")), "name": str(event.get("name") or "Event")}
            for event in events_by_id.values()
        ],
    }


@router.patch("/people/{person_id}")
async def patch_person(
    person_id: str, payload: PersonPatchRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Edit identity fields, tags, or organizer-defined custom values."""
    _user_id, org_id = auth
    person = await crm.fetch_person(person_id, org_id)
    provided = payload.model_dump(exclude_unset=True)

    patch: dict[str, Any] = {}
    for column in crm.EDITABLE_COLUMNS:
        if column not in provided:
            continue
        value = provided[column]
        if column == "email":
            email = crm.normalize_email(value)
            if not speaker_crm.looks_like_email(email):
                raise HTTPException(status_code=400, detail="Enter a valid email address")
            if email != crm.normalize_email(person.get("email")):
                clash = first(
                    await db(
                        lambda email=email: supabase.table("directory_people")
                        .select("id, org_id")
                        .eq("org_id", org_id)
                        .eq("email", email)
                        .limit(1)
                        .execute(),
                        "crm_email_clash",
                    )
                )
                if clash and str(clash.get("id")) != person_id:
                    raise HTTPException(
                        status_code=409, detail="Another contact already uses that email."
                    )
                patch["email"] = email
            continue
        patch[column] = value.strip() if isinstance(value, str) else value

    if "tags" in provided:
        patch["tags"] = crm.clean_tags(provided["tags"])
    if "custom" in provided:
        # Merge rather than replace: the drawer edits one field at a time and
        # must not blank out every other organizer-defined value.
        merged = {**(person.get("custom") or {})}
        for key, value in (provided["custom"] or {}).items():
            if value is None or str(value).strip() == "":
                merged.pop(str(key), None)
            else:
                merged[str(key)] = value
        patch["custom"] = merged

    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")

    updated = await crm.update_person(org_id, person_id, patch)
    return {"person": _person_row(updated, [], {}, set())}


@router.post("/people/{person_id}/notes", status_code=201)
async def add_note(
    person_id: str, payload: NoteRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Attach an internal note. Organizer-only; the speaker never sees these."""
    _user_id, org_id = auth
    await crm.fetch_person(person_id, org_id)
    note = first(
        await db(
            lambda: supabase.table("directory_notes")
            .insert(
                {
                    "org_id": org_id,
                    "person_id": person_id,
                    "author": payload.author.strip() or "Organizer",
                    "body": payload.body.strip(),
                    "created_at": crm.now_iso(),
                }
            )
            .execute(),
            "crm_note_insert",
        )
    )
    if not note:
        raise HTTPException(status_code=500, detail="Could not save the note")
    return {
        "note": {
            "id": str(note.get("id")),
            "body": note.get("body"),
            "author": note.get("author"),
            "created_at": note.get("created_at"),
        }
    }


@router.delete("/notes/{note_id}", status_code=204)
async def delete_note(note_id: str, auth: tuple = Depends(get_current_user_and_org)):
    _user_id, org_id = auth
    note = first(
        await db(
            lambda: supabase.table("directory_notes")
            .select("id, org_id")
            .eq("id", note_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "crm_note_lookup",
        )
    )
    if not note or note.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail="Note not found")
    await db(
        lambda: supabase.table("directory_notes")
        .delete()
        .eq("id", note_id)
        .eq("org_id", org_id)
        .execute(),
        "crm_note_delete",
    )


@router.post("/people/{person_id}/stage")
async def move_stage(
    person_id: str, payload: StageRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Enrol into the pipeline or move between stages, writing history.

    The history row is the point: a board column tells you where someone is
    now, and only the transition log tells you how they got there and when.
    """
    _user_id, org_id = auth
    person = await crm.fetch_person(person_id, org_id)

    stage = str(payload.stage or "").strip().lower()
    if stage not in crm.STAGES:
        raise HTTPException(
            status_code=400, detail=f"Unknown stage. Expected one of: {', '.join(crm.STAGES)}."
        )

    was_enrolled = bool(person.get("in_pipeline"))
    from_stage = crm.clean_stage(person.get("pipeline_stage")) if was_enrolled else None

    patch: dict[str, Any] = {"pipeline_stage": stage}
    if payload.enroll:
        patch["in_pipeline"] = True
    if payload.score is not None:
        patch["score"] = payload.score
    if payload.rationale is not None:
        patch["rationale"] = payload.rationale.strip() or None

    updated = await crm.update_person(org_id, person_id, patch)
    if from_stage != stage or not was_enrolled:
        await crm.record_stage_move(org_id, person_id, from_stage, stage, actor="Organizer")

    history = sorted(
        await crm.stage_history(org_id, [person_id]),
        key=lambda row: str(row.get("created_at") or ""),
        reverse=True,
    )
    return {
        "person": _person_row(updated, [], {}, set()),
        "stage_history": history,
    }


@router.post("/people/{person_id}/add-to-event")
async def add_to_event(
    person_id: str, payload: AddToEventRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Push a directory contact into one event's speaker list, no re-keying.

    This is the payoff of an org-level record: the profile the organizer already
    curated becomes that event's contact row verbatim.
    """
    _user_id, org_id = auth
    person = await crm.fetch_person(person_id, org_id)
    event = await fetch_event(payload.event_id, org_id, columns="id, org_id, name, slug")
    contact, created = await crm.add_person_to_event(org_id, person, event)
    return {
        "created": created,
        "event": {"id": str(event.get("id")), "name": event.get("name"), "slug": event.get("slug")},
        "contact": {
            "id": str(contact.get("id")),
            "email": str(contact.get("email") or ""),
            "first_name": contact.get("first_name") or "",
            "last_name": contact.get("last_name") or "",
            "company_name": contact.get("company_name"),
            "title": contact.get("title"),
            "about": contact.get("about"),
        },
    }


# ── duplicates & merge ─────────────────────────────────────────────────────


@router.get("/duplicates")
async def list_duplicates(auth: tuple = Depends(get_current_user_and_org)):
    """Groups of records that look like the same human — same name, or the same
    email local part under two domains. Nothing is merged automatically."""
    _user_id, org_id = auth
    directory, _events, people = await _directory_rows(org_id)
    by_id = {row["id"]: row for row in directory}

    groups = []
    for group in crm.duplicate_groups(people):
        members = [by_id[str(person.get("id"))] for person in group if str(person.get("id")) in by_id]
        if len(members) < 2:
            continue
        names = {crm.name_key(person) for person in group}
        groups.append(
            {
                "reason": "Same name, different email" if len(names) == 1 else "Similar email address",
                "members": members,
            }
        )
    return {"groups": groups, "total": len(groups)}


@router.post("/merge")
async def merge(payload: MergeRequest, auth: tuple = Depends(get_current_user_and_org)):
    """Fold one record into another. Cannot be undone from the UI.

    The loser's row survives in the database stamped with `merged_into` (so the
    merge is auditable and its foreign keys stay valid) but leaves the
    directory; its addresses, notes and stage history move to the winner.
    """
    _user_id, org_id = auth
    surviving = await crm.merge_people(
        org_id, payload.primary_id, payload.duplicate_id, payload.fields, actor="Organizer"
    )
    directory, _events, _people = await _directory_rows(org_id)
    return {
        "person": next(
            (row for row in directory if row["id"] == str(surviving.get("id"))),
            _person_row(surviving, [], {}, set()),
        ),
        "total_all": len(directory),
    }


# ── segments ───────────────────────────────────────────────────────────────


def _segment_row(segment: dict) -> dict:
    return {
        "id": str(segment.get("id")),
        "name": segment.get("name"),
        "kind": segment.get("kind") or "dynamic",
        "filter": segment.get("filter") or {},
        "member_ids": segment.get("member_ids") or [],
        "created_at": segment.get("created_at"),
    }


@router.get("/segments")
async def list_segments(auth: tuple = Depends(get_current_user_and_org)):
    """Saved segments plus a live member count for each — a segment nobody can
    size is a name, not a list."""
    _user_id, org_id = auth
    await crm.sync_org(org_id)
    directory, _events, _people = await _directory_rows(org_id)
    return {"segments": _segment_rows_with_counts(await _segments(org_id), directory)}


@router.post("/segments", status_code=201)
async def create_segment(
    payload: SegmentRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Save the current filter as a reusable segment.

    A dynamic segment stores the FILTER, so "AI Experts" keeps meaning whoever
    currently matches; a curated one freezes today's membership.
    """
    _user_id, org_id = auth
    name = payload.name.strip()
    kind = payload.kind if payload.kind in ("dynamic", "curated") else "dynamic"

    existing = first(
        await db(
            lambda: supabase.table("directory_segments")
            .select("id, org_id, name")
            .eq("org_id", org_id)
            .eq("name", name)
            .limit(1)
            .execute(),
            "crm_segment_clash",
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="A segment with that name already exists.")

    record = {
        "org_id": org_id,
        "name": name,
        "kind": kind,
        "filter": crm.clean_filters(payload.filter or {}),
        "member_ids": [str(value) for value in payload.member_ids or []] if kind == "curated" else [],
        "created_at": crm.now_iso(),
    }
    created = first(
        await db(
            lambda: supabase.table("directory_segments").insert(record).execute(),
            "crm_segment_insert",
        )
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not save the segment")
    return {"segment": _segment_row(created)}


@router.delete("/segments/{segment_id}", status_code=204)
async def delete_segment(segment_id: str, auth: tuple = Depends(get_current_user_and_org)):
    _user_id, org_id = auth
    segment = first(
        await db(
            lambda: supabase.table("directory_segments")
            .select("id, org_id")
            .eq("id", segment_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "crm_segment_lookup",
        )
    )
    if not segment or segment.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail="Segment not found")
    await db(
        lambda: supabase.table("directory_segments")
        .delete()
        .eq("id", segment_id)
        .eq("org_id", org_id)
        .execute(),
        "crm_segment_delete",
    )


# ── organizer-defined fields ───────────────────────────────────────────────


@router.get("/fields")
async def list_custom_fields(auth: tuple = Depends(get_current_user_and_org)):
    _user_id, org_id = auth
    return {"fields": await _custom_field_defs(org_id)}


@router.post("/fields", status_code=201)
async def create_custom_field(
    payload: CustomFieldRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Define a new field for every contact in the directory.

    The definition lives here; the value lives in `directory_people.custom`
    keyed on the generated `key`, so renaming the label later never orphans the
    values already stored.
    """
    _user_id, org_id = auth
    label = payload.label.strip()
    field_type = payload.field_type if payload.field_type in ("text", "dropdown", "number", "date") else "text"
    options = [str(option).strip() for option in (payload.options or []) if str(option).strip()]
    if field_type == "dropdown" and not options:
        raise HTTPException(status_code=400, detail="A dropdown field needs at least one option.")

    key = _field_key(label)
    existing = first(
        await db(
            lambda: supabase.table("directory_custom_fields")
            .select("id, org_id")
            .eq("org_id", org_id)
            .eq("key", key)
            .limit(1)
            .execute(),
            "crm_field_clash",
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="A field with that name already exists.")

    record = {
        "org_id": org_id,
        "key": key,
        "label": label,
        "field_type": field_type,
        "options": options,
        "order": len(await _custom_field_defs(org_id)),
        "created_at": crm.now_iso(),
    }
    created = first(
        await db(
            lambda: supabase.table("directory_custom_fields").insert(record).execute(),
            "crm_field_insert",
        )
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not create the field")
    return {"field": created}


@router.delete("/fields/{field_id}", status_code=204)
async def delete_custom_field(field_id: str, auth: tuple = Depends(get_current_user_and_org)):
    _user_id, org_id = auth
    field = first(
        await db(
            lambda: supabase.table("directory_custom_fields")
            .select("id, org_id")
            .eq("id", field_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "crm_field_lookup",
        )
    )
    if not field or field.get("org_id") != org_id:
        raise HTTPException(status_code=404, detail="Field not found")
    await db(
        lambda: supabase.table("directory_custom_fields")
        .delete()
        .eq("id", field_id)
        .eq("org_id", org_id)
        .execute(),
        "crm_field_delete",
    )


# ── import ─────────────────────────────────────────────────────────────────


@router.post("/import")
async def import_directory(
    payload: ImportRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Bulk-add contacts to the directory from CSV.

    `dry_run` returns the parsed rows and the per-row problems WITHOUT writing —
    the validation step an organizer gets to look at before committing a file
    they exported from somewhere else. Passing `event_id` also drops each
    imported contact into that event.
    """
    _user_id, org_id = auth

    ignored_columns: list[str] = []
    if payload.csv:
        # `parse_speaker_csv` grew a fourth return value (the columns it could
        # not map). Unpacked positionally so this route keeps working whichever
        # arity the shared parser is on.
        result = speaker_crm.parse_speaker_csv(payload.csv)
        parsed, header_error, parse_errors = result[0], result[1], result[2]
        if len(result) > 3:
            ignored_columns = list(result[3] or [])
        if header_error:
            raise HTTPException(status_code=400, detail=header_error)
    elif payload.rows:
        parse_errors = []
        parsed = [
            {
                "first_name": str(row.get("first_name") or ""),
                "last_name": str(row.get("last_name") or ""),
                "email": str(row.get("email") or ""),
                "company": str(row.get("company") or row.get("company_name") or ""),
                "title": str(row.get("title") or ""),
                "bio": str(row.get("bio") or row.get("about") or ""),
                "line": index,
            }
            for index, row in enumerate(payload.rows, start=1)
        ]
    else:
        raise HTTPException(status_code=400, detail="Provide CSV text or a list of rows to import.")

    valid, row_errors, duplicate_skips = speaker_crm.collect_import(parsed)
    errors = parse_errors + row_errors

    event = None
    if payload.event_id:
        event = await fetch_event(payload.event_id, org_id, columns="id, org_id, name, slug")

    if payload.dry_run:
        return {
            "dry_run": True,
            "columns": list(speaker_crm.CANONICAL_COLUMNS),
            "ignored_columns": ignored_columns,
            "preview": valid[:25],
            "ready": len(valid),
            "errors": errors,
            "skipped": duplicate_skips,
            "total": len(parsed) + len(parse_errors),
            "event": {"id": str(event.get("id")), "name": event.get("name")} if event else None,
        }

    existing = {
        crm.normalize_email(person.get("email")): person
        for person in await crm.list_people(org_id, include_merged=True)
    }
    created = 0
    updated = 0
    added_to_event = 0
    for row in valid:
        record = {
            "org_id": org_id,
            "email": row["email"],
            "first_name": row.get("first_name") or "",
            "last_name": row.get("last_name") or "",
            "company_name": row.get("company") or None,
            "title": row.get("title") or None,
            "about": row.get("bio") or None,
        }
        before = existing.get(row["email"])
        person = await crm.upsert_person(org_id, {k: v for k, v in record.items() if v is not None})
        if person is None:
            continue
        if before is None:
            created += 1
            existing[row["email"]] = person
        else:
            updated += 1
        if event is not None:
            _contact, made = await crm.add_person_to_event(org_id, person, event)
            if made:
                added_to_event += 1

    return {
        "dry_run": False,
        "created": created,
        "updated": updated,
        "skipped": duplicate_skips,
        "added_to_event": added_to_event,
        "errors": errors,
        "total": len(parsed) + len(parse_errors),
        "event": {"id": str(event.get("id")), "name": event.get("name")} if event else None,
    }


# ── bulk outreach ──────────────────────────────────────────────────────────


@router.post("/outreach")
async def send_outreach(
    payload: OutreachRequest, auth: tuple = Depends(get_current_user_and_org)
):
    """Send one personalized email to each selected contact and log every send.

    Merge tags ({{first_name}}, {{company}}, …) are resolved per recipient
    against the directory record, and a row lands in `email_outbox` whatever
    happens — sent, failed, or suppressed for a reserved demo address — so the
    history is a record of what actually occurred, not of what was attempted.
    """
    _user_id, org_id = auth

    people = [person for person in await crm.list_people(org_id) if str(person.get("id")) in set(payload.person_ids)]
    if not people:
        raise HTTPException(status_code=404, detail="No matching contacts to email.")

    events = await crm.org_events(org_id)
    event: dict | None = None
    if payload.event_id:
        event = await fetch_event(payload.event_id, org_id, columns="id, org_id, name, slug")
    elif events:
        # email_outbox rows are event-scoped; with no event named, file the send
        # against the org's first event rather than losing the log entry.
        event = events[0]
    if event is None:
        raise HTTPException(
            status_code=400, detail="Create an event before sending outreach — sends are logged against one."
        )

    event_id = str(event.get("id"))
    contacts_by_id = {
        crm.normalize_email(contact.get("email")): contact
        for contact in await crm.org_contacts(org_id)
        if str(contact.get("event_id") or "") == event_id
    }

    sent = failed = skipped = 0
    results: list[dict] = []
    for person in people:
        email = crm.normalize_email(person.get("email"))
        context = {
            "first_name": str(person.get("first_name") or ""),
            "last_name": str(person.get("last_name") or ""),
            "full_name": crm.person_name(person),
            "email": email,
            "company": str(person.get("company_name") or ""),
            "title": str(person.get("title") or ""),
            "event_name": str(event.get("name") or ""),
            "session_title": "",
        }
        subject = crm.render_merge_tags(payload.subject, context)
        body = crm.render_merge_tags(payload.body_html, context)
        now = crm.now_iso()
        error: str | None = None
        delivery: dict | None = None

        if mailer.demo_suppressed(email):
            status = "cancelled"
            error = "demo address — delivery suppressed"
            skipped += 1
        else:
            status = "sent"
            try:
                delivery = await mailer.send_email(to=email, subject=subject, html=body)
                sent += 1
            except Exception as exc:  # one bad address must not stop the batch
                logger.exception("crm: outreach send failed org=%s person=%s", org_id, person.get("id"))
                status = "failed"
                error = str(exc)
                failed += 1

        outbox_payload: dict[str, Any] = {
            "to": email,
            "subject": subject,
            "body_html": body,
            "context": context,
            "person_id": str(person.get("id")),
        }
        if delivery is not None:
            outbox_payload["delivery"] = delivery

        contact = contacts_by_id.get(email)
        await db(
            lambda contact=contact, outbox_payload=outbox_payload, status=status, error=error, now=now: (
                supabase.table("email_outbox")
                .insert(
                    {
                        "org_id": org_id,
                        "event_id": event_id,
                        "contact_id": str(contact.get("id")) if contact else None,
                        "template_key": OUTREACH_TEMPLATE_KEY,
                        "payload": outbox_payload,
                        "attempts": 1,
                        "last_error": error,
                        "status": status,
                        "sent_at": now if status == "sent" else None,
                        "created_at": now,
                    }
                )
                .execute()
            ),
            "crm_outreach_outbox",
        )
        results.append(
            {
                "person_id": str(person.get("id")),
                "name": crm.person_name(person),
                "email": email,
                "subject": subject,
                "status": status,
            }
        )

    return {
        "sent": sent,
        "failed": failed,
        "skipped": skipped,
        "total": len(people),
        "event": {"id": event_id, "name": event.get("name")},
        "recipients": results,
    }


@router.get("/outreach/log")
async def outreach_log(limit: int = 50, auth: tuple = Depends(get_current_user_and_org)):
    """Every CRM outreach send, newest first."""
    _user_id, org_id = auth
    entries = rows(
        await db(
            lambda: supabase.table("email_outbox")
            # `last_error` is projected on purpose: a suppressed or failed send
            # is only readable in the log if the reason comes back with it.
            .select("id, org_id, event_id, contact_id, template_key, payload, status, last_error, sent_at, created_at")
            .eq("org_id", org_id)
            .eq("template_key", OUTREACH_TEMPLATE_KEY)
            .execute(),
            "crm_outreach_log",
        )
    )
    entries.sort(key=lambda row: str(row.get("sent_at") or row.get("created_at") or ""), reverse=True)
    return {
        "entries": [
            {
                "id": str(row.get("id")),
                "to": (row.get("payload") or {}).get("to"),
                "subject": (row.get("payload") or {}).get("subject"),
                "status": row.get("status"),
                "sent_at": row.get("sent_at"),
                "created_at": row.get("created_at"),
                "error": row.get("last_error"),
            }
            for row in entries[: max(1, min(limit, 200))]
        ]
    }


# ── pipeline ───────────────────────────────────────────────────────────────


@router.get("/pipeline")
async def pipeline_board(auth: tuple = Depends(get_current_user_and_org)):
    """The sourcing kanban: one column per stage, enrolled prospects only.

    Everyone in the directory is a potential speaker; only the people someone
    has deliberately enrolled belong on a board that is meant to be worked.
    """
    _user_id, org_id = auth
    await crm.sync_org(org_id)
    directory, _events, _people = await _directory_rows(org_id)
    enrolled = [row for row in directory if row["in_pipeline"]]

    history = await crm.stage_history(org_id, [row["id"] for row in enrolled])
    latest: dict[str, str] = {}
    for row in history:
        person_id = str(row.get("person_id"))
        created = str(row.get("created_at") or "")
        if created > latest.get(person_id, ""):
            latest[person_id] = created

    columns = []
    for stage in crm.STAGES:
        cards = [row for row in enrolled if row["pipeline_stage"] == stage]
        for card in cards:
            card["last_moved_at"] = latest.get(card["id"])
        columns.append(
            {
                "stage": stage,
                "label": crm.STAGE_LABELS[stage],
                "terminal": stage in crm.TERMINAL_STAGES,
                "cards": cards,
                "count": len(cards),
            }
        )

    return {
        "columns": columns,
        "total": len(enrolled),
        "candidates": [row for row in directory if not row["in_pipeline"]],
        "stages": [{"value": s, "label": crm.STAGE_LABELS[s]} for s in crm.STAGES],
    }
