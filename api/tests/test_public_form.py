"""The public CFP surface, now that conditional logic is in play.

The renderer and this endpoint must reach the same verdict on the same answers
— see tests/fixtures/question_rules.json. These tests are about the wiring:
the rules reach the renderer, and the server re-decides rather than trusting
whatever the browser posted.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

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


# ── co-speakers (multi-speaker sessions from the public CFP) ───────────────
# A talk can be co-presented, and the form is where that gets said. Each
# co-speaker becomes a contact on this event and a non-primary 'speaker'
# participant on the session; the submitter stays the primary.


def co_speaker(email: str, first: str = "Grace", last: str = "Hopper") -> dict:
    return {"email": email, "first_name": first, "last_name": last}


def participants_of(db, session_id: str) -> list[dict]:
    return [p for p in db.rows("session_participants") if p["session_id"] == session_id]


def test_co_speakers_become_contacts_and_participants(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[
                co_speaker("grace@example.com"),
                co_speaker("alan@example.com", "Alan", "Turing"),
            ],
        ),
    )

    assert response.status_code == 201
    session = public_db.rows("sessions")[0]

    # Each co-speaker is a real contact on THIS event, in THIS org.
    by_email = {c["email"]: c for c in public_db.rows("contacts")}
    assert set(by_email) == {"ada@example.com", "grace@example.com", "alan@example.com"}
    for email in ("grace@example.com", "alan@example.com"):
        assert by_email[email]["org_id"] == TEST_ORG_ID
        assert by_email[email]["event_id"] == TEST_EVENT_ID
    assert by_email["alan@example.com"]["first_name"] == "Alan"

    # The submitter is written twice (primary 'speaker' + 'submitter' of
    # record) so speaker-first consumers never drop them when co-speakers
    # exist; each co-speaker is a non-primary 'speaker'.
    parts = participants_of(public_db, session["id"])
    assert len(parts) == 4
    primary = [p for p in parts if p["is_primary"]]
    assert len(primary) == 1
    assert primary[0]["role"] == "speaker"
    assert primary[0]["contact_id"] == session["submitter_contact_id"]
    submitter_rows = [p for p in parts if p["role"] == "submitter"]
    assert len(submitter_rows) == 1
    assert submitter_rows[0]["contact_id"] == session["submitter_contact_id"]

    co_parts = [p for p in parts if p["role"] == "speaker" and not p["is_primary"]]
    assert {p["contact_id"] for p in co_parts} == {
        by_email["grace@example.com"]["id"],
        by_email["alan@example.com"]["id"],
    }
    assert all(p["org_id"] == TEST_ORG_ID for p in parts)


def test_a_submission_without_co_speakers_is_unchanged(client, public_db):
    """Solo path: the submitter is the primary speaker AND the submitter of record."""
    response = client.post(
        f"/public/forms/{SLUG}/submissions", json=submission(answers={F_ABSTRACT: "A tour."})
    )

    assert response.status_code == 201
    parts = participants_of(public_db, public_db.rows("sessions")[0]["id"])
    assert len(parts) == 2
    roles = {p["role"]: p for p in parts}
    assert set(roles) == {"speaker", "submitter"}
    assert roles["speaker"]["is_primary"] is True
    assert roles["submitter"]["is_primary"] is False
    assert roles["speaker"]["contact_id"] == roles["submitter"]["contact_id"]


def test_more_than_three_co_speakers_is_rejected(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[co_speaker(f"co{i}@example.com") for i in range(4)],
        ),
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "You can add up to 3 co-speakers."
    # Rejected before anything was written.
    assert public_db.rows("sessions") == []
    assert public_db.rows("contacts") == []


def test_a_co_speaker_cannot_be_the_submitter(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[co_speaker("Ada@Example.com", "Ada", "Lovelace")],
        ),
    )

    assert response.status_code == 400
    assert "different email" in response.json()["detail"]
    assert public_db.rows("sessions") == []
    assert public_db.rows("session_participants") == []


def test_the_same_co_speaker_twice_is_rejected(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[co_speaker("grace@example.com"), co_speaker("GRACE@example.com")],
        ),
    )

    assert response.status_code == 400
    assert "more than once" in response.json()["detail"]
    assert public_db.rows("sessions") == []


def test_a_co_speaker_with_a_bad_email_is_rejected(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[{"email": "not-an-email", "first_name": "Nope"}],
        ),
    )

    assert response.status_code == 422
    assert public_db.rows("sessions") == []


def test_an_existing_co_speaker_contact_is_reused_not_duplicated(client, public_db):
    """Someone the organizer already imported keeps their record — and their
    organizer-curated name is never clobbered by what a submitter typed."""
    public_db.seed(
        "contacts",
        {
            "id": "contact-grace",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "grace@example.com",
            "first_name": "Grace",
            "last_name": "Hopper",
        },
    )

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[co_speaker("grace@example.com", "Gracie", "H")],
        ),
    )

    assert response.status_code == 201
    graces = [c for c in public_db.rows("contacts") if c["email"] == "grace@example.com"]
    assert len(graces) == 1
    assert graces[0]["id"] == "contact-grace"
    assert graces[0]["last_name"] == "Hopper"  # not overwritten with "H"
    parts = participants_of(public_db, public_db.rows("sessions")[0]["id"])
    co_parts = [p for p in parts if p["role"] == "speaker" and not p["is_primary"]]
    assert {p["contact_id"] for p in co_parts} == {"contact-grace"}


def test_a_co_speaker_contact_from_another_event_is_not_reused(client, public_db):
    """Contacts are per-event: the same human at a different event is a
    different row, and a co-speaker must land on THIS event."""
    public_db.seed(
        "contacts",
        {
            "id": "contact-grace-elsewhere",
            "org_id": TEST_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "email": "grace@example.com",
            "first_name": "Grace",
            "last_name": "Hopper",
        },
    )

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[co_speaker("grace@example.com")],
        ),
    )

    assert response.status_code == 201
    parts = participants_of(public_db, public_db.rows("sessions")[0]["id"])
    co_contact_id = next(p["contact_id"] for p in parts if not p["is_primary"])
    assert co_contact_id != "contact-grace-elsewhere"
    created = next(c for c in public_db.rows("contacts") if c["id"] == co_contact_id)
    assert created["event_id"] == TEST_EVENT_ID


def test_a_co_speaker_contact_from_another_org_is_not_reused(client, public_db):
    public_db.seed(
        "contacts",
        {
            "id": "contact-grace-foreign",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "grace@example.com",
            "first_name": "Grace",
            "last_name": "Hopper",
        },
    )

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[co_speaker("grace@example.com")],
        ),
    )

    assert response.status_code == 201
    parts = participants_of(public_db, public_db.rows("sessions")[0]["id"])
    co_contact_id = next(p["contact_id"] for p in parts if not p["is_primary"])
    assert co_contact_id != "contact-grace-foreign"
    assert next(c for c in public_db.rows("contacts") if c["id"] == co_contact_id)[
        "org_id"
    ] == TEST_ORG_ID


def test_co_speakers_reach_the_organizer_session_detail(client, auth_headers, public_db):
    """The end of the wire: what the CFP collected is what the organizer's
    submission drawer renders as the session's participants."""
    client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour."},
            co_speakers=[co_speaker("grace@example.com")],
        ),
    )
    session_id = public_db.rows("sessions")[0]["id"]

    detail = client.get(f"/api/sessions/{session_id}", headers=auth_headers)
    assert detail.status_code == 200
    participants = detail.json()["participants"]

    # Primary first; the submitter appears as the primary speaker AND as the
    # submitter of record, with the co-speaker as a non-primary speaker.
    assert participants[0]["email"] == "ada@example.com"
    assert participants[0]["role"] == "speaker"
    assert participants[0]["is_primary"] is True
    assert sorted(p["role"] for p in participants) == ["speaker", "speaker", "submitter"]
    grace = next(p for p in participants if p["email"] == "grace@example.com")
    assert grace["role"] == "speaker"
    assert grace["is_primary"] is False
    assert grace["first_name"] == "Grace"


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


