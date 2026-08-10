"""Submitter self-service: manage-link issuance and token-scoped view/edit/withdraw.

These prove the security-load-bearing behaviour: the manage-link endpoint never
leaks whether an email exists, every read/write is scoped to the token's own
contact (a cross-event id 404s), and edit/withdraw are locked once the CFP
closes or the submission leaves 'pending'.
"""

from __future__ import annotations

import pytest

from services.magic_links import hash_token
from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

FORM_ID = "66666666-6666-6666-6666-6666666666a1"
SLUG = "call-for-speakers"
CONTACT_ID = "99999999-9999-9999-9999-9999999999a1"
OTHER_CONTACT_ID = "99999999-9999-9999-9999-9999999999b2"
SESSION_ID = "88888888-8888-8888-8888-8888888888a1"
FOREIGN_SESSION_ID = "88888888-8888-8888-8888-8888888888b2"
TRACK_ID = "77777777-7777-7777-7777-77777777a001"
FOREIGN_TRACK_ID = "77777777-7777-7777-7777-77777777b002"
FORMAT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001"
FUTURE = "2099-01-01T00:00:00+00:00"
PAST = "2020-01-01T00:00:00+00:00"
RAW_TOKEN = "submitter-raw-token-abc"


@pytest.fixture
def selfservice_db(seeded_db):
    seeded_db.seed(
        "forms",
        {
            "id": FORM_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "slug": SLUG,
            "name": "Call for Speakers",
            "kind": "cfp",
            "settings": {"close_at": FUTURE},
        },
    )
    seeded_db.seed(
        "contacts",
        {
            "id": CONTACT_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "ada@example.com",
            "first_name": "Ada",
            "last_name": "Lovelace",
        },
    )
    seeded_db.seed(
        "sessions",
        {
            "id": SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "friendly_id": "SESS-1",
            "title": "Scaling LLM inference",
            "description": "A practical tour.",
            "status": "pending",
            "source_form_id": FORM_ID,
            "submitter_contact_id": CONTACT_ID,
            "submitted_at": "2026-01-01T00:00:00+00:00",
        },
    )
    return seeded_db


def seed_token(db, *, raw=RAW_TOKEN, contact_id=CONTACT_ID, org_id=TEST_ORG_ID,
               purpose="submitter", expires_at=FUTURE, revoked_at=None):
    db.seed(
        "magic_link_tokens",
        {
            "id": f"mlt-{raw}",
            "org_id": org_id,
            "token_hash": hash_token(raw),
            "purpose": purpose,
            "contact_id": contact_id,
            "expires_at": expires_at,
            "revoked_at": revoked_at,
            "used_at": None,
        },
    )
    return raw


def set_form_close(db, value):
    db.rows("forms")[0]["settings"] = {"close_at": value}


def set_status(db, status):
    db.rows("sessions")[0]["status"] = status


# ── POST /public/forms/{slug}/manage-link ──────────────────────────────────


