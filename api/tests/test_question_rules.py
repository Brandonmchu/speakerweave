"""Conditional form logic.

The fixture file is the contract, not this file: `tests/fixtures/question_rules.json`
is consumed verbatim by the TypeScript renderer's own suite (a copy lives at
web/tests/fixtures/question_rules.json). A case added here must be added there
too, or the two implementations are free to drift and a speaker ends up seeing
a field the server rejects.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.question_rules import (
    OPS,
    RuleValidationError,
    evaluate_rules,
    is_blank,
    loose_eq,
    validate_logic,
    validate_submission,
)

FIXTURES = Path(__file__).parent / "fixtures" / "question_rules.json"
CASES = json.loads(FIXTURES.read_text(encoding="utf-8"))
# api/tests/… -> api -> dais -> dais/web/tests/fixtures
WEB_FIXTURES = (
    Path(__file__).resolve().parents[2] / "web" / "tests" / "fixtures" / "question_rules.json"
)


# ── the canonical fixtures ─────────────────────────────────────────────────


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_fixture_case(case):
    assert evaluate_rules(case["rules"], case["answers"]) == case["expected"]


def test_fixtures_cover_every_operator():
    """A new op without a fixture is an op the TS mirror is free to get wrong."""
    used = {
        condition["op"]
        for case in CASES
        for rule in case["rules"]
        for condition in rule["logic"]["when"]
    }
    assert set(OPS) - used == set()


def test_fixtures_cover_every_action_and_match_mode():
    actions = {rule["logic"]["action"] for case in CASES for rule in case["rules"]}
    matches = {rule["logic"].get("match", "all") for case in CASES for rule in case["rules"]}
    assert actions == {"show", "hide", "require"}
    assert matches == {"all", "any"}


def test_web_copy_is_identical():
    """Two files, one contract. Byte equality is the only enforceable version."""
    if not WEB_FIXTURES.exists():  # pragma: no cover - web tree absent in api-only CI
        pytest.skip("web/ tree not present")
    assert json.loads(WEB_FIXTURES.read_text(encoding="utf-8")) == CASES


# ── coercion primitives ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value,blank",
    [
        (None, True),
        (False, True),
        ("", True),
        ("   ", True),
        ([], True),
        ({}, True),
        (True, False),
        ("x", False),
        (0, False),
        (["a"], False),
    ],
)
def test_is_blank(value, blank):
    assert is_blank(value) is blank


@pytest.mark.parametrize(
    "left,right,equal",
    [
        (True, "true", True),
        (False, "false", True),
        (False, "", True),
        (True, "maybe", False),
        (30, "30", True),
        ("30.0", 30, True),
        ("Talk", " Talk ", True),
        ("Talk", "talk", False),
        (None, None, True),
        (None, "", False),
        (["a", "b"], ["a", "b"], True),
    ],
)
def test_loose_eq(left, right, equal):
    assert loose_eq(left, right) is equal


def test_unknown_target_falls_back_to_default_state():
    states = evaluate_rules([{"target_field_id": "a", "logic": {"when": [], "action": "show"}}], {})
    assert "b" not in states


def test_inline_logic_is_accepted():
    """DB rows nest logic; hand-written rules in tests may not."""
    inline = [
        {
            "target_field_id": "prior_talk",
            "when": [{"field": "spoken_before", "op": "eq", "value": True}],
            "match": "all",
            "action": "show",
        }
    ]
    assert evaluate_rules(inline, {"spoken_before": True})["prior_talk"]["visible"] is True


def test_malformed_rules_are_ignored_not_fatal():
    assert evaluate_rules([None, "nope", {}, {"logic": {}}], {"a": 1}) == {}


# ── validate_logic (the builder's write path) ──────────────────────────────


def test_validate_logic_normalizes():
    normalized = validate_logic(
        {
            "when": [{"field": "f1", "op": "eq", "value": "x", "junk": 1}],
            "match": "any",
            "action": "hide",
        }
    )
    assert normalized == {
        "when": [{"field": "f1", "op": "eq", "value": "x"}],
        "match": "any",
        "action": "hide",
    }


def test_validate_logic_defaults_match_to_all():
    assert validate_logic({"when": [], "action": "show"})["match"] == "all"


def test_validate_logic_drops_the_operand_of_empty():
    normalized = validate_logic(
        {"when": [{"field": "f1", "op": "empty", "value": "ignored"}], "action": "show"}
    )
    assert normalized["when"] == [{"field": "f1", "op": "empty"}]


@pytest.mark.parametrize(
    "logic,fragment",
    [
        ("not a dict", "must be an object"),
        ({"when": [], "action": "explode"}, "action"),
        ({"when": [], "action": "show", "match": "some"}, "match"),
        ({"action": "show"}, "'when'"),
        ({"when": [{"field": "f1", "op": "starts_with"}], "action": "show"}, "operator"),
        ({"when": [{"op": "eq", "value": 1}], "action": "show"}, "'field'"),
        ({"when": ["nope"], "action": "show"}, "must be an object"),
    ],
)
def test_validate_logic_rejects(logic, fragment):
    with pytest.raises(RuleValidationError) as exc:
        validate_logic(logic)
    assert fragment in str(exc.value)


# ── validate_submission (rule-aware server-side validation) ────────────────

SPOKEN = "55555555-5555-5555-5555-555555555507"
PRIOR = "55555555-5555-5555-5555-555555555506"
ABSTRACT = "55555555-5555-5555-5555-555555555501"

FIELDS = [
    {"id": ABSTRACT, "label": "Abstract", "type": "textarea", "required": True},
    {"id": SPOKEN, "label": "Have you spoken before?", "type": "checkbox", "required": False},
    {"id": PRIOR, "label": "Link to a prior talk", "type": "url", "required": False},
]
SHOW_PRIOR = [
    {
        "target_field_id": PRIOR,
        "logic": {
            "when": [{"field": SPOKEN, "op": "eq", "value": True}],
            "match": "all",
            "action": "show",
        },
    }
]
REQUIRE_PRIOR = [
    {
        "target_field_id": PRIOR,
        "logic": {
            "when": [{"field": SPOKEN, "op": "eq", "value": True}],
            "match": "all",
            "action": "require",
        },
    }
]


def test_missing_required_answer_names_the_label():
    _answers, error = validate_submission(FIELDS, [], {SPOKEN: True, PRIOR: "https://x.dev"})
    assert error == '"Abstract" is required'


def test_several_missing_labels_are_all_named():
    fields = FIELDS + [{"id": "x", "label": "Bio", "type": "textarea", "required": True}]
    _answers, error = validate_submission(fields, [], {})
    assert error == '"Abstract" and "Bio" are required'


def test_hidden_fields_are_never_required():
    """The whole point of a show rule: a branch not taken cannot block a submit."""
    fields = [{**f, "required": True} if f["id"] == PRIOR else f for f in FIELDS]
    answers, error = validate_submission(
        fields, SHOW_PRIOR, {ABSTRACT: "A talk", SPOKEN: False}
    )
    assert error is None
    assert PRIOR not in answers


def test_hidden_field_answers_are_dropped():
    """Residue from a branch the speaker abandoned must not reach form_answers."""
    answers, error = validate_submission(
        FIELDS, SHOW_PRIOR, {ABSTRACT: "A talk", SPOKEN: False, PRIOR: "https://stale.example"}
    )
    assert error is None
    assert answers == {ABSTRACT: "A talk", SPOKEN: False}


def test_visible_conditional_field_still_validates():
    fields = [{**f, "required": True} if f["id"] == PRIOR else f for f in FIELDS]
    _answers, error = validate_submission(fields, SHOW_PRIOR, {ABSTRACT: "A talk", SPOKEN: True})
    assert error == '"Link to a prior talk" is required'


def test_require_rule_promotes_an_optional_field():
    _answers, error = validate_submission(
        FIELDS, REQUIRE_PRIOR, {ABSTRACT: "A talk", SPOKEN: True}
    )
    assert error == '"Link to a prior talk" is required'


def test_require_rule_that_does_not_match_leaves_the_field_optional():
    _answers, error = validate_submission(
        FIELDS, REQUIRE_PRIOR, {ABSTRACT: "A talk", SPOKEN: False}
    )
    assert error is None


def test_unchecked_required_checkbox_is_blank():
    fields = [{"id": "coc", "label": "Code of conduct", "type": "checkbox", "required": True}]
    _answers, error = validate_submission(fields, [], {"coc": False})
    assert error == '"Code of conduct" is required'


def test_headers_and_dividers_are_never_required():
    fields = [{"id": "h", "label": "Section", "type": "header", "required": True}]
    _answers, error = validate_submission(fields, [], {})
    assert error is None


def test_answers_to_unknown_fields_are_preserved():
    answers, error = validate_submission(FIELDS, [], {ABSTRACT: "A talk", "extra": "kept"})
    assert error is None
    assert answers["extra"] == "kept"
