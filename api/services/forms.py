"""Form composition: which fields a form asks, in what order, under what rules.

Two consumers with one truth: the builder (organizer, authenticated) and the
renderer (public, slug-only). They differ in presentation, not in content —
`load_form_layout` is the content, `to_public_field` is the presentation. When
they disagree, an organizer builds one form and a speaker fills in another.

Every read carries the org predicate: the service-role client bypasses RLS.
"""

from __future__ import annotations

import logging

from services.supabase_helpers import db, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)


async def load_form_layout(form_id: str, org_id: str) -> list[dict]:
    """A form's fields joined to their definitions, in page/order order.

    Two queries rather than a PostgREST embed: an embedded resource cannot
    carry its own org predicate, and the FK-hint syntax breaks the moment a
    constraint is renamed.
    """
    form_fields = rows(
        await db(
            lambda: supabase.table("form_fields")
            .select("id, field_id, page, order, label_override, help_text, required")
            .eq("form_id", form_id)
            .eq("org_id", org_id)
            .execute(),
            "form_layout_form_fields",
        )
    )
    # Sorted here rather than in PostgREST: `order` is also the name of the
    # PostgREST sort parameter, and these lists are tiny.
    form_fields = sorted(form_fields, key=lambda r: (r.get("page") or 1, r.get("order") or 0))
    if not form_fields:
        return []

    field_ids = [ff["field_id"] for ff in form_fields]
    definitions = rows(
        await db(
            lambda: supabase.table("fields")
            .select("id, public_name, field_type, options, required")
            .in_("id", field_ids)
            .eq("org_id", org_id)
            .execute(),
            "form_layout_fields",
        )
    )
    by_id = {row["id"]: row for row in definitions}

    layout: list[dict] = []
    for ff in form_fields:
        field = by_id.get(ff["field_id"])
        if not field:
            # A field deleted out from under the form. Skipping beats rendering
            # a question with no text.
            logger.warning("forms: form_field %s references a missing field", ff.get("id"))
            continue
        layout.append(
            {
                "form_field_id": ff["id"],
                "field_id": ff["field_id"],
                "page": ff.get("page") or 1,
                "order": ff.get("order") or 0,
                "label_override": ff.get("label_override"),
                "help_text": ff.get("help_text"),
                "required": bool(ff.get("required")),
                "public_name": field["public_name"],
                "field_type": field["field_type"],
                "options": field.get("options") or {},
                # the library's own default, so the builder can show "required
                # everywhere" separately from "required on this form"
                "field_required": bool(field.get("required")),
            }
        )
    return layout


def to_public_field(entry: dict) -> dict:
    """Layout entry -> what the public renderer needs, and nothing more."""
    return {
        "id": entry["field_id"],
        "form_field_id": entry["form_field_id"],
        "label": entry.get("label_override") or entry["public_name"],
        "type": entry["field_type"],
        "options": entry.get("options") or {},
        # required on this form OR required by the library definition
        "required": bool(entry.get("required") or entry.get("field_required")),
        "help_text": entry.get("help_text"),
        "page": entry.get("page") or 1,
        "order": entry.get("order") or 0,
    }


async def load_question_rules(form_id: str, org_id: str) -> list[dict]:
    """A form's conditional logic, in the shape both surfaces evaluate."""
    found = rows(
        await db(
            lambda: supabase.table("question_rules")
            .select("id, target_field_id, logic")
            .eq("form_id", form_id)
            .eq("org_id", org_id)
            .execute(),
            "form_question_rules",
        )
    )
    return [
        {
            "id": rule.get("id"),
            "target_field_id": rule.get("target_field_id"),
            "logic": rule.get("logic") or {},
        }
        for rule in found
    ]