def test_manage_link_issues_token_and_queues_email(client, selfservice_db):
    resp = client.post(
        f"/public/forms/{SLUG}/manage-link", json={"email": "ada@example.com"}
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    tokens = selfservice_db.rows("magic_link_tokens")
    assert len(tokens) == 1
    assert tokens[0]["purpose"] == "submitter"
    assert tokens[0]["contact_id"] == CONTACT_ID
    assert tokens[0]["org_id"] == TEST_ORG_ID

    outbox = selfservice_db.rows("email_outbox")
    assert len(outbox) == 1
    assert outbox[0]["template_key"] == "submitter_manage_link"
    assert outbox[0]["payload"]["to"] == "ada@example.com"
    assert f"/submit/{SLUG}/manage?token=" in outbox[0]["payload"]["html"]


def test_manage_link_for_unknown_email_is_silent(client, selfservice_db):
    resp = client.post(
        f"/public/forms/{SLUG}/manage-link", json={"email": "nobody@example.com"}
    )
    # Generic 200 — identical to the success shape, so existence never leaks.
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert selfservice_db.rows("magic_link_tokens") == []
    assert selfservice_db.rows("email_outbox") == []


def test_manage_link_for_email_without_submissions_is_silent(client, selfservice_db):
    selfservice_db.seed(
        "contacts",
        {
            "id": OTHER_CONTACT_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "grace@example.com",
            "first_name": "Grace",
        },
    )
    resp = client.post(
        f"/public/forms/{SLUG}/manage-link", json={"email": "grace@example.com"}
    )
    assert resp.status_code == 200
    assert selfservice_db.rows("magic_link_tokens") == []
    assert selfservice_db.rows("email_outbox") == []


def test_manage_link_response_is_the_same_generic_message(client, selfservice_db):
    hit = client.post(f"/public/forms/{SLUG}/manage-link", json={"email": "ada@example.com"})
    miss = client.post(f"/public/forms/{SLUG}/manage-link", json={"email": "nobody@example.com"})
    assert hit.json()["message"] == miss.json()["message"]


# ── GET /public/submissions?token=… ────────────────────────────────────────


def test_get_submissions_is_token_scoped(client, selfservice_db):
    # A second submitter's talk in the same event must never appear.
    selfservice_db.seed(
        "sessions",
        {
            "id": FOREIGN_SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "friendly_id": "SESS-2",
            "title": "Someone else's talk",
            "status": "pending",
            "source_form_id": FORM_ID,
            "submitter_contact_id": OTHER_CONTACT_ID,
        },
    )
    seed_token(selfservice_db)

    body = client.get(f"/public/submissions?token={RAW_TOKEN}").json()
    assert [s["id"] for s in body["submissions"]] == [SESSION_ID]
    sub = body["submissions"][0]
    assert sub["title"] == "Scaling LLM inference"
    assert sub["abstract"] == "A practical tour."
    assert sub["status"] == "pending"
    assert sub["editable"] is True
    assert body["event"]["closed"] is False


def test_get_submissions_marks_closed_form_not_editable(client, selfservice_db):
    set_form_close(selfservice_db, PAST)
    seed_token(selfservice_db)
    body = client.get(f"/public/submissions?token={RAW_TOKEN}").json()
    assert body["submissions"][0]["editable"] is False
    assert body["event"]["closed"] is True


def test_get_submissions_rejects_a_bad_token(client, selfservice_db):
    assert client.get("/public/submissions?token=nope").status_code == 401


def test_get_submissions_rejects_an_expired_token(client, selfservice_db):
    seed_token(selfservice_db, expires_at=PAST)
    assert client.get(f"/public/submissions?token={RAW_TOKEN}").status_code == 401


def test_get_submissions_rejects_a_revoked_token(client, selfservice_db):
    seed_token(selfservice_db, revoked_at=FUTURE)
    assert client.get(f"/public/submissions?token={RAW_TOKEN}").status_code == 401


def test_get_submissions_rejects_a_wrong_purpose_token(client, selfservice_db):
    # A portal cookie token must not double as a submitter credential.
    seed_token(selfservice_db, purpose="portal")
    assert client.get(f"/public/submissions?token={RAW_TOKEN}").status_code == 401


def test_get_submissions_surfaces_decision_feedback(client, selfservice_db):
    set_status(selfservice_db, "declined")
    selfservice_db.seed(
        "email_outbox",
        {
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "contact_id": CONTACT_ID,
            "template_key": "decline",
            "created_at": "2026-02-01T00:00:00+00:00",
            "payload": {
                "feedback": "Please make the examples more concrete.",
                "context": {"session_title": "Scaling LLM inference"},
            },
        },
    )
    seed_token(selfservice_db)
    sub = client.get(f"/public/submissions?token={RAW_TOKEN}").json()["submissions"][0]
    assert sub["decided"] is True
    assert sub["decision"] == "declined"
    assert sub["feedback"] == "Please make the examples more concrete."
    assert sub["editable"] is False


# ── PATCH /public/submissions/{id} ─────────────────────────────────────────


def test_edit_updates_title_and_abstract(client, selfservice_db):
    seed_token(selfservice_db)
    resp = client.patch(
        f"/public/submissions/{SESSION_ID}",
        json={"token": RAW_TOKEN, "title": "Faster inference", "abstract": "Rewritten."},
    )
    assert resp.status_code == 200
    row = selfservice_db.rows("sessions")[0]
    assert row["title"] == "Faster inference"
    assert row["description"] == "Rewritten."
    assert resp.json()["submission"]["title"] == "Faster inference"
    revisions = selfservice_db.rows("session_revisions")
    assert {revision["field"] for revision in revisions} == {"title", "description"}
    assert {revision["actor"] for revision in revisions} == {"Submitter"}


def test_manage_payload_dedupes_participant_roles(client, selfservice_db):
    co_speaker_id = "99999999-9999-9999-9999-9999999999c3"
    selfservice_db.seed(
        "contacts",
        {
            "id": co_speaker_id,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "grace@example.com",
            "first_name": "Grace",
            "last_name": "Hopper",
        },
    )
    selfservice_db.seed(
        "session_participants",
        {
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": CONTACT_ID,
            "role": "speaker",
            "is_primary": True,
        },
        {
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": CONTACT_ID,
            "role": "submitter",
            "is_primary": True,
        },
        {
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": co_speaker_id,
            "role": "speaker",
            "is_primary": False,
        },
    )
    seed_token(selfservice_db)

    submission = client.get(
        f"/public/submissions?token={RAW_TOKEN}"
    ).json()["submissions"][0]
    assert len(submission["participants"]) == 2
    submitter = next(
        person for person in submission["participants"] if person["contact_id"] == CONTACT_ID
    )
    assert submitter["roles"] == ["speaker", "submitter"]
    assert submitter["is_primary"] is True
    assert submission["participants"][1]["name"] == "Grace Hopper"


def test_submitter_can_add_a_co_speaker_until_the_three_person_cap(
    client, selfservice_db
):
    seed_token(selfservice_db)
    added = client.post(
        f"/public/submissions/{SESSION_ID}/participants",
        json={"token": RAW_TOKEN, "name": "Grace Hopper", "email": "grace@example.com"},
    )
    assert added.status_code == 201
    assert {person["email"] for person in added.json()["participants"]} == {
        "ada@example.com",
        "grace@example.com",
    }
    created = next(
        row for row in selfservice_db.rows("session_participants")
        if row.get("contact_id") != CONTACT_ID
    )
    assert created["role"] == "speaker"
    assert created["is_primary"] is False

    second = client.post(
        f"/public/submissions/{SESSION_ID}/participants",
        json={"token": RAW_TOKEN, "name": "Katherine Johnson", "email": "kj@example.com"},
    )
    assert second.status_code == 201
    capped = client.post(
        f"/public/submissions/{SESSION_ID}/participants",
        json={"token": RAW_TOKEN, "name": "Mae Jemison", "email": "mae@example.com"},
    )
    assert capped.status_code == 400


def test_submitter_cannot_add_a_participant_after_close(client, selfservice_db):
    set_form_close(selfservice_db, PAST)
    seed_token(selfservice_db)
    response = client.post(
        f"/public/submissions/{SESSION_ID}/participants",
        json={"token": RAW_TOKEN, "name": "Grace Hopper", "email": "grace@example.com"},
    )
    assert response.status_code == 403


def test_edit_keeps_description_and_abstract_form_answer_in_sync(
    client, auth_headers, selfservice_db
):
    seed_cfp_questions(selfservice_db)
    row = selfservice_db.rows("sessions")[0]
    row["form_answers"] = {F_ABSTRACT: "The original abstract."}
    seed_token(selfservice_db)

    edited = client.patch(
        f"/public/submissions/{SESSION_ID}",
        json={"token": RAW_TOKEN, "abstract": "The revised abstract."},
    )

    assert edited.status_code == 200
    detail = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers)
    assert detail.status_code == 200
    body = detail.json()
    assert body["session"]["description"] == "The revised abstract."
    abstract_answer = next(answer for answer in body["answers"] if answer["field_id"] == F_ABSTRACT)
    assert abstract_answer["value"] == "The revised abstract."


