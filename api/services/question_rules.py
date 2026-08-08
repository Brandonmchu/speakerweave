"""Conditional form logic — the single source of truth for both surfaces.

The public renderer (TypeScript) and the submission endpoint (this module) must
agree on every answer, or a speaker sees a field the server then rejects — or
worse, the server accepts an answer to a question the speaker never saw. The
semantics below are therefore pinned by a canonical fixture file,
`tests/fixtures/question_rules.json`, which the web mirror is tested against
byte-for-byte. Change the semantics here => change the fixtures => both
implementations move together, or one of the two suites goes red.

Rule shape (matches the `question_rules` row: id, target_field_id, logic):

    {"target_field_id": "<field_id>",
     "logic": {"when":  [{"field": "<field_id>", "op": "eq", "value": <any>}],
               "match": "all" | "any",
               "action": "show" | "hide" | "require"}}

Resolution, per target field:
  * default is visible, with no opinion on required (``required_override``: None)
  * a field targeted by any `show` rule is hidden UNLESS at least one of its
    show rules matches — "show when X" means "hidden by default"
  * a matching `hide` rule always wins over a matching `show` rule
  * `require` is independent of visibility: a match sets required_override=True,
    no match leaves it None (the form's own `required` flag still applies).
    Rules only ever ADD a requirement; they never cancel one.

Everything here is pure: no I/O, no DB, no request context.
"""

from __future__ import annotations

import math
from typing import Any

OPS: tuple[str, ...] = (
    "eq",
    "neq",
    "contains",
    "gt",
    "gte",
    "lt",
    "lte",
    "empty",
    "not_empty",
)
# Operators that compare against an operand. `empty`/`not_empty` are unary — a
# valued op with no operand is a half-built rule and must never match (the TS
# mirror gates the same set).
VALUED_OPS: frozenset[str] = frozenset(
    ("eq", "neq", "contains", "gt", "gte", "lt", "lte")
)
ACTIONS: tuple[str, ...] = ("show", "hide", "require")
MATCHES: tuple[str, ...] = ("all", "any")

# Fields nobody can answer, so nobody can fail to answer them.
NON_INPUT_FIELD_TYPES: tuple[str, ...] = ("header", "divider")

_TRUTHY = {"true", "yes", "1", "on", "checked"}
_FALSY = {"false", "no", "0", "off", "unchecked", ""}


class RuleValidationError(ValueError):
    """A rule the builder tried to save is not a rule. Routes answer 400."""


def default_state() -> dict[str, Any]:
    """State of a field no rule targets."""
    return {"visible": True, "required_override": None}


# ── coercion ───────────────────────────────────────────────────────────────


def is_blank(value: Any) -> bool:
    """Blank per the public form's `isBlank`: missing, false, or empty.

    An unchecked checkbox (False) is blank — that is what makes "you must
    accept the code of conduct" expressible as a required checkbox. `0` is a
    real answer and is NOT blank.
    """
    if value is None:
        return True
    if isinstance(value, bool):
        return value is False
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, tuple, set, dict)):
        return len(value) == 0
    return False


def _to_bool(value: Any) -> bool | None:
    """Loose truthiness. None => the value is not a boolean in any reading."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _TRUTHY:
            return True
        if text in _FALSY:
            return False
        return None
    if isinstance(value, (int, float)):
        return bool(value)
    return None


def _to_float(value: Any) -> float | None:
    """Numeric reading of a value, or None. Booleans are deliberately excluded:
    `gt` against a checkbox is a builder mistake, not a comparison.

    Non-finite results (inf/-inf/nan, e.g. the string "Infinity") are rejected:
    a comparison against infinity is never a real form answer, and the TS mirror
    already drops them via Number.isFinite — so both must agree they don't match.
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        num = float(value)
    elif isinstance(value, str):
        try:
            num = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    return num if math.isfinite(num) else None


