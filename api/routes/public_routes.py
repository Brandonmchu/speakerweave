"""Public (unauthenticated) CFP surface: render a form, accept a submission.

No JWT here — the form slug is the only credential. Org/event context is
derived from the form row itself, never from the request, so a submission can
only ever land in the org that owns the slug.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from postgrest.exceptions import APIError
from pydantic import BaseModel, EmailStr, Field

from security.rate_limiting import RATE_PUBLIC_DEFAULT, RATE_PUBLIC_WRITE, limiter
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/public", tags=["public"])
logger = logging.getLogger(__name__)


class SubmissionRequest(BaseModel):
    email: EmailStr
    first_name: str = Field(default="", max_length=120)
    last_name: str = Field(default="", max_length=120)
    answers: dict[str, Any] = Field(default_factory=dict)
    title: str = Field(..., min_length=1, max_length=300)
    description: str = Field(default="", max_length=10000)


async def _get_form_by_slug(slug: str) -> dict:
    res = await db(
        lambda: supabase.table("forms").select("*").eq("slug", slug).limit(1).execute(),
        "public_form_by_slug",
    )
    form = first(res)
    if not form:
        raise HTTPException(status_code=404, detail="Form not found")
    return form


@router.get("/forms/{slug}")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def get_public_form(request: Request, slug: str):
    """Form + its ordered fields, everything the public renderer needs."""
    form = await _get_form_by_slug(slug)

    event_res = await db(
        lambda: supabase.table("events")
        .select("id, name, slug, starts_at, ends_at, timezone, location")
        .eq("id", form["event_id"])
        .eq("org_id", form["org_id"])
        .limit(1)
        .execute(),
        "public_form_event",
    )
    event = first(event_res)

    ff_res = await db(
        lambda: supabase.table("form_fields")
        .select("id, field_id, page, order, label_override, help_text, required")
        .eq("form_id", form["id"])
        .eq("org_id", form["org_id"])
        .execute(),
        "public_form_fields",
    )
    # Sorted here rather than in PostgREST: `order` is also the name of the
    # PostgREST sort parameter, and these lists are tiny.
    form_fields = sorted(rows(ff_res), key=lambda r: (r.get("page") or 1, r.get("order") or 0))

    fields_by_id: dict[str, dict] = {}
    if form_fields:
        field_ids = [ff["field_id"] for ff in form_fields]
        f_res = await db(
            lambda: supabase.table("fields")
            .select("id, public_name, field_type, options, required")
            .in_("id", field_ids)
            .eq("org_id", form["org_id"])
            .execute(),
            "public_form_field_defs",
        )
        fields_by_id = {row["id"]: row for row in rows(f_res)}

    fields = []
    for ff in form_fields:
        field = fields_by_id.get(ff["field_id"])
        if not field:
            continue
        fields.append(
            {
                "id": field["id"],
                "form_field_id": ff["id"],
                "label": ff.get("label_override") or field["public_name"],
                "type": field["field_type"],
                "options": field.get("options") or {},
                "required": bool(ff.get("required") or field.get("required")),
                "help_text": ff.get("help_text"),
                "page": ff.get("page") or 1,
                "order": ff.get("order") or 0,
            }
        )

    return {
        "form": {
            "id": form["id"],
            "slug": form["slug"],
            "name": form["name"],
            "kind": form.get("kind"),
            "welcome_html": form.get("welcome_html") or "",
            "settings": form.get("settings") or {},
        },
        "event": event,
        "fields": fields,
    }


async def _upsert_contact(org_id: str, event_id: str, payload: SubmissionRequest) -> dict:
    """Get-or-create the contact for (event_id, lower(email)).

    contacts.email is citext with UNIQUE (event_id, email), so the DB is the
    arbiter: on a lost insert race (23505) we re-read the winner's row.
    """
    email = str(payload.email).strip().lower()

    def _select():
        return (
            supabase.table("contacts")
            .select("*")
            .eq("event_id", event_id)
            .eq("email", email)
            .limit(1)
            .execute()
        )

    existing = first(await db(_select, "public_contact_lookup"))
    if existing:
        # Fill blanks only — never clobber an organizer-curated name.
        patch = {}
        if payload.first_name and not existing.get("first_name"):
            patch["first_name"] = payload.first_name
        if payload.last_name and not existing.get("last_name"):
            patch["last_name"] = payload.last_name
        if patch:
            updated = first(
                await db(
                    lambda: supabase.table("contacts")
                    .update(patch)
                    .eq("id", existing["id"])
                    .eq("org_id", org_id)
                    .execute(),
                    "public_contact_fill",
                )
            )
            return updated or existing
        return existing

    insert_payload = {
        "org_id": org_id,
        "event_id": event_id,
        "email": email,
        "first_name": payload.first_name,
        "last_name": payload.last_name,
    }
    try:
        created = first(
            await db(
                lambda: supabase.table("contacts").insert(insert_payload).execute(),
                "public_contact_create",
            )
        )
        if created:
            return created
    except APIError as exc:
        if getattr(exc, "code", None) != "23505":
            raise
        logger.info("public: lost contact insert race event_id=%s", event_id)

    raced = first(await db(_select, "public_contact_relookup"))
    if not raced:
        raise HTTPException(status_code=500, detail="Could not create contact")
    return raced


@router.post("/forms/{slug}/submissions", status_code=201)
@limiter.limit(RATE_PUBLIC_WRITE)
async def create_submission(request: Request, slug: str, payload: SubmissionRequest):
    """Public CFP submission -> contact + pending session + submitter participant."""
    form = await _get_form_by_slug(slug)
    org_id, event_id = form["org_id"], form["event_id"]

    contact = await _upsert_contact(org_id, event_id, payload)

    # friendly_id_raw comes from a DB counter (migration 001): atomic upsert,
    # no read-modify-write race. sessions.friendly_id is GENERATED from it.
    counter = await db(
        lambda: supabase.rpc("next_friendly_id", {"p_event_id": event_id}).execute(),
        "next_friendly_id",
    )
    friendly_id_raw = getattr(counter, "data", None)
    if isinstance(friendly_id_raw, list) and friendly_id_raw:
        friendly_id_raw = friendly_id_raw[0]
    if friendly_id_raw is None:
        raise HTTPException(status_code=500, detail="Could not allocate submission id")

    session_payload = {
        "org_id": org_id,
        "event_id": event_id,
        "friendly_id_raw": int(friendly_id_raw),
        "title": payload.title.strip(),
        "description": payload.description,
        "status": "pending",
        "is_abstract": True,
        "source_form_id": form["id"],
        "form_answers": payload.answers,
        "submitter_contact_id": contact["id"],
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    session = first(
        await db(
            lambda: supabase.table("sessions")
            .insert(session_payload)
            .execute(),
            "public_session_create",
        )
    )
    if not session:
        raise HTTPException(status_code=500, detail="Could not create submission")

    await db(
        lambda: supabase.table("session_participants")
        .insert(
            {
                "org_id": org_id,
                "session_id": session["id"],
                "contact_id": contact["id"],
                "role": "submitter",
                "is_primary": True,
            }
        )
        .execute(),
        "public_session_participant_create",
    )

    return {"id": session["id"], "friendly_id": session.get("friendly_id")}