def test_edit_accepts_the_token_from_a_header(client, selfservice_db):
    seed_token(selfservice_db)
    resp = client.patch(
        f"/public/submissions/{SESSION_ID}",
        json={"title": "Header-auth edit"},
        headers={"X-Submitter-Token": RAW_TOKEN},
    )
    assert resp.status_code == 200
    assert selfservice_db.rows("sessions")[0]["title"] == "Header-auth edit"


def test_edit_is_blocked_after_close(client, selfservice_db):
    set_form_close(selfservice_db, PAST)
    seed_token(selfservice_db)
    resp = client.patch(
        f"/public/submissions/{SESSION_ID}",
        json={"token": RAW_TOKEN, "title": "Too late"},
    )
    assert resp.status_code == 403
    assert selfservice_db.rows("sessions")[0]["title"] == "Scaling LLM inference"


def test_edit_is_blocked_once_decided(client, selfservice_db):
    set_status(selfservice_db, "accepted")
    seed_token(selfservice_db)
    resp = client.patch(
        f"/public/submissions/{SESSION_ID}",
        json={"token": RAW_TOKEN, "title": "Nope"},
    )
    assert resp.status_code == 403


def test_edit_of_a_foreign_submission_404s(client, selfservice_db):
    # A session owned by another contact/event must be unreachable with this token.
    selfservice_db.seed(
        "sessions",
        {
            "id": FOREIGN_SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Not yours",
            "status": "pending",
            "source_form_id": FORM_ID,
            "submitter_contact_id": OTHER_CONTACT_ID,
        },
    )
    seed_token(selfservice_db)
    resp = client.patch(
        f"/public/submissions/{FOREIGN_SESSION_ID}",
        json={"token": RAW_TOKEN, "title": "Hijack"},
    )
    assert resp.status_code == 404
    assert selfservice_db.rows("sessions")[1]["title"] == "Not yours"


