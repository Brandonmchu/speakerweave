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
from postgrest.exceptions import APIError

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
# fallback: the same classification decides what choices the PUBLIC form renders,
# what choices the BUILDER offers, which live row a submitted answer means, and
# which name a conditional rule compares against — so none of the four can
# disagree with the others.

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


def live_choice_map(
    fields: list[dict],
    classified: dict[str, str],
    track_names: list[str],
    format_names: list[str],
) -> dict[str, list[str]]:
    """``{field_id: the choices that question should offer RIGHT NOW}``.

    The one place the live names are attached to questions. Everything that has
    to speak the same value space — the public select, the builder's select, the
    operands of a conditional rule — reads this map, so a rename can never move
    one of them without the others.

    A taxonomy with no rows yields no entry: an event that has not set its
    formats up yet must still render the question the organizer built rather
    than an empty select, and the stored snapshot is what does that.
    """
    live = {"track": track_names, "format": format_names}
    mapped: dict[str, list[str]] = {}
    for field in fields:
        names = live.get(classified.get(str(field.get("id"))) or "") or []
        if names:
            mapped[str(field.get("id"))] = list(names)
    return mapped


def apply_live_choices(
    entries: list[dict], choices_by_field: dict[str, list[str]], id_key: str = "id"
) -> list[dict]:
    """`entries` with every taxonomy question's `options.choices` made current.

    Two shapes carry a form's questions — the public field (`id`, from
    `to_public_field`) and the builder's layout row (`field_id`, from
    `load_form_layout`) — and both must offer the same choices. When they don't,
    an organizer authors conditional logic against names the speaker is never
    shown, and the rule can never fire.
    """
    if not choices_by_field:
        return list(entries)
    out: list[dict] = []
    for entry in entries:
        names = choices_by_field.get(str(entry.get(id_key)))
        if not names:
            out.append(entry)
            continue
        out.append({**entry, "options": {**(entry.get("options") or {}), "choices": list(names)}})
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


# ── conditional logic authored against a taxonomy choice ───────────────────
#
# A rule operand is a STRING the organizer picked out of the builder's dropdown
# ("show Workshop prerequisites when Session format equals Workshop"), frozen
# into `question_rules.logic`. Rename the format in Settings and the public form
# starts offering "Workshop (120 min)" — so `equals "Workshop"` can never match
# what the speaker actually picks, and the conditional field silently stops
# appearing. That is the whole of the bug.
#
# Re-pointing the operand at the live name is what keeps a rule authored under
# the old names working. It is applied to the rules the renderer evaluates AND
# to the rules `validate_submission` re-runs, from the same map — so the browser
# and the server can never reach different verdicts about what was asked.

# Ops whose operand is one of the question's own choices. `gt`/`lt` against a
# dropdown is a builder mistake, not a choice, and rewriting it would be
# meddling with a comparison we do not understand.
CHOICE_OPERAND_OPS: frozenset[str] = frozenset(("eq", "neq", "contains"))


def resolve_live_choice(value: object, live_names: list[str]) -> str | None:
    """The live choice a stored operand means, or None when it can't be told.

    Two readings, in order:

    1. The name still exists — matched case- and whitespace-insensitively, so a
       rule authored as "workshop" tracks a choice displayed as "Workshop".
    2. The choice was RELABELLED. A rename in practice extends or trims the same
       option ("Workshop" -> "Workshop (120 min)"), so a live name that extends
       the stored one — or that the stored one extends — is that option, as long
       as exactly ONE does.

    Anything ambiguous, or gone entirely, returns None and leaves the operand
    untouched: a rule that cannot fire is a visible bug the organizer can fix,
    where a rule silently re-pointed at the wrong branch is not.
    """
    if not isinstance(value, str) or not value.strip() or not live_names:
        return None
    folded = _fold(value)
    for name in live_names:
        if _fold(name) == folded:
            return name
    key = _letters(value)
    if not key:
        return None
    relabelled = [
        name
        for name in live_names
        if _letters(name) and (_letters(name).startswith(key) or key.startswith(_letters(name)))
    ]
    return relabelled[0] if len(relabelled) == 1 else None


def _with_live_condition_values(logic: dict, choices_by_field: dict[str, list[str]]) -> dict:
    """One rule's `when` clauses, operands re-pointed at the live names."""
    conditions = logic.get("when")
    if not isinstance(conditions, list):
        return logic
    rewritten: list[object] = []
    changed = False
    for condition in conditions:
        if not isinstance(condition, dict) or condition.get("op") not in CHOICE_OPERAND_OPS:
            rewritten.append(condition)
            continue
        names = choices_by_field.get(str(condition.get("field")))
        live = resolve_live_choice(condition.get("value"), names or [])
        if live is None or live == condition.get("value"):
            rewritten.append(condition)
            continue
        rewritten.append({**condition, "value": live})
        changed = True
    return {**logic, "when": rewritten} if changed else logic


def with_live_rule_values(
    rules: list[dict], choices_by_field: dict[str, list[str]]
) -> list[dict]:
    """`rules` with every taxonomy operand rewritten to the name now on screen.

    Non-taxonomy questions are absent from `choices_by_field` and so pass
    through untouched — an "Audience level" rule keeps comparing against
    "Beginner" whatever the event's tracks are called.
    """
    if not choices_by_field:
        return list(rules or [])
    out: list[dict] = []
    for rule in rules or []:
        if not isinstance(rule, dict):
            out.append(rule)
            continue
        logic = rule.get("logic")
        if not isinstance(logic, dict):
            # Hand-written / seeded rules inline their logic next to the target;
            # `evaluate_rules` accepts both shapes, so this must too.
            out.append(_with_live_condition_values(rule, choices_by_field))
            continue
        updated = _with_live_condition_values(logic, choices_by_field)
        out.append(rule if updated is logic else {**rule, "logic": updated})
    return out


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


def _ordered_taxonomy(records: list[dict]) -> list[dict]:
    """`order` then name — the order Settings lists them in (taxonomy_routes)."""
    return sorted(
        records,
        key=lambda row: (
            row["order"] if isinstance(row.get("order"), int) else 0,
            str(row.get("name") or "").casefold(),
        ),
    )


async def load_live_taxonomy(org_id: str, event_id: str | None) -> tuple[list[dict], list[dict]]:
    """This event's CURRENT tracks and formats, org- and event-scoped.

    The truth behind every Track / Session format question, read at request time
    by both surfaces: the public form so a rename in Settings shows up on the
    next load and a submitted answer maps to the row it was offered under, and
    the builder so an organizer authors logic against the names a speaker will
    actually be shown.
    """
    if not event_id:
        return [], []

    async def _load(table: str, columns: str) -> list[dict]:
        try:
            return _ordered_taxonomy(
                rows(
                    await db(
                        lambda: supabase.table(table)
                        .select(columns)
                        .eq("org_id", org_id)
                        .eq("event_id", event_id)
                        .execute(),
                        f"live_{table}",
                    )
                )
            )
        except APIError:
            # A read that fails costs the live names, not the page: the stored
            # snapshot still renders and a submission still lands.
            logger.warning("forms: could not read live %s event_id=%s", table, event_id)
            return []

    return await _load("tracks", "id, name, order"), await _load("formats", "id, name")


def taxonomy_names(records: list[dict]) -> list[str]:
    """The display names of taxonomy rows, blanks dropped."""
    return [str(row.get("name")).strip() for row in records if str(row.get("name") or "").strip()]


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
