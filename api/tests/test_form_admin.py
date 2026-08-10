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


# ── the builder's Track / Session format choices are LIVE ──────────────────
# The builder listed `fields.options.choices`, frozen when the question was
# created, while the public form has offered the event's real names since the
# taxonomy went live. An organizer renaming formats in Settings therefore
# authored `show when Session format equals "Workshop"` against a form that
# offers "Workshop (120 min)" — a rule that could never fire (CFP-02).

F_FORMAT = "55555555-5555-5555-5555-555555555509"
F_PREREQ = "55555555-5555-5555-5555-555555555510"


def add_renamed_format_cfp(db, operand: str = "Workshop") -> None:
    """A format question whose snapshot is stale, the event's renamed formats,
    and a show-rule authored under the OLD name."""
    db.seed(
        "fields",
        {
            "id": F_FORMAT,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "scope": "session",
            "public_name": "Session format",
            "field_type": "dropdown",
            "options": {"choices": ["Talk", "Workshop"]},
            "required": False,
        },
        {
            "id": F_PREREQ,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "scope": "session",
            "public_name": "Workshop prerequisites",
            "field_type": "textarea",
            "options": {},
            "required": False,
        },
    )
    db.seed(
        "form_fields",
        {
            "id": "ff3",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_FORMAT,
            "page": 1,
            "order": 2,
            "required": False,
        },
        {
            "id": "ff4",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_PREREQ,
            "page": 1,
            "order": 3,
            "required": False,
        },
    )
    db.seed(
        "formats",
        {
            "id": "fmt-talk",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Talk (30 min)",
        },
        {
            "id": "fmt-workshop",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Workshop (120 min)",
        },
    )
    db.seed(
        "question_rules",
        {
            "id": "r-workshop",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "target_field_id": F_PREREQ,
            "logic": {
                "when": [{"field": F_FORMAT, "op": "eq", "value": operand}],
                "match": "all",
                "action": "show",
            },
        },
    )


def _builder_field(body: dict, field_id: str) -> dict:
    return next(f for f in body["fields"] if f["field_id"] == field_id)


def test_the_builder_lists_the_events_current_format_names(client, auth_headers, form_db):
    add_renamed_format_cfp(form_db)

    body = client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).json()

    assert _builder_field(body, F_FORMAT)["options"]["choices"] == [
        "Talk (30 min)",
        "Workshop (120 min)",
    ]


def test_the_builder_reads_an_old_rule_as_naming_the_renamed_format(
    client, auth_headers, form_db
):
    """The rule was authored as `equals "Workshop"`. It still means the format
    now called "Workshop (120 min)", and the builder must say so — otherwise the
    organizer sees a rule pointing at a choice that is no longer on the list."""
    add_renamed_format_cfp(form_db)

    body = client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).json()

    assert body["question_rules"][0]["logic"]["when"] == [
        {"field": F_FORMAT, "op": "eq", "value": "Workshop (120 min)"}
    ]


def test_an_operand_with_no_live_counterpart_is_shown_as_authored(
    client, auth_headers, form_db
):
    """A format that was deleted rather than renamed has nothing to point at.
    The rule stays exactly as written so the organizer can see and fix it."""
    add_renamed_format_cfp(form_db, operand="Fireside chat")

    body = client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).json()

    assert body["question_rules"][0]["logic"]["when"][0]["value"] == "Fireside chat"


def test_the_builder_keeps_the_snapshot_when_the_event_has_no_formats(
    client, auth_headers, form_db
):
    add_renamed_format_cfp(form_db)
    form_db.rows("formats").clear()

    body = client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).json()

    assert _builder_field(body, F_FORMAT)["options"]["choices"] == ["Talk", "Workshop"]
    assert body["question_rules"][0]["logic"]["when"][0]["value"] == "Workshop"


def test_the_builder_and_the_public_form_offer_the_same_choices(
    client, auth_headers, form_db
):
    """The parity that matters: what the organizer authors against and what the
    speaker is shown are the same list, resolved the same way."""
    add_renamed_format_cfp(form_db)

    builder = client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).json()
    public = client.get("/public/forms/call-for-speakers").json()

    public_format = next(f for f in public["fields"] if f["id"] == F_FORMAT)
    assert _builder_field(builder, F_FORMAT)["options"]["choices"] == (
        public_format["options"]["choices"]
    )
    assert builder["question_rules"][0]["logic"] == public["question_rules"][0]["logic"]