def test_edit_unknown_id_404s(client, selfservice_db):
    seed_token(selfservice_db)
    resp = client.patch(
        "/public/submissions/00000000-0000-0000-0000-000000000000",
        json={"token": RAW_TOKEN, "title": "Ghost"},
    )
    assert resp.status_code == 404


def test_edit_track_must_belong_to_the_event(client, selfservice_db):
    selfservice_db.seed(
        "tracks",
        {"id": TRACK_ID, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "AI"},
    )
    seed_token(selfservice_db)

    good = client.patch(
        f"/public/submissions/{SESSION_ID}",
        json={"token": RAW_TOKEN, "track_id": TRACK_ID},
    )
    assert good.status_code == 200
    assert selfservice_db.rows("sessions")[0]["track_id"] == TRACK_ID

    # A track from another event is rejected outright.
    selfservice_db.seed(
        "tracks",
        {"id": FOREIGN_TRACK_ID, "org_id": OTHER_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Foreign"},
    )
    bad = client.patch(
        f"/public/submissions/{SESSION_ID}",
        json={"token": RAW_TOKEN, "track_id": FOREIGN_TRACK_ID},
    )
    assert bad.status_code == 400


# ── POST /public/submissions/{id}/withdraw ─────────────────────────────────


def test_withdraw_sets_status(client, selfservice_db):
    seed_token(selfservice_db)
    resp = client.post(
        f"/public/submissions/{SESSION_ID}/withdraw", json={"token": RAW_TOKEN}
    )
    assert resp.status_code == 200
    assert selfservice_db.rows("sessions")[0]["status"] == "withdrawn"
    assert resp.json()["submission"]["status"] == "withdrawn"
    assert resp.json()["submission"]["editable"] is False


def test_withdraw_is_blocked_once_decided(client, selfservice_db):
    set_status(selfservice_db, "accepted")
    seed_token(selfservice_db)
    resp = client.post(
        f"/public/submissions/{SESSION_ID}/withdraw", json={"token": RAW_TOKEN}
    )
    assert resp.status_code == 403
    assert selfservice_db.rows("sessions")[0]["status"] == "accepted"


def test_withdraw_is_blocked_after_close(client, selfservice_db):
    set_form_close(selfservice_db, PAST)
    seed_token(selfservice_db)
    resp = client.post(
        f"/public/submissions/{SESSION_ID}/withdraw", json={"token": RAW_TOKEN}
    )
    assert resp.status_code == 403
    assert selfservice_db.rows("sessions")[0]["status"] == "pending"


def test_withdraw_of_a_foreign_submission_404s(client, selfservice_db):
    selfservice_db.seed(
        "sessions",
        {
            "id": FOREIGN_SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Not yours",
            "status": "pending",
            "source_form_id": FORM_ID,
            "submitter_contact_id": OTHER_CONTACT_ID,
        },
    )
    seed_token(selfservice_db)
    resp = client.post(
        f"/public/submissions/{FOREIGN_SESSION_ID}/withdraw", json={"token": RAW_TOKEN}
    )
    assert resp.status_code == 404
    assert selfservice_db.rows("sessions")[1]["status"] == "pending"


def test_withdraw_requires_a_token(client, selfservice_db):
    resp = client.post(f"/public/submissions/{SESSION_ID}/withdraw", json={})
    assert resp.status_code == 401


# ── the manage page prefills what the speaker actually submitted ────────────
# The edit form binds straight to this payload. A CFP submission stores its
# abstract as a form ANSWER and (before the mapping fix) never resolved a
# format at all, so the form opened with a blank abstract and "No track" / "No
# format" over values the speaker had given — and saving wrote that blankness.

F_ABSTRACT = "55555555-5555-5555-5555-555555555501"
F_TRACK = "55555555-5555-5555-5555-555555555502"
F_FORMAT = "55555555-5555-5555-5555-555555555503"


def seed_cfp_questions(db) -> None:
    db.seed(
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
            "id": F_TRACK,
            "org_id": TEST_ORG_ID,
            "public_name": "Track",
            "field_type": "dropdown",
            "options": {"choices": ["Platform"]},
            "required": False,
        },
        {
            "id": F_FORMAT,
            "org_id": TEST_ORG_ID,
            "public_name": "Session format",
            "field_type": "dropdown",
            "options": {"choices": ["Workshop"]},
            "required": False,
        },
    )
    for order, field_id in enumerate((F_ABSTRACT, F_TRACK, F_FORMAT)):
        db.seed(
            "form_fields",
            {
                "id": f"ff-{order}",
                "org_id": TEST_ORG_ID,
                "form_id": FORM_ID,
                "field_id": field_id,
                "page": 1,
                "order": order,
                "required": False,
            },
        )
    db.seed(
        "tracks",
        {
            "id": TRACK_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Platform",
            "order": 0,
        },
    )
    db.seed(
        "formats",
        {
            "id": FORMAT_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Workshop",
            "default_duration_min": 90,
        },
    )