# ── in-app manage link is minted + returned at submit time ─────────────────
# The submitter proved ownership by submitting from their email, so the submit
# response hands them their OWN 'submitter' token — the confirmation screen can
# offer a manage link with no email round-trip (email delivery may be blocked).


def test_submission_returns_a_manage_token_scoped_to_the_contact(client, public_db):
    resp = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour."}),
    )
    assert resp.status_code == 201
    body = resp.json()

    assert body["manage_token"]
    assert f"/submit/{SLUG}/manage?token=" in body["manage_url"]
    assert body["manage_token"] in body["manage_url"]

    # A real 'submitter' magic link bound to THIS submission's contact — never
    # another submitter's, and never a portal/review purpose.
    session = public_db.rows("sessions")[0]
    tokens = public_db.rows("magic_link_tokens")
    assert len(tokens) == 1
    assert tokens[0]["purpose"] == "submitter"
    assert tokens[0]["org_id"] == TEST_ORG_ID
    assert tokens[0]["contact_id"] == session["submitter_contact_id"]


def test_returned_manage_token_reaches_the_manage_endpoints(client, public_db):
    token = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(title="Ada's talk", answers={F_ABSTRACT: "A tour."}),
    ).json()["manage_token"]

    listed = client.get(f"/public/submissions?token={token}")
    assert listed.status_code == 200
    subs = listed.json()["submissions"]
    assert [s["title"] for s in subs] == ["Ada's talk"]
    assert subs[0]["editable"] is True


