"""The form builder: forms, their layout, their conditional logic."""

from __future__ import annotations

import pytest

from services.slugs import slugify
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

FORM_ID = "66666666-6666-6666-6666-666666666601"
F_ABSTRACT = "55555555-5555-5555-5555-555555555501"
F_SPOKEN = "55555555-5555-5555-5555-555555555507"
F_PRIOR = "55555555-5555-5555-5555-555555555506"

SHOW_PRIOR = {
    "when": [{"field": F_SPOKEN, "op": "eq", "value": True}],
    "match": "all",
    "action": "show",
}


@pytest.fixture
def form_db(seeded_db):
    seeded_db.seed(
        "forms",
        {
            "id": FORM_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "slug": "call-for-speakers",
            "name": "Call for Speakers",
            "kind": "cfp",
            "welcome_html": "<p>Hi</p>",
            "settings": {},
            "created_at": "2026-08-01T00:00:00+00:00",
        },
    )
    seeded_db.seed(
        "fields",
        {
            "id": F_ABSTRACT,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "scope": "session",
            "internal_name": "abstract",
            "public_name": "Abstract",
            "field_type": "textarea",
            "options": {"max_length": 2000},
            "required": True,
        },
        {
            "id": F_SPOKEN,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "scope": "session",
            "internal_name": "spoken_before",
            "public_name": "Have you spoken before?",
            "field_type": "checkbox",
            "options": {},
            "required": False,
        },
        {
            "id": F_PRIOR,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "scope": "session",
            "internal_name": "prior_talk",
            "public_name": "Link to a prior talk",
            "field_type": "url",
            "options": {},
            "required": False,
        },
    )
    seeded_db.seed(
        "form_fields",
        {
            "id": "ff1",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_ABSTRACT,
            "page": 1,
            "order": 1,
            "label_override": None,
            "help_text": None,
            "required": True,
        },
        {
            "id": "ff2",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_SPOKEN,
            "page": 1,
            "order": 0,
            "label_override": "Spoken before?",
            "help_text": "Tick if yes",
            "required": False,
        },
    )
    return seeded_db


# ── listing ────────────────────────────────────────────────────────────────


def test_list_forms_requires_auth(client):
    assert client.get(f"/api/events/{TEST_EVENT_ID}/forms").status_code == 401


def test_list_forms_counts_submissions(client, auth_headers, form_db):
    form_db.seed(
        "sessions",
        {"id": "s1", "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "source_form_id": FORM_ID},
        {"id": "s2", "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "source_form_id": FORM_ID},
        {"id": "s3", "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "source_form_id": None},
    )

    body = client.get(f"/api/events/{TEST_EVENT_ID}/forms", headers=auth_headers).json()

    assert len(body["forms"]) == 1
    assert body["forms"][0]["submission_count"] == 2


def test_list_forms_is_zero_not_missing_for_an_unused_form(client, auth_headers, form_db):
    body = client.get(f"/api/events/{TEST_EVENT_ID}/forms", headers=auth_headers).json()
    assert body["forms"][0]["submission_count"] == 0


def test_list_forms_excludes_other_orgs(client, auth_headers, form_db):
    form_db.seed(
        "forms",
        {
            "id": "theirs",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "slug": "theirs",
            "name": "Theirs",
        },
    )
    body = client.get(f"/api/events/{TEST_EVENT_ID}/forms", headers=auth_headers).json()
    assert [form["id"] for form in body["forms"]] == [FORM_ID]


# ── creation + slugs ───────────────────────────────────────────────────────


def test_create_form_derives_a_slug_from_the_name(client, auth_headers, seeded_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/forms",
        headers=auth_headers,
        json={"name": "Call for Speakers 2026!"},
    )

    assert response.status_code == 201
    form = response.json()["form"]
    assert form["slug"] == "call-for-speakers-2026"
    assert form["org_id"] == TEST_ORG_ID
    assert form["event_id"] == TEST_EVENT_ID
    assert form["welcome_html"] == ""
    assert form["settings"] == {}


def test_create_form_suffixes_a_taken_slug(client, auth_headers, form_db):
    """forms.slug is globally unique — a second org's identical name must land."""
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/forms",
        headers=auth_headers,
        json={"name": "Call for Speakers"},
    )

    slug = response.json()["form"]["slug"]
    assert slug.startswith("call-for-speakers-")
    assert len(slug) == len("call-for-speakers-") + 4


def test_create_form_prefers_an_explicit_slug(client, auth_headers, seeded_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/forms",
        headers=auth_headers,
        json={"name": "Call for Speakers", "slug": "CFP 2026"},
    )
    assert response.json()["form"]["slug"] == "cfp-2026"


def test_create_form_on_a_foreign_event_404s(client, auth_headers, seeded_db):
    response = client.post(
        f"/api/events/{OTHER_EVENT_ID}/forms", headers=auth_headers, json={"name": "Nope"}
    )
    assert response.status_code == 404
    assert seeded_db.rows("forms") == []


# ── detail + patch ─────────────────────────────────────────────────────────


def test_get_form_returns_layout_in_page_and_order(client, auth_headers, form_db):
    body = client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).json()

    assert body["form"]["slug"] == "call-for-speakers"
    assert [f["field_id"] for f in body["fields"]] == [F_SPOKEN, F_ABSTRACT]
    spoken = body["fields"][0]
    assert spoken["form_field_id"] == "ff2"
    assert spoken["label_override"] == "Spoken before?"
    assert spoken["public_name"] == "Have you spoken before?"
    assert spoken["field_type"] == "checkbox"
    assert spoken["help_text"] == "Tick if yes"
    assert spoken["page"] == 1


def test_get_form_returns_its_rules(client, auth_headers, form_db):
    form_db.seed(
        "question_rules",
        {
            "id": "r1",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "target_field_id": F_PRIOR,
            "logic": SHOW_PRIOR,
        },
    )
    body = client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).json()
    assert body["question_rules"] == [
        {"id": "r1", "target_field_id": F_PRIOR, "logic": SHOW_PRIOR}
    ]


