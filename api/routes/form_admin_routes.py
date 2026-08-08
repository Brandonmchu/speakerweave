"""The form builder's surface: forms, their field layout, their logic.

Both PUT endpoints are full replacements rather than patch streams. The
builder edits a whole form and presses Save; replacing the set is the only
semantics where the saved form matches what was on screen, with no ordering
of partial writes to reason about.
"""

from __future__ import annotations

import logging
from collections import Counter
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_current_user_and_org
from services.forms import load_form_layout, load_question_rules
from services.org_scope import fetch_event, fetch_scoped
from services.question_rules import RuleValidationError, validate_logic
from services.slugs import slugify, unique_slug
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/api", tags=["forms"])
logger = logging.getLogger(__name__)

MAX_PAGE = 4  # form_fields.page CHECK (page between 1 and 4)


class FormCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    slug: str | None = Field(default=None, max_length=120)
    welcome_html: str | None = None
    settings: dict[str, Any] | None = None


class FormPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    welcome_html: str | None = None
    settings: dict[str, Any] | None = None


class FormFieldInput(BaseModel):
    field_id: str
    page: int = Field(default=1, ge=1, le=MAX_PAGE)
    order: int = 0
    label_override: str | None = None
    help_text: str | None = None
    required: bool = False


class FormFieldsReplaceRequest(BaseModel):
    fields: list[FormFieldInput] = Field(default_factory=list)


class QuestionRuleInput(BaseModel):
    target_field_id: str
    logic: dict[str, Any]


class QuestionRulesReplaceRequest(BaseModel):
    rules: list[QuestionRuleInput] = Field(default_factory=list)


async def _verify_fields_exist(field_ids: list[str], org_id: str) -> None:
    """Every referenced field must belong to this org.

    Without this the FK raises a 500 on a legitimate mistake — and a field id
    from another org would otherwise be a way to probe for its existence.
    """
    unique_ids = list(dict.fromkeys(field_ids))
    if not unique_ids:
        return
    known = rows(
        await db(
            lambda: supabase.table("fields")
            .select("id")
            .in_("id", unique_ids)
            .eq("org_id", org_id)
            .execute(),
            "form_field_ids_check",
        )
    )
    missing = set(unique_ids) - {row["id"] for row in known}
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown field id(s): {', '.join(sorted(missing))}",
        )


# ── forms ──────────────────────────────────────────────────────────────────


@router.get("/events/{event_id}/forms")
async def list_forms(event_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """Every form on an event, each with how many submissions it has produced."""
    _user_id, org_id = auth
    await fetch_event(event_id, org_id)

    forms = rows(
        await db(
            lambda: supabase.table("forms")
            .select("*")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "list_forms",
        )
    )
    if not forms:
        return {"forms": []}

    # One scan of the event's sessions beats one COUNT per form: an event has a
    # handful of forms and the round trips are the expensive part.
    sessions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id, source_form_id")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "list_forms_submission_counts",
        )
    )
    counts = Counter(s["source_form_id"] for s in sessions if s.get("source_form_id"))

    forms.sort(key=lambda row: (str(row.get("created_at") or ""), str(row.get("name") or "")))
    return {
        "forms": [{**form, "submission_count": counts.get(form["id"], 0)} for form in forms]
    }