def loose_eq(left: Any, right: Any) -> bool:
    """Equality across the type sloppiness of an HTML form.

    A checkbox arrives as `true` from the renderer and as `"true"` from a
    hand-rolled POST; a number field arrives as `"3"` and is compared against
    `3`. Both must mean the same thing.
    """
    if left is None and right is None:
        return True
    if isinstance(left, bool) or isinstance(right, bool):
        as_left, as_right = _to_bool(left), _to_bool(right)
        return as_left is not None and as_right is not None and as_left == as_right
    if left is None or right is None:
        return False
    if isinstance(left, (list, tuple)) or isinstance(right, (list, tuple)):
        return list(left) == list(right) if _both_sequences(left, right) else False
    num_left, num_right = _to_float(left), _to_float(right)
    if num_left is not None and num_right is not None:
        return num_left == num_right
    return str(left).strip() == str(right).strip()


def _both_sequences(left: Any, right: Any) -> bool:
    return isinstance(left, (list, tuple)) and isinstance(right, (list, tuple))


def _contains(haystack: Any, needle: Any) -> bool:
    """`contains` over both multi-selects (membership) and text (substring)."""
    if haystack is None:
        return False
    if isinstance(haystack, (list, tuple, set)):
        return any(loose_eq(item, needle) for item in haystack)
    if isinstance(haystack, dict):
        return any(loose_eq(key, needle) for key in haystack)
    return str(needle).strip().lower() in str(haystack).lower()


# ── evaluation ─────────────────────────────────────────────────────────────


def evaluate_condition(condition: dict, answers: dict[str, Any]) -> bool:
    """One {field, op, value} clause against the current answers."""
    if not isinstance(condition, dict):
        return False
    op = condition.get("op")
    answer = answers.get(condition.get("field"))
    expected = condition.get("value")

    # A valued operator whose operand is missing (None) can't be a real
    # comparison — Python once coerced None -> "none" and `contains` matched
    # "None of the above". Fail closed, in lockstep with the TS mirror.
    if op in VALUED_OPS and expected is None:
        return False

    if op == "eq":
        return loose_eq(answer, expected)
    if op == "neq":
        return not loose_eq(answer, expected)
    if op == "contains":
        return _contains(answer, expected)
    if op in ("gt", "gte", "lt", "lte"):
        left, right = _to_float(answer), _to_float(expected)
        if left is None or right is None:
            return False
        if op == "gt":
            return left > right
        if op == "gte":
            return left >= right
        if op == "lt":
            return left < right
        return left <= right
    if op == "empty":
        return is_blank(answer)
    if op == "not_empty":
        return not is_blank(answer)
    # Unknown op: the write path (validate_logic) rejects these, so anything
    # that reaches here is legacy data. Never matching is the safe reading.
    return False


def _logic_of(rule: dict) -> dict:
    """Accept the DB row shape ({target_field_id, logic}) or inline logic."""
    logic = rule.get("logic")
    return logic if isinstance(logic, dict) else rule


def _target_of(rule: dict) -> str | None:
    target = rule.get("target_field_id") or rule.get("target")
    return str(target) if target else None


def rule_matches(logic: dict, answers: dict[str, Any]) -> bool:
    """Does this rule fire for these answers?

    A rule with no conditions never fires — in every mode. `all([])` is true in
    both Python and JS, which would make an empty `show` rule silently pin a
    field visible and an empty `hide` rule erase it; neither is what an empty
    builder row means.
    """
    conditions = logic.get("when")
    if not isinstance(conditions, list) or not conditions:
        return False
    results = [evaluate_condition(condition, answers) for condition in conditions]
    if logic.get("match") == "any":
        return any(results)
    return all(results)


