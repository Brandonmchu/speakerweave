"""The public CFP surface, now that conditional logic is in play.

The renderer and this endpoint must reach the same verdict on the same answers
— see tests/fixtures/question_rules.json. These tests are about the wiring:
the rules reach the renderer, and the server re-decides rather than trusting
whatever the browser posted.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

FORM_ID = "66666666-6666-6666-6666-666666666601"
SLUG = "call-for-speakers"
F_ABSTRACT = "55555555-5555-5555-5555-555555555501"
F_SPOKEN = "55555555-5555-5555-5555-555555555507"
F_PRIOR = "55555555-5555-5555-5555-555555555506"
F_TRACK = "55555555-5555-5555-5555-555555555508"
TRACK_PLATFORM = "77777777-7777-7777-7777-777777777701"
TRACK_AI = "77777777-7777-7777-7777-777777777702"

SHOW_PRIOR = {
    "when": [{"field": F_SPOKEN, "op": "eq", "value": True}],
    "match": "all",
    "action": "show",
}
REQUIRE_PRIOR = {
    "when": [{"field": F_SPOKEN, "op": "eq", "value": True}],
    "match": "all",
    "action": "require",
}


def submission(**overrides) -> dict:
    return {
        "email": "ada@example.com",
        "first_name": "Ada",
        "last_name": "Lovelace",
        "title": "Scaling LLM inference",
        "description": "A practical tour.",
        "answers": {},
        **overrides,
    }


@pytest.fixture
def public_db(seeded_db):
    seeded_db.seed(
        "forms",
        {
            "id": FORM_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "slug": SLUG,
            "name": "Call for Speakers",
            "kind": "cfp",
            "welcome_html": "<p>Welcome</p>",
            "settings": {"submission_limit": 3},
        },
    )
    seeded_db.seed(
        "fields",
        {
            "id": F_ABSTRACT,
            "org_id": TEST_ORG_ID,
            "public_name": "Abstract",
            "field_type": "textarea",
            "options": {"max_length": 2000},
            "required": True,
        },
        {
            "id": F_SPOKEN,
            "org_id": TEST_ORG_ID,
            "public_name": "Have you spoken before?",
            "field_type": "checkbox",
            "options": {},
            "required": False,
        },
        {
            "id": F_PRIOR,
            "org_id": TEST_ORG_ID,
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
            "order": 0,
            "required": True,
        },
        {
            "id": "ff2",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_SPOKEN,
            "page": 1,
            "order": 1,
            "required": False,
        },
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
    return seeded_db


def add_rule(db, logic: dict, target: str = F_PRIOR) -> None:
    db.seed(
        "question_rules",
        {
            "id": f"rule-{len(db.rows('question_rules')) + 1}",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "target_field_id": target,
            "logic": logic,
        },
    )


def add_track_question(db, field_type: str = "dropdown") -> None:
    """The CFP's track question — a choice field whose options are the event's
    track names. Added per-test so the baseline form shape stays untouched."""
    db.seed(
        "fields",
        {
            "id": F_TRACK,
            "org_id": TEST_ORG_ID,
            "public_name": "Track",
            "field_type": field_type,
            "options": {"choices": ["Platform", "AI"]},
            "required": False,
        },
    )
    db.seed(
        "form_fields",
        {
            "id": "ff4",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_TRACK,
            "page": 1,
            "order": 3,
            "required": False,
        },
    )


def add_tracks(db) -> None:
    db.seed(
        "tracks",
        {
            "id": TRACK_PLATFORM,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Platform",
            "color": "#4962E2",
            "order": 0,
        },
        {
            "id": TRACK_AI,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "AI",
            "color": "#0F766E",
            "order": 1,
        },
    )


# ── GET /public/forms/{slug} ───────────────────────────────────────────────


def test_get_public_form_carries_its_rules(client, public_db):
    add_rule(public_db, SHOW_PRIOR)

    body = client.get(f"/public/forms/{SLUG}").json()

    assert body["question_rules"] == [
        {"id": "rule-1", "target_field_id": F_PRIOR, "logic": SHOW_PRIOR}
    ]


def test_get_public_form_has_an_empty_rule_list_when_there_are_none(client, public_db):
    assert client.get(f"/public/forms/{SLUG}").json()["question_rules"] == []


def test_get_public_form_shape_is_unchanged(client, public_db):
    body = client.get(f"/public/forms/{SLUG}").json()

    assert body["form"]["slug"] == SLUG
    assert body["event"]["name"] == "AI Builders Summit"
    assert [field["id"] for field in body["fields"]] == [F_ABSTRACT, F_SPOKEN, F_PRIOR]
    assert body["fields"][0] == {
        "id": F_ABSTRACT,
        "form_field_id": "ff1",
        "label": "Abstract",
        "type": "textarea",
        "options": {"max_length": 2000},
        "required": True,
        "help_text": None,
        "page": 1,
        "order": 0,
    }


def test_get_public_form_labels_prefer_the_override(client, public_db):
    public_db.rows("form_fields")[1]["label_override"] = "Spoken at a conference?"
    body = client.get(f"/public/forms/{SLUG}").json()
    assert body["fields"][1]["label"] == "Spoken at a conference?"


def test_unknown_slug_404s(client, public_db):
    assert client.get("/public/forms/nope").status_code == 404


# ── POST /public/forms/{slug}/submissions ──────────────────────────────────


def test_submission_stores_the_answers(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A practical tour."}),
    )

    assert response.status_code == 201
    session = public_db.rows("sessions")[0]
    assert session["form_answers"] == {F_ABSTRACT: "A practical tour."}
    assert session["org_id"] == TEST_ORG_ID
    assert session["source_form_id"] == FORM_ID


def test_missing_required_answer_400s_with_the_label(client, public_db):
    response = client.post(f"/public/forms/{SLUG}/submissions", json=submission(answers={}))

    assert response.status_code == 400
    assert response.json()["detail"] == '"Abstract" is required'
    # nothing was written on the way to rejecting
    assert public_db.rows("sessions") == []
    assert public_db.rows("contacts") == []


def test_blank_required_answer_is_not_an_answer(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions", json=submission(answers={F_ABSTRACT: "   "})
    )
    assert response.status_code == 400


def test_hidden_field_is_not_required_and_its_answer_is_dropped(client, public_db):
    """The speaker never saw this question; its stale answer must not be kept."""
    add_rule(public_db, SHOW_PRIOR)
    public_db.rows("form_fields")[2]["required"] = True

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour.", F_SPOKEN: False, F_PRIOR: "https://stale.example"}
        ),
    )

    assert response.status_code == 201
    assert public_db.rows("sessions")[0]["form_answers"] == {
        F_ABSTRACT: "A tour.",
        F_SPOKEN: False,
    }


def test_visible_conditional_field_is_still_validated(client, public_db):
    add_rule(public_db, SHOW_PRIOR)
    public_db.rows("form_fields")[2]["required"] = True

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_SPOKEN: True}),
    )

    assert response.status_code == 400
    assert response.json()["detail"] == '"Link to a prior talk" is required'


def test_a_require_rule_can_promote_an_optional_field(client, public_db):
    add_rule(public_db, REQUIRE_PRIOR)

    rejected = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_SPOKEN: True}),
    )
    assert rejected.status_code == 400
    assert "prior talk" in rejected.json()["detail"]

    accepted = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_SPOKEN: False}),
    )
    assert accepted.status_code == 201


def test_field_library_required_flag_still_counts(client, public_db):
    """required on the form OR on the field definition — either one binds."""
    public_db.rows("form_fields")[0]["required"] = False

    response = client.post(f"/public/forms/{SLUG}/submissions", json=submission(answers={}))
    assert response.status_code == 400
    assert response.json()["detail"] == '"Abstract" is required'


# ── multi-track submissions (migration 004) ────────────────────────────────


def test_a_multi_select_track_answer_persists_every_track(client, public_db):
    """A talk submitted to two tracks: both land in session_tracks, and the
    first stays on sessions.track_id as the primary track."""
    add_track_question(public_db, field_type="multi_select")
    add_tracks(public_db)

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_TRACK: "Platform, AI"}),
    )

    assert response.status_code == 201
    session = public_db.rows("sessions")[0]
    assert session["track_id"] == TRACK_PLATFORM
    memberships = public_db.rows("session_tracks")
    assert {row["track_id"] for row in memberships} == {TRACK_PLATFORM, TRACK_AI}
    assert all(row["session_id"] == session["id"] for row in memberships)
    assert all(row["org_id"] == TEST_ORG_ID for row in memberships)


def test_a_single_track_answer_behaves_like_one_track(client, public_db):
    add_track_question(public_db)
    add_tracks(public_db)

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_TRACK: "AI"}),
    )

    assert response.status_code == 201
    session = public_db.rows("sessions")[0]
    assert session["track_id"] == TRACK_AI
    assert [row["track_id"] for row in public_db.rows("session_tracks")] == [TRACK_AI]


def test_a_track_answer_can_carry_the_track_id_itself(client, public_db):
    """A dropdown built from ids (or a routing rule) selects the same track."""
    add_track_question(public_db)
    add_tracks(public_db)

    client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_TRACK: TRACK_AI}),
    )

    assert public_db.rows("sessions")[0]["track_id"] == TRACK_AI


def test_a_submission_without_a_track_answer_is_unchanged(client, public_db):
    add_track_question(public_db)
    add_tracks(public_db)

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour."}),
    )

    assert response.status_code == 201
    assert public_db.rows("sessions")[0].get("track_id") is None
    assert public_db.rows("session_tracks") == []


def test_only_a_choice_answer_can_name_a_track(client, public_db):
    """An abstract that happens to say "Platform" is not a track selection."""
    add_tracks(public_db)

    client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "Platform"}),
    )

    assert public_db.rows("sessions")[0].get("track_id") is None
    assert public_db.rows("session_tracks") == []


def test_a_track_from_another_org_is_never_selected(client, public_db):
    add_track_question(public_db)
    public_db.seed(
        "tracks",
        {
            "id": "track-foreign",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Platform",
            "color": "#000000",
            "order": 0,
        },
    )

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_TRACK: "Platform"}),
    )

    assert response.status_code == 201
    assert public_db.rows("sessions")[0].get("track_id") is None
    assert public_db.rows("session_tracks") == []


# ── GET response sanitization (defense in depth) ───────────────────────────


def test_public_get_sanitizes_stored_html(client, public_db):
    """A row written before the sanitizer existed must not fire in a browser."""
    public_db.rows("forms")[0]["welcome_html"] = "<p>Hi</p><img src=x onerror=alert(1)>"
    public_db.rows("forms")[0]["settings"] = {
        "confirmation_html": "<script>steal()</script><p>Thanks</p>"
    }

    body = client.get(f"/public/forms/{SLUG}").json()

    assert "onerror" not in body["form"]["welcome_html"]
    assert "<p>Hi</p>" in body["form"]["welcome_html"]
    assert "<script" not in body["form"]["settings"]["confirmation_html"]
    assert "<p>Thanks</p>" in body["form"]["settings"]["confirmation_html"]


# ── answer whitelisting + payload guards ───────────────────────────────────


def test_unknown_answer_key_is_dropped(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", "not_a_field": "junk"}),
    )
    assert response.status_code == 201
    assert public_db.rows("sessions")[0]["form_answers"] == {F_ABSTRACT: "A tour."}


def test_oversized_answer_value_is_rejected(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "x" * 10001}),
    )
    assert response.status_code == 400
    assert public_db.rows("sessions") == []


def test_nested_answer_value_is_rejected(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_SPOKEN: {"nested": 1}}),
    )
    assert response.status_code == 400
    assert public_db.rows("sessions") == []


# ── contact lookup is org-scoped ───────────────────────────────────────────


def test_contact_lookup_ignores_a_foreign_org_row(client, public_db):
    """A contact with the same (event, email) but another org must not be reused."""
    public_db.seed(
        "contacts",
        {
            "id": "foreign-contact",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "ada@example.com",
            "first_name": "Ada",
            "last_name": "Lovelace",
        },
    )

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour."}),
    )

    assert response.status_code == 201
    session = public_db.rows("sessions")[0]
    used = next(c for c in public_db.rows("contacts") if c["id"] == session["submitter_contact_id"])
    assert used["org_id"] == TEST_ORG_ID
    assert used["id"] != "foreign-contact"


# ── close_at + submission_limit enforced server-side ───────────────────────


def test_submission_is_rejected_after_close_at(client, public_db):
    public_db.rows("forms")[0]["settings"] = {"close_at": "2020-01-01T00:00:00+00:00"}

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour."}),
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "This call for papers is closed."
    assert public_db.rows("sessions") == []


def test_a_future_close_at_still_accepts(client, public_db):
    public_db.rows("forms")[0]["settings"] = {"close_at": "2099-01-01T00:00:00+00:00"}
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour."}),
    )
    assert response.status_code == 201


def test_submission_limit_is_enforced(client, public_db):
    public_db.rows("forms")[0]["settings"] = {"submission_limit": 1}

    first_resp = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour."}),
    )
    assert first_resp.status_code == 201

    second = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "Another tour."}),
    )
    assert second.status_code == 403
    assert second.json()["detail"] == "Submission limit reached."
    assert len(public_db.rows("sessions")) == 1


def test_a_withdrawn_submission_does_not_count_against_the_limit(client, public_db):
    public_db.rows("forms")[0]["settings"] = {"submission_limit": 1}

    client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour."}),
    )
    public_db.rows("sessions")[0]["status"] = "withdrawn"

    again = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A comeback."}),
    )
    assert again.status_code == 201
    assert len(public_db.rows("sessions")) == 2