@router.post("/events/{event_id}/forms", status_code=201)
async def create_form(
    event_id: str,
    payload: FormCreateRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    await fetch_event(event_id, org_id)

    slug = await unique_slug("forms", slugify(payload.slug or payload.name, fallback="form"))
    record = {
        "org_id": org_id,
        "event_id": event_id,
        "name": payload.name.strip(),
        "slug": slug,
        "welcome_html": payload.welcome_html or "",
        "settings": payload.settings or {},
    }
    created = first(
        await db(lambda: supabase.table("forms").insert(record).execute(), "create_form")
    )
    if not created:
        raise HTTPException(status_code=500, detail="Could not create form")
    return {"form": created}


@router.get("/forms/{form_id}")
async def get_form(form_id: str, auth: tuple = Depends(get_current_user_and_org)):
    """Everything the builder loads: the form, its layout, its logic."""
    _user_id, org_id = auth
    form = await fetch_scoped("forms", form_id, org_id, "Form")
    return {
        "form": form,
        "fields": await load_form_layout(form_id, org_id),
        "question_rules": await load_question_rules(form_id, org_id),
    }


@router.patch("/forms/{form_id}")
async def update_form(
    form_id: str,
    payload: FormPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    await fetch_scoped("forms", form_id, org_id, "Form", columns="id, org_id")

    provided = payload.model_dump(exclude_unset=True)
    patch = {key: provided[key] for key in ("welcome_html", "settings") if key in provided}
    if payload.name is not None:
        patch["name"] = payload.name.strip()
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    # slug is deliberately absent: a live CFP link must not change under a
    # speaker who already has it.

    updated = first(
        await db(
            lambda: supabase.table("forms")
            .update(patch)
            .eq("id", form_id)
            .eq("org_id", org_id)
            .execute(),
            "update_form",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Form not found")
    return {"form": updated}


# ── layout ─────────────────────────────────────────────────────────────────


@router.put("/forms/{form_id}/fields")
async def replace_form_fields(
    form_id: str,
    payload: FormFieldsReplaceRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Full replace of a form's field layout: rows absent from the body go."""
    _user_id, org_id = auth
    await fetch_scoped("forms", form_id, org_id, "Form", columns="id, org_id")

    incoming = payload.fields
    field_ids = [entry.field_id for entry in incoming]
    duplicates = [fid for fid, n in Counter(field_ids).items() if n > 1]
    if duplicates:
        # form_fields has UNIQUE(form_id, field_id); the upsert below would
        # otherwise quietly keep only the last of each pair.
        raise HTTPException(
            status_code=400,
            detail=f"A field can only appear once on a form: {', '.join(sorted(duplicates))}",
        )
    await _verify_fields_exist(field_ids, org_id)

    existing = rows(
        await db(
            lambda: supabase.table("form_fields")
            .select("id, field_id")
            .eq("form_id", form_id)
            .eq("org_id", org_id)
            .execute(),
            "replace_form_fields_existing",
        )
    )
    keep = set(field_ids)
    removed = [row["id"] for row in existing if row["field_id"] not in keep]
    if removed:
        await db(
            lambda: supabase.table("form_fields")
            .delete()
            .eq("form_id", form_id)
            .eq("org_id", org_id)
            .in_("id", removed)
            .execute(),
            "replace_form_fields_delete",
        )

    if incoming:
        records = [
            {
                "org_id": org_id,
                "form_id": form_id,
                "field_id": entry.field_id,
                "page": entry.page,
                "order": entry.order,
                "label_override": entry.label_override,
                "help_text": entry.help_text,
                "required": entry.required,
            }
            for entry in incoming
        ]
        await db(
            lambda: supabase.table("form_fields")
            .upsert(records, on_conflict="form_id,field_id")
            .execute(),
            "replace_form_fields_upsert",
        )

    return {"fields": await load_form_layout(form_id, org_id)}


# ── logic ──────────────────────────────────────────────────────────────────


@router.put("/forms/{form_id}/rules")
async def replace_question_rules(
    form_id: str,
    payload: QuestionRulesReplaceRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Full replace of a form's conditional logic."""
    _user_id, org_id = auth
    await fetch_scoped("forms", form_id, org_id, "Form", columns="id, org_id")

    try:
        normalized = [validate_logic(rule.logic) for rule in payload.rules]
    except RuleValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    await _verify_fields_exist([rule.target_field_id for rule in payload.rules], org_id)

    await db(
        lambda: supabase.table("question_rules")
        .delete()
        .eq("form_id", form_id)
        .eq("org_id", org_id)
        .execute(),
        "replace_question_rules_delete",
    )
    if payload.rules:
        records = [
            {
                "org_id": org_id,
                "form_id": form_id,
                "target_field_id": rule.target_field_id,
                "logic": logic,
            }
            for rule, logic in zip(payload.rules, normalized, strict=True)
        ]
        await db(
            lambda: supabase.table("question_rules").insert(records).execute(),
            "replace_question_rules_insert",
        )

    return {"question_rules": await load_question_rules(form_id, org_id)}