def evaluate_rules(rules: list[dict], answers: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Resolve every rule-targeted field to {"visible", "required_override"}.

    Only fields that some rule targets appear in the result; anything absent is
    `default_state()` — visible, with no override.
    """
    answers = answers or {}
    by_target: dict[str, list[dict]] = {}
    for rule in rules or []:
        if not isinstance(rule, dict):
            continue
        target = _target_of(rule)
        if not target:
            continue
        by_target.setdefault(target, []).append(_logic_of(rule))

    states: dict[str, dict[str, Any]] = {}
    for target, logics in by_target.items():
        shows = [logic for logic in logics if logic.get("action") == "show"]
        hides = [logic for logic in logics if logic.get("action") == "hide"]
        requires = [logic for logic in logics if logic.get("action") == "require"]

        visible = True
        if shows:
            visible = any(rule_matches(logic, answers) for logic in shows)
        if any(rule_matches(logic, answers) for logic in hides):
            visible = False

        required_override: bool | None = None
        if any(rule_matches(logic, answers) for logic in requires):
            required_override = True

        states[target] = {"visible": visible, "required_override": required_override}
    return states


def field_state(states: dict[str, dict[str, Any]], field_id: str) -> dict[str, Any]:
    """State for one field, defaulting for fields no rule mentions."""
    return states.get(field_id) or default_state()


# ── submission validation (server-side twin of the renderer's validate()) ──


def _missing_message(labels: list[str]) -> str:
    quoted = [f'"{label}"' for label in labels]
    if len(quoted) == 1:
        return f"{quoted[0]} is required"
    return f"{', '.join(quoted[:-1])} and {quoted[-1]} are required"


def validate_submission(
    fields: list[dict], rules: list[dict], answers: dict[str, Any]
) -> tuple[dict[str, Any], str | None]:
    """Apply rules to a submitted answer set.

    `fields` are the public form's fields in page/order order, each with at
    least {id, label, required, type}.

    Returns (answers_to_store, error_message). Hidden fields never produce an
    error and never get stored: a conditional branch the speaker did not take
    must not leave residue in `form_answers`, or the organizer reads an answer
    to a question that was never asked.
    """
    answers = dict(answers or {})
    states = evaluate_rules(rules, answers)

    missing: list[str] = []
    for field in fields or []:
        field_id = field.get("id")
        if not field_id:
            continue
        state = field_state(states, field_id)
        if not state["visible"]:
            answers.pop(field_id, None)
            continue
        if field.get("type") in NON_INPUT_FIELD_TYPES:
            continue
        required = bool(field.get("required")) or state["required_override"] is True
        if required and is_blank(answers.get(field_id)):
            missing.append(str(field.get("label") or field_id))

    return answers, _missing_message(missing) if missing else None


# ── write-path validation ──────────────────────────────────────────────────


def validate_logic(logic: Any) -> dict:
    """Normalize + validate one rule's logic. Raises RuleValidationError.

    The builder is the only writer, but a bad `op` saved once is a rule that
    silently never fires — cheaper to reject at the door than to debug later.
    """
    if not isinstance(logic, dict):
        raise RuleValidationError("Rule logic must be an object")

    action = logic.get("action")
    if action not in ACTIONS:
        raise RuleValidationError(
            f"Unknown rule action '{action}' — expected one of {', '.join(ACTIONS)}"
        )

    match = logic.get("match", "all")
    if match not in MATCHES:
        raise RuleValidationError(
            f"Unknown rule match '{match}' — expected one of {', '.join(MATCHES)}"
        )

    conditions = logic.get("when")
    if not isinstance(conditions, list):
        raise RuleValidationError("Rule logic needs a 'when' list of conditions")

    normalized: list[dict] = []
    for condition in conditions:
        if not isinstance(condition, dict):
            raise RuleValidationError("Each rule condition must be an object")
        field_id = condition.get("field")
        if not field_id or not isinstance(field_id, str):
            raise RuleValidationError("Each rule condition needs a 'field'")
        op = condition.get("op")
        if op not in OPS:
            raise RuleValidationError(
                f"Unknown rule operator '{op}' — expected one of {', '.join(OPS)}"
            )
        entry: dict[str, Any] = {"field": field_id, "op": op}
        # empty/not_empty take no operand; keeping one around invites a future
        # reader to think it is compared.
        if op not in ("empty", "not_empty"):
            entry["value"] = condition.get("value")
        normalized.append(entry)

    return {"when": normalized, "match": match, "action": action}