def test_a_non_taxonomy_dropdown_keeps_its_authored_choices(client, auth_headers, form_db):
    audience = "55555555-5555-5555-5555-555555555511"
    add_renamed_format_cfp(form_db)
    form_db.seed(
        "fields",
        {
            "id": audience,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "scope": "session",
            "public_name": "Audience level",
            "field_type": "dropdown",
            "options": {"choices": ["Beginner", "Intermediate", "Advanced"]},
            "required": False,
        },
    )
    form_db.seed(
        "form_fields",
        {
            "id": "ff5",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": audience,
            "page": 1,
            "order": 4,
            "required": False,
        },
    )

    body = client.get(f"/api/forms/{FORM_ID}", headers=auth_headers).json()

    assert _builder_field(body, audience)["options"]["choices"] == [
        "Beginner",
        "Intermediate",
        "Advanced",
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
    # A rule may only target/reference fields placed on the form, so put F_PRIOR
    # on it before writing a rule against it.
    form_db.seed(
        "form_fields",
        {
            "id": "ff3",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_PRIOR,
            "page": 1,
            "order": 2,
            "required": False,
        },
    )
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


# ── HTML sanitization (stored XSS) ─────────────────────────────────────────

XSS_HTML = '<p>Hello</p><img src=x onerror=alert(1)><script>alert(2)</script>'


def test_create_form_sanitizes_welcome_and_confirmation_html(client, auth_headers, seeded_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/forms",
        headers=auth_headers,
        json={
            "name": "CFP",
            "welcome_html": XSS_HTML,
            "settings": {"confirmation_html": XSS_HTML, "submission_limit": 2},
        },
    )

    assert response.status_code == 201
    form = response.json()["form"]
    assert "onerror" not in form["welcome_html"]
    assert "<script" not in form["welcome_html"]
    assert "<p>Hello</p>" in form["welcome_html"]
    assert "onerror" not in form["settings"]["confirmation_html"]
    assert "<script" not in form["settings"]["confirmation_html"]
    # non-html settings survive untouched
    assert form["settings"]["submission_limit"] == 2


def test_patch_form_sanitizes_welcome_and_confirmation_html(client, auth_headers, form_db):
    response = client.patch(
        f"/api/forms/{FORM_ID}",
        headers=auth_headers,
        json={"welcome_html": XSS_HTML, "settings": {"confirmation_html": XSS_HTML}},
    )

    assert response.status_code == 200
    form = response.json()["form"]
    assert "onerror" not in form["welcome_html"] and "<script" not in form["welcome_html"]
    assert "onerror" not in form["settings"]["confirmation_html"]
    assert form_db.rows("forms")[0]["welcome_html"] == form["welcome_html"]


# ── field/rule cross-event integrity + orphan cleanup ──────────────────────


def test_put_fields_accepts_an_org_global_field(client, auth_headers, form_db):
    """event_id is null => the field belongs to every event, this form included."""
    form_db.seed(
        "fields",
        {
            "id": "global-field",
            "org_id": TEST_ORG_ID,
            "event_id": None,
            "scope": "session",
            "public_name": "Anything",
            "field_type": "text",
        },
    )
    response = client.put(
        f"/api/forms/{FORM_ID}/fields",
        headers=auth_headers,
        json={"fields": [{"field_id": "global-field", "page": 1, "order": 0}]},
    )
    assert response.status_code == 200
    assert [f["field_id"] for f in response.json()["fields"]] == ["global-field"]


def test_put_fields_rejects_a_field_from_another_event(client, auth_headers, form_db):
    """Same org, different event, not org-global — must not cross events."""
    form_db.seed(
        "fields",
        {
            "id": "other-event-field",
            "org_id": TEST_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "scope": "session",
            "public_name": "Theirs",
            "field_type": "text",
        },
    )
    response = client.put(
        f"/api/forms/{FORM_ID}/fields",
        headers=auth_headers,
        json={"fields": [{"field_id": "other-event-field", "page": 1, "order": 0}]},
    )
    assert response.status_code == 400
    assert "another event" in response.json()["detail"]
    assert len(form_db.rows("form_fields")) == 2  # nothing destroyed on the way to 400


def test_put_rules_rejects_a_field_not_on_the_form(client, auth_headers, form_db):
    """F_PRIOR exists in the library on this event but is not placed on the form."""
    response = client.put(
        f"/api/forms/{FORM_ID}/rules",
        headers=auth_headers,
        json={"rules": [{"target_field_id": F_PRIOR, "logic": SHOW_PRIOR}]},
    )
    assert response.status_code == 400
    assert "not on this form" in response.json()["detail"]
    assert form_db.rows("question_rules") == []


def test_put_fields_cleans_up_rules_that_reference_a_removed_field(client, auth_headers, form_db):
    form_db.seed(
        "question_rules",
        # orphaned: targets F_ABSTRACT, which the replace below removes
        {
            "id": "r-orphan",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "target_field_id": F_ABSTRACT,
            "logic": {"when": [{"field": F_SPOKEN, "op": "eq", "value": True}], "action": "hide"},
        },
        # survives: only references F_SPOKEN, which stays on the form
        {
            "id": "r-keep",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "target_field_id": F_SPOKEN,
            "logic": {"when": [], "action": "require"},
        },
    )

    response = client.put(
        f"/api/forms/{FORM_ID}/fields",
        headers=auth_headers,
        json={"fields": [{"field_id": F_SPOKEN, "page": 1, "order": 0}]},
    )

    assert response.status_code == 200
    remaining = [r["id"] for r in form_db.rows("question_rules")]
    assert remaining == ["r-keep"]


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
