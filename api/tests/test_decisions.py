"""Submission decisions and the acceptance-time speaker checklist."""

from __future__ import annotations

import pytest

from services.onboarding import CANONICAL_TASKS
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

SESSION_ID = "99999999-9999-9999-9999-9999999999d1"
FOREIGN_SESSION_ID = "99999999-9999-9999-9999-9999999999ff"
SUBMITTER_ID = "22222222-2222-2222-2222-2222222222d1"
SPEAKER_ID = "22222222-2222-2222-2222-2222222222d2"
FOREIGN_CONTACT_ID = "22222222-2222-2222-2222-2222222222ff"


@pytest.fixture
def decision_db(seeded_db):
    seeded_db.seed(
        "contacts",
        {
            "id": SUBMITTER_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "ada@example.com",
            "first_name": "Ada",
            "last_name": "Lovelace",
        },
        {
            "id": SPEAKER_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "grace@example.com",
            "first_name": "Grace",
            "last_name": "Hopper",
        },
        {
            "id": FOREIGN_CONTACT_ID,
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "email": "foreign@example.com",
            "first_name": "Private",
            "last_name": "Speaker",
        },
    )
    seeded_db.seed(
        "sessions",
        {
            "id": SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Analytical Engines",
            "status": "pending",
            "submitter_contact_id": SUBMITTER_ID,
        },
        {
            "id": FOREIGN_SESSION_ID,
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "title": "A private proposal",
            "status": "pending",
            "submitter_contact_id": FOREIGN_CONTACT_ID,
        },
    )
    seeded_db.seed(
        "session_participants",
        {
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": SUBMITTER_ID,
            "role": "submitter",
            "is_primary": True,
        },
        {
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": SPEAKER_ID,
            "role": "speaker",
            "is_primary": False,
        },
        {
            "org_id": OTHER_ORG_ID,
            "session_id": FOREIGN_SESSION_ID,
            "contact_id": FOREIGN_CONTACT_ID,
            "role": "speaker",
            "is_primary": True,
        },
    )
    seeded_db.seed(
        "email_templates",
        {
            "id": "template-decline",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "key": "decline",
            "subject": "Update on {{session_title}} at {{event_name}}",
            "body_html": "<p>Hi {{first_name}}, thank you for your proposal.</p>",
        },
    )
    return seeded_db


@pytest.mark.asyncio
async def test_onboarding_is_idempotent_and_prefers_speakers(decision_db):
    from services.onboarding import provision_speaker_onboarding

    first_count = await provision_speaker_onboarding(TEST_ORG_ID, TEST_EVENT_ID, SESSION_ID)
    second_count = await provision_speaker_onboarding(TEST_ORG_ID, TEST_EVENT_ID, SESSION_ID)

    assert first_count == 6
    assert second_count == 0
    assert len(decision_db.rows("portals")) == 1
    assert len(decision_db.rows("tasks")) == 6
    assert {task["name"] for task in decision_db.rows("tasks")} == {
        task["name"] for task in CANONICAL_TASKS
    }
    assignments = decision_db.rows("task_assignments")
    assert len(assignments) == 6
    assert {assignment["contact_id"] for assignment in assignments} == {SPEAKER_ID}
    assert {assignment["status"] for assignment in assignments} == {"todo"}


@pytest.mark.asyncio
async def test_onboarding_falls_back_to_submitter(decision_db):
    from services.onboarding import provision_speaker_onboarding

    decision_db.rows("session_participants")[:] = [
        row
        for row in decision_db.rows("session_participants")
        if row.get("role") != "speaker" or row.get("org_id") != TEST_ORG_ID
    ]

    created = await provision_speaker_onboarding(TEST_ORG_ID, TEST_EVENT_ID, SESSION_ID)

    assert created == 6
    assert {row["contact_id"] for row in decision_db.rows("task_assignments")} == {SUBMITTER_ID}


@pytest.mark.parametrize(
    ("decision", "expected_status", "expected_assignments"),
    [
        ("approve", "accepted", 6),
        ("maybe", "accept_queue", 0),
        ("deny", "declined", 0),
    ],
)
def test_decision_maps_status_and_approve_provisions(
    client,
    auth_headers,
    decision_db,
    decision,
    expected_status,
    expected_assignments,
):
    response = client.post(
        f"/api/sessions/{SESSION_ID}/decision",
        headers=auth_headers,
        json={"decision": decision},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["session"]["status"] == expected_status
    assert body["onboarding"]["tasks_assigned"] == expected_assignments
    assert body["emailed"] is False
    assert len(decision_db.rows("tasks")) == (6 if decision == "approve" else 0)


def test_decision_is_org_scoped(client, auth_headers, decision_db):
    response = client.post(
        f"/api/sessions/{FOREIGN_SESSION_ID}/decision",
        headers=auth_headers,
        json={"decision": "approve"},
    )

    assert response.status_code == 404
    foreign = next(
        row for row in decision_db.rows("sessions") if row["id"] == FOREIGN_SESSION_ID
    )
    assert foreign["status"] == "pending"
    assert decision_db.rows("tasks") == []


def test_existing_status_patch_still_works(client, auth_headers, decision_db):
    response = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=auth_headers,
        json={"status": "decline_queue"},
    )

    assert response.status_code == 200
    assert response.json()["session"]["status"] == "decline_queue"
    assert decision_db.rows("tasks") == []


def test_feedback_email_is_delivered_and_recorded(
    client,
    auth_headers,
    decision_db,
    monkeypatch,
):
    from routes import admin_routes

    deliveries: list[dict] = []

    async def deliver(**kwargs):
        deliveries.append(kwargs)
        return {"dev": True, "provider": "test", "to": kwargs["to"]}

    monkeypatch.setattr(admin_routes.mailer, "send_email", deliver)
    response = client.post(
        f"/api/sessions/{SESSION_ID}/decision",
        headers=auth_headers,
        json={
            "decision": "deny",
            "feedback": "Please make the examples more concrete.\nKeep <drafts> private.",
            "email_speaker": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["emailed"] is True
    assert {delivery["to"] for delivery in deliveries} == {
        "ada@example.com",
        "grace@example.com",
    }
    outbox = decision_db.rows("email_outbox")
    assert len(outbox) == 2
    assert {row["contact_id"] for row in outbox} == {SUBMITTER_ID, SPEAKER_ID}
    assert {row["template_key"] for row in outbox} == {"decline"}
    assert {row["status"] for row in outbox} == {"sent"}
    assert all("Please make the examples more concrete." in row["payload"]["body_html"] for row in outbox)
    assert all("&lt;drafts&gt;" in row["payload"]["body_html"] for row in outbox)


def test_demo_seed_imports_the_canonical_tasks():
    from scripts.seed_demo import build_tasks

    seeded = build_tasks()
    assert [(task["name"], task["kind"]) for task in seeded] == [
        (task["name"], task["kind"]) for task in CANONICAL_TASKS
    ]
