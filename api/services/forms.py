"""Form composition: which fields a form asks, in what order, under what rules.

Two consumers with one truth: the builder (organizer, authenticated) and the
renderer (public, slug-only). They differ in presentation, not in content —
`load_form_layout` is the content, `to_public_field` is the presentation. When
they disagree, an organizer builds one form and a speaker fills in another.

Every read carries the org predicate: the service-role client bypasses RLS.
"""

from __future__ import annotations

import logging

import bleach

from services.supabase_helpers import db, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

# welcome_html / confirmation_html are organizer-authored rich text rendered on
# the public form via dangerouslySetInnerHTML. A stored `<img onerror=…>` would
# be a stored XSS against every speaker who opens the CFP, so the server is the
# authoritative sanitizer (the client repeats a subset as defense in depth).
_ALLOWED_TAGS = [
    "p", "br", "strong", "em", "b", "i", "u",
    "ul", "ol", "li", "a", "h2", "h3", "blockquote",
]
_ALLOWED_ATTRIBUTES = {"a": ["href", "title"]}
_ALLOWED_PROTOCOLS = ["http", "https", "mailto"]


def sanitize_html(value: str | None) -> str:
    """Strip stored rich text down to a tight formatting allowlist.

    Everything outside the allowlist — scripts, event handlers, images, styles,
    unknown protocols — is removed rather than escaped, so the output is safe to
    inject into the DOM. Empty/None collapses to "".
    """
    if not value:
        return ""
    return bleach.clean(
        value,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRIBUTES,
        protocols=_ALLOWED_PROTOCOLS,
        strip=True,
    )


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


# ── live taxonomy behind a CFP's Track / Format questions ──────────────────
#
# A "Track" or "Session format" question is a plain dropdown whose choices were
# SNAPSHOT into `fields.options.choices` when the question was built. The event's
# real tracks and formats live in their own tables, and an organizer renames them
# there — so the snapshot is stale the moment Settings is touched, and a speaker
# is offered names that no longer exist (and whose answers then map to no track).
#
# Everything below treats the taxonomy TABLES as the truth and the snapshot as a
# fallback: the same classification decides what choices the public form renders
# and which live row a submitted answer means, so the two can never disagree.

CHOICE_FIELD_TYPES = {"dropdown", "multi_select"}
LONG_TEXT_FIELD_TYPES = {"textarea", "long_text"}

_TRACK_LABEL_HINTS = ("track",)
_FORMAT_LABEL_HINTS = ("format", "sessiontype", "talktype")
_ABSTRACT_LABEL_HINTS = ("abstract", "description", "summary", "synopsis")


def _fold(value: object) -> str:
    return str(value or "").strip().casefold()


def _letters(value: object) -> str:
    """A label reduced to its letters/digits, so "Session format" == "session_format"."""
    return "".join(char for char in str(value or "").casefold() if char.isalnum())


def field_choices(field: dict) -> list[str]:
    """The snapshot choices stored on a public field ([] when it has none)."""
    raw = (field.get("options") or {}).get("choices")
    if not isinstance(raw, list):
        return []
    return [
        str(choice).strip()
        for choice in raw
        if isinstance(choice, (str, int, float))
        and not isinstance(choice, bool)
        and str(choice).strip()
    ]


def classify_taxonomy_fields(
    fields: list[dict],
    track_names: list[str],
    format_names: list[str],
) -> dict[str, str]:
    """``{field_id: 'track' | 'format'}`` for a form's taxonomy questions.

    The LABEL decides first, because it is what survives a rename: a question
    called "Track" stays the track question however the tracks themselves are
    renamed. Only when the label says nothing do the stored choices break the
    tie — a question whose snapshot still overlaps the event's live names is
    that taxonomy's question.
    """
    tracks = {_fold(name) for name in track_names if _fold(name)}
    formats = {_fold(name) for name in format_names if _fold(name)}

    classified: dict[str, str] = {}
    for field in fields:
        if field.get("type") not in CHOICE_FIELD_TYPES:
            continue
        label = _letters(field.get("label"))
        kind: str | None = None
        if any(hint in label for hint in _TRACK_LABEL_HINTS):
            kind = "track"
        elif any(hint in label for hint in _FORMAT_LABEL_HINTS):
            kind = "format"
        else:
            choices = {_fold(choice) for choice in field_choices(field)}
            track_hits, format_hits = len(choices & tracks), len(choices & formats)
            if track_hits or format_hits:
                kind = "track" if track_hits >= format_hits else "format"
        if kind:
            classified[str(field.get("id"))] = kind
    return classified


