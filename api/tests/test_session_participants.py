"""Editing a submission's participants after it was submitted (ABS-11).

A co-speaker named on the CFP form is not the end of the story: people join a
talk, drop off it, and swap who leads it, all after the call closes. These
endpoints are that, and every one of them has to leave the CFP's storage
encoding alone — the submitter is written TWICE on purpose (once as the primary
'speaker', once as the 'submitter' of record) because consumers that resolve a
session's speakers filter role='speaker' first.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

SESSION_ID = "session-ci"
PRIYA = "contact-priya"
MARCUS = "contact-marcus"


@pytest.fixture
def submission_db(seeded_db):
    """One submitted talk, encoded exactly the way the public CFP writes it."""
    seeded_db.seed(
        "sessions",
        {
            "id": SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Taming 40-Minute CI",
            "friendly_id": "SESS-1",
            "status": "pending",
            "description": "Incremental builds at monorepo scale.",
            "submitter_contact_id": PRIYA,
            "form_answers": {},
        },
        {
            "id": "session-theirs",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Another org's talk",
            "status": "pending",
        },
    )
    seeded_db.seed(
        "contacts",
        {
            "id": PRIYA,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "priya@example.com",
            "first_name": "Priya",
            "last_name": "Raman",
        },
    )
    seeded_db.seed(
        "session_participants",
        {
            "id": "sp-priya-speaker",
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": PRIYA,
            "role": "speaker",
            "is_primary": True,
        },
        {
            "id": "sp-priya-submitter",
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": PRIYA,
            "role": "submitter",
            "is_primary": False,
        },
    )
    return seeded_db


def _add_marcus(client, auth_headers, **overrides):
    body = {"name": "Marcus Okafor", "email": "Marcus@Example.com"}
    body.update(overrides)
    return client.post(
        f"/api/sessions/{SESSION_ID}/participants", headers=auth_headers, json=body
    )


def test_a_co_speaker_can_be_added_after_submission(client, auth_headers, submission_db):
    response = _add_marcus(client, auth_headers)

    assert response.status_code == 201
    people = response.json()["participants"]
    by_email = {row["email"]: row for row in people}
    assert by_email["marcus@example.com"]["role"] == "speaker"
    assert by_email["marcus@example.com"]["is_primary"] is False
    assert (
        by_email["marcus@example.com"]["first_name"],
        by_email["marcus@example.com"]["last_name"],
    ) == ("Marcus", "Okafor")

    # The contact was created on this event, with the email normalized.
    contact = next(
        row for row in submission_db.rows("contacts") if row["email"] == "marcus@example.com"
    )
    assert contact["event_id"] == TEST_EVENT_ID
    assert contact["org_id"] == TEST_ORG_ID

    # The submitter's dual row is untouched — adding a co-speaker must never
    # drop the original speaker from the public program.
    priya_rows = sorted(
        row["role"]
        for row in submission_db.rows("session_participants")
        if row["contact_id"] == PRIYA
    )
    assert priya_rows == ["speaker", "submitter"]
    assert next(
        row["is_primary"]
        for row in submission_db.rows("session_participants")
        if row["contact_id"] == PRIYA and row["role"] == "speaker"
    )


def test_adding_an_existing_contact_reuses_it_instead_of_duplicating(
    client, auth_headers, submission_db
):
    submission_db.seed(
        "contacts",
        {
            "id": MARCUS,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "marcus@example.com",
            "first_name": "Marcus",
            "last_name": "Okafor",
        },
    )

    response = _add_marcus(client, auth_headers)

    assert response.status_code == 201
    assert (
        len([row for row in submission_db.rows("contacts") if row["email"] == "marcus@example.com"])
        == 1
    )
    linked = [
        row for row in submission_db.rows("session_participants") if row["contact_id"] == MARCUS
    ]
    assert len(linked) == 1


def test_adding_the_same_co_speaker_twice_is_a_409(client, auth_headers, submission_db):
    assert _add_marcus(client, auth_headers).status_code == 201

    duplicate = _add_marcus(client, auth_headers)

    assert duplicate.status_code == 409
    assert "already a speaker" in duplicate.json()["detail"]


def test_a_bad_email_is_rejected_before_anything_is_written(
    client, auth_headers, submission_db
):
    response = _add_marcus(client, auth_headers, email="not-an-email")

    assert response.status_code == 422
    assert submission_db.rows("contacts") == [
        row for row in submission_db.rows("contacts") if row["id"] == PRIYA
    ]


def test_a_non_primary_participant_can_be_removed(client, auth_headers, submission_db):
    _add_marcus(client, auth_headers)
    marcus_id = next(
        row["id"] for row in submission_db.rows("contacts") if row["email"] == "marcus@example.com"
    )

    response = client.delete(
        f"/api/sessions/{SESSION_ID}/participants/{marcus_id}", headers=auth_headers
    )

    assert response.status_code == 200
    assert [row["email"] for row in response.json()["participants"]] == ["priya@example.com"] * 2
    assert not [
        row
        for row in submission_db.rows("session_participants")
        if row["contact_id"] == marcus_id
    ]


def test_the_primary_speaker_cannot_simply_be_removed(client, auth_headers, submission_db):
    response = client.delete(
        f"/api/sessions/{SESSION_ID}/participants/{PRIYA}", headers=auth_headers
    )

    assert response.status_code == 400
    assert "primary speaker" in response.json()["detail"]
    # Nothing was dropped: the talk still has its lead.
    assert len(submission_db.rows("session_participants")) == 2


def test_removing_somebody_who_is_not_on_the_submission_is_a_404(
    client, auth_headers, submission_db
):
    response = client.delete(
        f"/api/sessions/{SESSION_ID}/participants/contact-nobody", headers=auth_headers
    )

    assert response.status_code == 404


def test_primary_can_be_handed_to_a_co_speaker(client, auth_headers, submission_db):
    _add_marcus(client, auth_headers)
    marcus_id = next(
        row["id"] for row in submission_db.rows("contacts") if row["email"] == "marcus@example.com"
    )

    response = client.post(
        f"/api/sessions/{SESSION_ID}/participants/{marcus_id}/primary", headers=auth_headers
    )

    assert response.status_code == 200
    primaries = {
        row["contact_id"]
        for row in submission_db.rows("session_participants")
        if row["is_primary"]
    }
    assert primaries == {marcus_id}
    # Priya keeps both her rows — she is still a speaker and still the submitter
    # of record; only the lead moved.
    priya_roles = sorted(
        row["role"]
        for row in submission_db.rows("session_participants")
        if row["contact_id"] == PRIYA
    )
    assert priya_roles == ["speaker", "submitter"]

    # …and now she can be removed, because she no longer leads the talk.
    dropped = client.delete(
        f"/api/sessions/{SESSION_ID}/participants/{PRIYA}", headers=auth_headers
    )
    assert dropped.status_code == 200
    assert [row["email"] for row in dropped.json()["participants"]] == ["marcus@example.com"]


def test_a_submitter_of_record_row_cannot_be_made_primary(
    client, auth_headers, submission_db
):
    """Only a speaker leads a talk; a submitter row is bookkeeping."""
    submission_db.seed(
        "contacts",
        {
            "id": "contact-assistant",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "assistant@example.com",
        },
    )
    submission_db.seed(
        "session_participants",
        {
            "id": "sp-assistant",
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": "contact-assistant",
            "role": "submitter",
            "is_primary": False,
        },
    )

    response = client.post(
        f"/api/sessions/{SESSION_ID}/participants/contact-assistant/primary",
        headers=auth_headers,
    )

    assert response.status_code == 404
    assert "not a speaker" in response.json()["detail"]


def test_participant_edits_never_cross_an_org(client, auth_headers, submission_db):
    add = client.post(
        "/api/sessions/session-theirs/participants",
        headers=auth_headers,
        json={"name": "Sneaky", "email": "sneaky@example.com"},
    )
    assert add.status_code == 404

    assert (
        client.delete(
            f"/api/sessions/session-theirs/participants/{PRIYA}", headers=auth_headers
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/sessions/session-theirs/participants/{PRIYA}/primary", headers=auth_headers
        ).status_code
        == 404
    )
    assert not submission_db.rows("contacts") or all(
        row["email"] != "sneaky@example.com" for row in submission_db.rows("contacts")
    )


def test_the_drawer_read_reflects_an_edit(client, auth_headers, submission_db):
    """GET /api/sessions/{id} is what the drawer renders — it must see the change."""
    _add_marcus(client, auth_headers)

    detail = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()

    emails = [row["email"] for row in detail["participants"]]
    assert emails.count("marcus@example.com") == 1
    assert emails.count("priya@example.com") == 2  # speaker + submitter, as stored