def test_a_second_email_token_cannot_read_the_first_submitters_talks(client, public_db):
    ada = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(email="ada@example.com", title="Ada's talk",
                        answers={F_ABSTRACT: "A tour."}),
    ).json()["manage_token"]
    grace = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(email="grace@example.com", first_name="Grace",
                        title="Grace's talk", answers={F_ABSTRACT: "Another tour."}),
    ).json()["manage_token"]

    # Two emails, two contacts: each token sees ONLY its own submitter's talk.
    ada_titles = [
        s["title"] for s in client.get(f"/public/submissions?token={ada}").json()["submissions"]
    ]
    grace_titles = [
        s["title"] for s in client.get(f"/public/submissions?token={grace}").json()["submissions"]
    ]
    assert ada_titles == ["Ada's talk"]
    assert grace_titles == ["Grace's talk"]


# ── the form's taxonomy choices are LIVE, not a snapshot ────────────────────
# fields.options.choices froze the track/format names as they were when the
# question was built. Renaming a track in Settings left the CFP offering names
# that no longer existed — and answers to them mapped to no track at all.

F_FORMAT = "55555555-5555-5555-5555-555555555509"
FORMAT_TALK = "88888888-8888-8888-8888-888888888801"
FORMAT_WORKSHOP = "88888888-8888-8888-8888-888888888802"


def add_format_question(db) -> None:
    db.seed(
        "fields",
        {
            "id": F_FORMAT,
            "org_id": TEST_ORG_ID,
            "public_name": "Session format",
            "field_type": "dropdown",
            "options": {"choices": ["Talk", "Workshop"]},
            "required": False,
        },
    )
    db.seed(
        "form_fields",
        {
            "id": "ff5",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_FORMAT,
            "page": 1,
            "order": 4,
            "required": False,
        },
    )


def add_formats(db) -> None:
    db.seed(
        "formats",
        {
            "id": FORMAT_TALK,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Talk",
            "default_duration_min": 30,
        },
        {
            "id": FORMAT_WORKSHOP,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Workshop",
            "default_duration_min": 90,
        },
        # another org's format on the same event id — never offered, never mapped
        {
            "id": "foreign-format",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Fireside",
            "default_duration_min": 20,
        },
    )