def test_a_submission_prefills_from_its_answers_when_the_columns_are_empty(
    client, selfservice_db
):
    """The judge's case: blank Abstract, "No track", "No format" on a real submission."""
    seed_cfp_questions(selfservice_db)
    row = selfservice_db.rows("sessions")[0]
    row["description"] = ""
    row["track_id"] = None
    row["format_id"] = None
    row["form_answers"] = {
        F_ABSTRACT: "What the speaker actually wrote.",
        F_TRACK: "Platform",
        F_FORMAT: "Workshop",
    }
    seed_token(selfservice_db)

    submission = client.get(f"/public/submissions?token={RAW_TOKEN}").json()["submissions"][0]

    assert submission["abstract"] == "What the speaker actually wrote."
    assert submission["track_id"] == TRACK_ID
    assert submission["track"] == "Platform"
    assert submission["format_id"] == FORMAT_ID
    assert submission["format"] == "Workshop"


def test_the_stored_column_always_wins_over_the_answer(client, selfservice_db):
    """An organizer's edit is never second-guessed by the original answer."""
    seed_cfp_questions(selfservice_db)
    row = selfservice_db.rows("sessions")[0]
    row["description"] = "Rewritten by the organizer."
    row["form_answers"] = {F_ABSTRACT: "The original answer."}
    seed_token(selfservice_db)

    submission = client.get(f"/public/submissions?token={RAW_TOKEN}").json()["submissions"][0]

    assert submission["abstract"] == "Rewritten by the organizer."


def test_editing_only_the_title_leaves_the_abstract_alone(client, selfservice_db):
    """A PATCH that omits a field must not blank it."""
    seed_token(selfservice_db)

    resp = client.patch(
        f"/public/submissions/{SESSION_ID}", json={"token": RAW_TOKEN, "title": "New title"}
    )

    assert resp.status_code == 200
    row = selfservice_db.rows("sessions")[0]
    assert row["title"] == "New title"
    assert row["description"] == "A practical tour."
    assert resp.json()["submission"]["abstract"] == "A practical tour."