def test_get_form_from_another_org_404s(client, auth_headers, form_db):
    form_db.rows("forms")[0]["org_id"] = OTHER_ORG_ID
    assert client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).status_code == 404


def test_patch_form(client, auth_headers, form_db):
    response = client.patch(
        f"/api/forms/{FORM_ID}",
        headers=auth_headers,
        json={"name": "  CFP  ", "settings": {"submission_limit": 3}},
    )

    assert response.status_code == 200
    form = response.json()["form"]
    assert form["name"] == "CFP"
    assert form["settings"] == {"submission_limit": 3}


def test_patch_form_never_moves_the_public_slug(client, auth_headers, form_db):
    """A live CFP link is already in someone's inbox."""
    client.patch(f"/api/forms/{FORM_ID}", headers=auth_headers, json={"slug": "moved"})
    assert form_db.rows("forms")[0]["slug"] == "call-for-speakers"


def test_patch_form_with_nothing_to_change_400s(client, auth_headers, form_db):
    assert client.patch(f"/api/forms/{FORM_ID}", headers=auth_headers, json={}).status_code == 400


# ── PUT layout ─────────────────────────────────────────────────────────────


def test_put_fields_replaces_the_whole_layout(client, auth_headers, form_db):
    response = client.put(
        f"/api/forms/{FORM_ID}/fields",
        headers=auth_headers,
        json={
            "fields": [
                {"field_id": F_SPOKEN, "page": 1, "order": 0, "required": True},
                {"field_id": F_PRIOR, "page": 2, "order": 1, "help_text": "Any link"},
            ]
        },
    )

    assert response.status_code == 200
    returned = response.json()["fields"]
    assert [f["field_id"] for f in returned] == [F_SPOKEN, F_PRIOR]
    # the abstract row is gone, the kept row was updated in place (same id)
    assert {row["field_id"] for row in form_db.rows("form_fields")} == {F_SPOKEN, F_PRIOR}
    kept = next(row for row in form_db.rows("form_fields") if row["field_id"] == F_SPOKEN)
    assert kept["id"] == "ff2"
    assert kept["required"] is True
    assert kept["label_override"] is None  # replaced, not merged


def test_put_fields_can_empty_a_form(client, auth_headers, form_db):
    response = client.put(
        f"/api/forms/{FORM_ID}/fields", headers=auth_headers, json={"fields": []}
    )
    assert response.json()["fields"] == []
    assert form_db.rows("form_fields") == []


def test_put_fields_rejects_a_repeated_field(client, auth_headers, form_db):
    response = client.put(
        f"/api/forms/{FORM_ID}/fields",
        headers=auth_headers,
        json={
            "fields": [
                {"field_id": F_SPOKEN, "page": 1, "order": 0},
                {"field_id": F_SPOKEN, "page": 1, "order": 1},
            ]
        },
    )
    assert response.status_code == 400
    assert F_SPOKEN in response.json()["detail"]


def test_put_fields_rejects_a_field_from_another_org(client, auth_headers, form_db):
    form_db.seed(
        "fields",
        {
            "id": "foreign",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "public_name": "Theirs",
            "field_type": "text",
        },
    )
    response = client.put(
        f"/api/forms/{FORM_ID}/fields",
        headers=auth_headers,
        json={"fields": [{"field_id": "foreign", "page": 1, "order": 0}]},
    )

    assert response.status_code == 400
    assert "Unknown field" in response.json()["detail"]
    # and nothing was destroyed on the way to failing
    assert len(form_db.rows("form_fields")) == 2