def _field(body: dict, field_id: str) -> dict:
    return next(field for field in body["fields"] if field["id"] == field_id)


def test_track_choices_come_from_the_event_not_the_snapshot(client, public_db):
    add_track_question(public_db)
    add_tracks(public_db)
    # the organizer renames a track in Settings; the form's snapshot is stale
    public_db.rows("tracks")[0]["name"] = "Platform Engineering"

    body = client.get(f"/public/forms/{SLUG}").json()

    assert _field(body, F_TRACK)["options"]["choices"] == ["Platform Engineering", "AI"]


def test_format_choices_come_from_the_event_too(client, public_db):
    add_format_question(public_db)
    add_formats(public_db)
    public_db.rows("formats")[1]["name"] = "Workshop (120 min)"

    body = client.get(f"/public/forms/{SLUG}").json()

    assert _field(body, F_FORMAT)["options"]["choices"] == ["Talk", "Workshop (120 min)"]


def test_live_choices_never_cross_the_org_boundary(client, public_db):
    add_format_question(public_db)
    add_formats(public_db)

    body = client.get(f"/public/forms/{SLUG}").json()

    assert "Fireside" not in _field(body, F_FORMAT)["options"]["choices"]


def test_the_snapshot_still_renders_when_the_event_has_no_such_taxonomy(client, public_db):
    """An event with no formats keeps the question the organizer built."""
    add_format_question(public_db)

    body = client.get(f"/public/forms/{SLUG}").json()

    assert _field(body, F_FORMAT)["options"]["choices"] == ["Talk", "Workshop"]


def test_a_renamed_track_still_maps_the_answer_it_was_offered_under(client, public_db):
    add_track_question(public_db)
    add_tracks(public_db)
    public_db.rows("tracks")[0]["name"] = "Platform Engineering"

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_TRACK: "Platform Engineering"}),
    )

    assert response.status_code == 201
    assert public_db.rows("sessions")[0]["track_id"] == TRACK_PLATFORM


def test_a_format_answer_lands_on_the_session(client, public_db):
    """It never did: format_id was simply never derived from the answers."""
    add_format_question(public_db)
    add_formats(public_db)

    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(answers={F_ABSTRACT: "A tour.", F_FORMAT: "Workshop"}),
    )

    assert response.status_code == 201
    assert public_db.rows("sessions")[0]["format_id"] == FORMAT_WORKSHOP


def test_a_format_answer_is_not_read_as_a_track(client, public_db):
    add_track_question(public_db)
    add_tracks(public_db)
    add_format_question(public_db)
    add_formats(public_db)

    client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(
            answers={F_ABSTRACT: "A tour.", F_TRACK: "AI", F_FORMAT: "Workshop"}
        ),
    )

    session = public_db.rows("sessions")[0]
    assert session["track_id"] == TRACK_AI
    assert session["format_id"] == FORMAT_WORKSHOP


# ── the abstract the speaker typed reaches sessions.description ─────────────
# The public form has no separate description input — the abstract is a form
# QUESTION. Storing only the answer left `description` empty, which is what the
# submitter's own edit form (and the reviewer's scorecard) render.


def test_the_abstract_answer_becomes_the_session_description(client, public_db):
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(description="", answers={F_ABSTRACT: "One paragraph, as asked."}),
    )

    assert response.status_code == 201
    session = public_db.rows("sessions")[0]
    assert session["description"] == "One paragraph, as asked."
    # the answer is still stored verbatim; nothing moved, it was copied
    assert session["form_answers"][F_ABSTRACT] == "One paragraph, as asked."


def test_an_explicit_description_still_wins(client, public_db):
    """A caller that posts its own description is not overwritten."""
    response = client.post(
        f"/public/forms/{SLUG}/submissions",
        json=submission(description="Posted directly.", answers={F_ABSTRACT: "The answer."}),
    )

    assert response.status_code == 201
    assert public_db.rows("sessions")[0]["description"] == "Posted directly."
