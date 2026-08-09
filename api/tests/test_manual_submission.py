"""Organizer-typed submissions: the manual add path.

POST /api/events/{event_id}/sessions is the write behind the inbox's "Add
submission" dialog. It must land the same shape a CFP form produces — a contact,
a pending session, and a submitter participant — while staying org-scoped and
validating any track/format against the event.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

TRACK_ID = "track-platform"
FORMAT_ID = "format-talk"


@pytest.fixture
def add_db(seeded_db):
    seeded_db.seed(
        "tracks",
        {"id": TRACK_ID, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Platform", "order": 0},
    )
    seeded_db.seed(
        "formats",
        {"id": FORMAT_ID, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Talk", "default_duration_min": 30},
    )
    return seeded_db


def test_manual_add_creates_session_contact_and_participant(client, auth_headers, add_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/sessions",
        headers=auth_headers,
        json={
            "title": "Hand-entered talk",
            "submitter_name": "Ada Lovelace",
            "submitter_email": "Ada@Example.com",
            "abstract": "An abstract typed by the organizer.",
            "track_id": TRACK_ID,
            "format_id": FORMAT_ID,
        },
    )

    assert response.status_code == 201
    session = response.json()["session"]
    assert session["title"] == "Hand-entered talk"
    assert session["status"] == "pending"
    assert session["is_abstract"] is True
    assert session["track_id"] == TRACK_ID
    assert session["format_id"] == FORMAT_ID
    assert session["submitter"]["email"] == "ada@example.com"

    # A contact was created, email normalized, name split into first/last.
    contact = next(row for row in add_db.rows("contacts") if row["email"] == "ada@example.com")
    assert contact["event_id"] == TEST_EVENT_ID
    assert (contact["first_name"], contact["last_name"]) == ("Ada", "Lovelace")

    # The session carries the submitter contact and is under the right event/org.
    stored = next(row for row in add_db.rows("sessions") if row["title"] == "Hand-entered talk")
    assert stored["org_id"] == TEST_ORG_ID
    assert stored["event_id"] == TEST_EVENT_ID
    assert stored["submitter_contact_id"] == contact["id"]
    assert stored["submitted_at"]

    # And a submitter participant links the two.
    participant = next(
        row for row in add_db.rows("session_participants") if row["session_id"] == session["id"]
    )
    assert participant["role"] == "submitter"
    assert participant["is_primary"] is True
    assert participant["contact_id"] == contact["id"]


def test_manual_add_reuses_an_existing_contact(client, auth_headers, add_db):
    add_db.seed(
        "contacts",
        {
            "id": "contact-existing",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "grace@example.com",
            "first_name": "Grace",
            "last_name": "Hopper",
        },
    )

    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/sessions",
        headers=auth_headers,
        json={
            "title": "A second talk",
            "submitter_name": "Grace Hopper",
            "submitter_email": "grace@example.com",
        },
    )

    assert response.status_code == 201
    # No duplicate contact — the existing one is reused.
    grace = [row for row in add_db.rows("contacts") if row["email"] == "grace@example.com"]
    assert len(grace) == 1
    assert response.json()["session"]["submitter_contact_id"] == "contact-existing"


def test_manual_add_works_without_a_track_or_format(client, auth_headers, add_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/sessions",
        headers=auth_headers,
        json={"title": "Minimal", "submitter_email": "solo@example.com"},
    )

    assert response.status_code == 201
    session = response.json()["session"]
    assert session.get("track_id") is None
    assert session.get("format_id") is None
    assert add_db.rows("session_tracks") == []


def test_manual_add_rejects_a_track_from_another_event(client, auth_headers, add_db):
    add_db.seed(
        "tracks",
        {"id": "track-foreign", "org_id": OTHER_ORG_ID, "event_id": OTHER_EVENT_ID, "name": "Foreign"},
    )

    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/sessions",
        headers=auth_headers,
        json={"title": "Bad track", "submitter_email": "x@example.com", "track_id": "track-foreign"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Track not found"
    assert not any(row["title"] == "Bad track" for row in add_db.rows("sessions"))


def test_manual_add_is_org_scoped_to_the_event(client, auth_headers, add_db):
    response = client.post(
        f"/api/events/{OTHER_EVENT_ID}/sessions",
        headers=auth_headers,
        json={"title": "Cross-org", "submitter_email": "x@example.com"},
    )

    assert response.status_code == 404
    assert not any(row["title"] == "Cross-org" for row in add_db.rows("sessions"))


def test_manual_add_rejects_a_bad_email(client, auth_headers, add_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/sessions",
        headers=auth_headers,
        json={"title": "No email", "submitter_email": "not-an-email"},
    )

    assert response.status_code == 422