def test_put_fields_rejects_an_out_of_range_page(client, auth_headers, form_db):
    response = client.put(
        f"/api/forms/{FORM_ID}/fields",
        headers=auth_headers,
        json={"fields": [{"field_id": F_SPOKEN, "page": 9, "order": 0}]},
    )
    assert response.status_code == 422


# ── PUT rules ──────────────────────────────────────────────────────────────


def test_put_rules_replaces_and_normalizes(client, auth_headers, form_db):
    form_db.seed(
        "question_rules",
        {
            "id": "old",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "target_field_id": F_PRIOR,
            "logic": {"when": [], "match": "all", "action": "hide"},
        },
    )

    response = client.put(
        f"/api/forms/{FORM_ID}/rules",
        headers=auth_headers,
        json={
            "rules": [
                {
                    "target_field_id": F_PRIOR,
                    "logic": {
                        "when": [{"field": F_SPOKEN, "op": "eq", "value": True, "junk": 1}],
                        "action": "show",
                    },
                }
            ]
        },
    )

    assert response.status_code == 200
    rules = response.json()["question_rules"]
    assert len(rules) == 1
    assert rules[0]["target_field_id"] == F_PRIOR
    assert rules[0]["logic"] == SHOW_PRIOR
    assert len(form_db.rows("question_rules")) == 1


def test_put_rules_can_clear_them(client, auth_headers, form_db):
    form_db.seed(
        "question_rules",
        {
            "id": "old",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "target_field_id": F_PRIOR,
            "logic": SHOW_PRIOR,
        },
    )
    response = client.put(f"/api/forms/{FORM_ID}/rules", headers=auth_headers, json={"rules": []})

    assert response.json()["question_rules"] == []
    assert form_db.rows("question_rules") == []


@pytest.mark.parametrize(
    "logic",
    [
        {"when": [{"field": F_SPOKEN, "op": "starts_with", "value": "x"}], "action": "show"},
        {"when": [{"field": F_SPOKEN, "op": "eq", "value": 1}], "action": "reveal"},
        {"when": [{"field": F_SPOKEN, "op": "eq", "value": 1}], "action": "show", "match": "some"},
        {"action": "show"},
    ],
)
def test_put_rules_rejects_malformed_logic(client, auth_headers, form_db, logic):
    response = client.put(
        f"/api/forms/{FORM_ID}/rules",
        headers=auth_headers,
        json={"rules": [{"target_field_id": F_PRIOR, "logic": logic}]},
    )
    assert response.status_code == 400


def test_put_rules_rejects_a_bad_rule_without_writing_the_good_ones(
    client, auth_headers, form_db
):
    response = client.put(
        f"/api/forms/{FORM_ID}/rules",
        headers=auth_headers,
        json={
            "rules": [
                {"target_field_id": F_PRIOR, "logic": SHOW_PRIOR},
                {"target_field_id": F_PRIOR, "logic": {"when": [], "action": "nope"}},
            ]
        },
    )
    assert response.status_code == 400
    assert form_db.rows("question_rules") == []


def test_put_rules_rejects_a_target_from_another_org(client, auth_headers, form_db):
    response = client.put(
        f"/api/forms/{FORM_ID}/rules",
        headers=auth_headers,
        json={"rules": [{"target_field_id": "not-a-field", "logic": SHOW_PRIOR}]},
    )
    assert response.status_code == 400
    assert "Unknown field" in response.json()["detail"]


def test_put_rules_on_a_foreign_form_404s(client, auth_headers, form_db):
    form_db.rows("forms")[0]["org_id"] = OTHER_ORG_ID
    response = client.put(
        f"/api/forms/{FORM_ID}/rules",
        headers=auth_headers,
        json={"rules": [{"target_field_id": F_PRIOR, "logic": SHOW_PRIOR}]},
    )
    assert response.status_code == 404


# ── slug helpers ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value,expected",
    [
        ("Call for Speakers", "call-for-speakers"),
        ("  AI Builders Summit 2026!  ", "ai-builders-summit-2026"),
        ("Café Sessions", "cafe-sessions"),
        ("---", "item"),
        ("", "item"),
        (None, "item"),
        ("A/B testing", "a-b-testing"),
        ("Speaker  bio", "speaker-bio"),
    ],
)
def test_slugify(value, expected):
    assert slugify(value) == expected


def test_slugify_can_use_underscores_for_internal_names():
    assert slugify("Key takeaways", separator="_", fallback="field") == "key_takeaways"


def test_slugify_truncates_without_a_trailing_separator():
    assert slugify("x" * 40 + " " + "y" * 40, max_length=41) == "x" * 40