def taxonomy_candidate_ids(
    fields: list[dict], classified: dict[str, str], kind: str
) -> list[str]:
    """Field ids whose answers may name a ``kind`` ('track' / 'format') row.

    A question classified as this taxonomy always counts. When the form has
    none, every choice question that is not the OTHER taxonomy's is a candidate
    — which is exactly how track matching behaved before any of this existed.
    """
    other = "format" if kind == "track" else "track"
    explicit = [
        str(field["id"])
        for field in fields
        if classified.get(str(field.get("id"))) == kind
    ]
    if explicit:
        return explicit
    return [
        str(field["id"])
        for field in fields
        if field.get("type") in CHOICE_FIELD_TYPES
        and classified.get(str(field.get("id"))) != other
    ]


def with_live_choices(
    fields: list[dict],
    classified: dict[str, str],
    track_names: list[str],
    format_names: list[str],
) -> list[dict]:
    """`fields` with every taxonomy question offering the event's CURRENT names.

    The snapshot is kept only as a fallback — an event with no tracks yet must
    still render the question the organizer built rather than an empty select.
    """
    live = {"track": track_names, "format": format_names}
    out: list[dict] = []
    for field in fields:
        kind = classified.get(str(field.get("id")))
        names = live.get(kind or "") or []
        if not kind or not names:
            out.append(field)
            continue
        out.append({**field, "options": {**(field.get("options") or {}), "choices": list(names)}})
    return out


def resolve_taxonomy_ids(
    fields: list[dict],
    classified: dict[str, str],
    kind: str,
    answers: dict,
    rows_: list[dict],
) -> list[str]:
    """Live taxonomy ids an answer set selected, in the order they were offered.

    Matches a submitted value against the live NAME or the live id, so a form
    still carrying a stale snapshot resolves whatever the speaker actually
    picked, and a renamed row is reached by its new name.
    """
    if not rows_:
        return []
    by_key: dict[str, str] = {}
    for row in rows_:
        row_id = row.get("id")
        if not row_id:
            continue
        by_key.setdefault(_fold(row_id), row_id)
        name = _fold(row.get("name"))
        if name:
            by_key.setdefault(name, row_id)

    candidates = set(taxonomy_candidate_ids(fields, classified, kind))
    chosen: list[str] = []
    for field in fields:  # page/order order, so "first" is first on the form
        field_id = str(field.get("id"))
        if field_id not in candidates:
            continue
        for value in choice_values(answers.get(field_id)):
            resolved = by_key.get(_fold(value))
            if resolved and resolved not in chosen:
                chosen.append(resolved)
    return chosen


def choice_values(value: object) -> list[str]:
    """A choice answer as a list. A multi_select posts its picks as one
    comma-separated string (the answer map is scalar-only by design)."""
    if value is None or isinstance(value, bool):
        return []
    text = str(value).strip()
    if not text:
        return []
    return [part.strip() for part in text.split(",") if part.strip()]


def abstract_from_answers(fields: list[dict], answers: dict) -> str:
    """The proposal's prose, pulled out of the answer map.

    The public CFP has no separate "description" input — the abstract IS a form
    question, so `sessions.description` would otherwise stay empty and every
    surface that reads it (the submitter's own edit form, the reviewer's
    scorecard, the organizer's drawer) would show a blank where the speaker
    wrote a paragraph. A question named like an abstract wins; failing that, the
    form's first long-text answer is the prose it collected.
    """
    fallback = ""
    for field in fields:
        value = answers.get(str(field.get("id")))
        if not isinstance(value, str) or not value.strip():
            continue
        field_type = field.get("type")
        label = _letters(field.get("label"))
        named_like_an_abstract = any(hint in label for hint in _ABSTRACT_LABEL_HINTS)
        if named_like_an_abstract and (
            field_type in LONG_TEXT_FIELD_TYPES or field_type == "text"
        ):
            return value.strip()
        if not fallback and field_type in LONG_TEXT_FIELD_TYPES:
            fallback = value.strip()
    return fallback


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
