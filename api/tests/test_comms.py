"""Communications center: merge tags, scoped audiences, sends, and templates."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID
from tests.fakes import FakeSupabase


@pytest.fixture
def comms_client(seeded_db: FakeSupabase, monkeypatch):
    import services.comms as comms_service
    from auth import get_current_user_and_org
    from routes.comms_routes import router

    monkeypatch.setattr(comms_service, "supabase", seeded_db)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user_and_org] = lambda: ("organizer", TEST_ORG_ID)
    with TestClient(app) as client:
        yield client, seeded_db


def seed_recipient_data(fake: FakeSupabase) -> None:
    fake.seed(
        "contacts",
        {
            "id": "contact-ada",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "ada@example.com",
            "first_name": "Ada",
            "last_name": "Lovelace",
        },
        {
            "id": "contact-grace",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "grace@example.com",
            "first_name": "Grace",
            "last_name": "Hopper",
        },
        {
            "id": "contact-katherine",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "katherine@example.com",
            "first_name": "Katherine",
            "last_name": "Johnson",
        },
        {
            "id": "contact-mae",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "mae@example.com",
            "first_name": "Mae",
            "last_name": "Jemison",
        },
    )
    fake.seed(
        "sessions",
        {
            "id": "session-accepted",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Analytical Engines",
            "status": "accepted",
            "created_at": "2026-01-01T00:00:00+00:00",
        },
        {
            "id": "session-declined",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Compiler Design",
            "status": "declined",
            "created_at": "2026-01-02T00:00:00+00:00",
        },
        {
            "id": "session-moderated",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Orbital Computation",
            "status": "accepted",
            "created_at": "2026-01-03T00:00:00+00:00",
        },
    )
    fake.seed(
        "session_participants",
        {
            "id": "participant-ada",
            "org_id": TEST_ORG_ID,
            "session_id": "session-accepted",
            "contact_id": "contact-ada",
            "role": "speaker",
        },
        # The same contact on another matching session must still receive one email.
        {
            "id": "participant-ada-two",
            "org_id": TEST_ORG_ID,
            "session_id": "session-moderated",
            "contact_id": "contact-ada",
            "role": "speaker",
        },
        {
            "id": "participant-grace",
            "org_id": TEST_ORG_ID,
            "session_id": "session-declined",
            "contact_id": "contact-grace",
            "role": "speaker",
        },
        {
            "id": "participant-katherine",
            "org_id": TEST_ORG_ID,
            "session_id": "session-moderated",
            "contact_id": "contact-katherine",
            "role": "moderator",
        },
        {
            "id": "participant-foreign",
            "org_id": OTHER_ORG_ID,
            "session_id": "session-accepted",
            "contact_id": "contact-katherine",
            "role": "speaker",
        },
    )


def test_render_template_replaces_known_tags_and_leaves_unknown_ones():
    from services.comms import render_template

    context = {
        "first_name": "Ada",
        "last_name": "Lovelace",
        "full_name": "Ada Lovelace",
        "email": "ada@example.com",
        "event_name": "AI Builders Summit",
        "session_title": "Analytical Engines",
    }
    rendered = render_template(
        "Hi {{ first_name }} {{last_name}} — {{session_title}} at {{event_name}}. "
        "Reply to {{email}}; keep {{portal_url}}.",
        context,
    )

    assert rendered == (
        "Hi Ada Lovelace — Analytical Engines at AI Builders Summit. "
        "Reply to ada@example.com; keep {{portal_url}}."
    )


def test_templates_seed_defaults_and_post_upserts(comms_client):
    client, fake = comms_client

    response = client.get(f"/api/events/{TEST_EVENT_ID}/email-templates")
    assert response.status_code == 200
    assert {row["key"] for row in response.json()["templates"]} == {
        "accept",
        "decline",
        "reminder",
        "portal_invite",
    }

    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/email-templates",
        json={"key": "accept", "subject": "Welcome, {{first_name}}", "body_html": "<p>Yes.</p>"},
    )
    assert response.status_code == 200
    assert response.json()["template"]["subject"] == "Welcome, {{first_name}}"
    own_templates = [
        row
        for row in fake.rows("email_templates")
        if row["org_id"] == TEST_ORG_ID and row["event_id"] == TEST_EVENT_ID
    ]
    assert len(own_templates) == 4


@pytest.mark.asyncio
async def test_recipient_resolution_filters_role_and_session_status(seeded_db, monkeypatch):
    import services.comms as comms_service

    monkeypatch.setattr(comms_service, "supabase", seeded_db)
    seed_recipient_data(seeded_db)

    _event, recipients = await comms_service.resolve_recipients(
        TEST_EVENT_ID,
        TEST_ORG_ID,
        roles=["speaker"],
        statuses=["accepted"],
    )

    assert [row["id"] for row in recipients] == ["contact-ada"]
    assert recipients[0]["session_title"] == "Analytical Engines"


def test_all_roster_preview_includes_sessionless_contacts(comms_client):
    client, fake = comms_client
    seed_recipient_data(fake)

    response = client.get(
        f"/api/events/{TEST_EVENT_ID}/comms/recipients-preview?all_roster=true"
    )

    assert response.status_code == 200
    assert response.json()["count"] == 4
    assert {row["contact_id"] for row in response.json()["recipients"]} == {
        "contact-ada",
        "contact-grace",
        "contact-katherine",
        "contact-mae",
    }


def test_explicit_recipient_ids_are_the_exact_scoped_audience(
    comms_client, monkeypatch
):
    import services.comms as comms_service

    client, fake = comms_client
    seed_recipient_data(fake)
    delivered: list[str] = []

    async def capture_delivery(**kwargs):
        delivered.append(kwargs["to"])
        return {"id": "mail-test"}

    monkeypatch.setattr(comms_service.mailer, "send_email", capture_delivery)
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/comms/send",
        json={
            "subject": "Roster update",
            "body_html": "<p>Hello</p>",
            "audience": {
                "all_roster": True,
                "contact_ids": ["contact-mae", "contact-ada"],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert set(delivered) == {"mae@example.com", "ada@example.com"}
    assert {row["contact_id"] for row in fake.rows("email_outbox")} == {
        "contact-mae",
        "contact-ada",
    }

    fake.seed(
        "contacts",
        {
            "id": "contact-foreign-event",
            "org_id": TEST_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "email": "foreign-event@example.com",
        },
    )
    rejected = client.post(
        f"/api/events/{TEST_EVENT_ID}/comms/send",
        json={
            "subject": "Nope",
            "body_html": "<p>Nope</p>",
            "audience": {"contact_ids": ["contact-foreign-event"]},
        },
    )
    assert rejected.status_code == 400


def test_send_renders_dev_email_and_records_sent_outbox(comms_client, monkeypatch, tmp_path: Path):
    client, fake = comms_client
    seed_recipient_data(fake)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.setenv("OUTBOX_DIR", str(tmp_path))

    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/comms/send",
        json={
            "subject": "Hello {{full_name}} — {{event_name}}",
            "body_html": "<p>Your session is {{session_title}}.</p>",
            "audience": {"roles": ["speaker"], "statuses": ["accepted"]},
        },
    )

    assert response.status_code == 200
    assert response.json() == {"sent": 1, "failed": 0, "skipped": 0, "total": 1}
    outbox = fake.rows("email_outbox")
    assert len(outbox) == 1
    assert outbox[0]["org_id"] == TEST_ORG_ID
    assert outbox[0]["contact_id"] == "contact-ada"
    assert outbox[0]["template_key"] == "custom"
    assert outbox[0]["status"] == "sent"
    assert outbox[0]["attempts"] == 1
    assert outbox[0]["payload"]["subject"] == "Hello Ada Lovelace — AI Builders Summit"
    assert outbox[0]["payload"]["body_html"] == "<p>Your session is Analytical Engines.</p>"
    assert len(list(tmp_path.glob("*.eml"))) == 1


def test_send_failure_is_recorded_and_batch_continues(comms_client, monkeypatch):
    import services.comms as comms_service

    client, fake = comms_client
    seed_recipient_data(fake)

    async def fail_delivery(**_kwargs):
        raise RuntimeError("mailbox unavailable")

    monkeypatch.setattr(comms_service.mailer, "send_email", fail_delivery)
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/comms/send",
        json={
            "subject": "Update",
            "body_html": "<p>Details</p>",
            "audience": {"roles": ["moderator"], "statuses": ["accepted"]},
        },
    )

    assert response.json() == {"sent": 0, "failed": 1, "skipped": 0, "total": 1}
    assert fake.rows("email_outbox")[0]["status"] == "failed"
    assert fake.rows("email_outbox")[0]["last_error"] == "mailbox unavailable"
    assert fake.rows("email_outbox")[0]["sent_at"] is None


def test_foreign_event_and_template_are_indistinguishable_from_missing(comms_client):
    client, fake = comms_client
    fake.seed(
        "email_templates",
        {
            "id": "foreign-template",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "key": "private",
            "subject": "Private",
            "body_html": "<p>Private</p>",
        },
    )

    assert client.get(f"/api/events/{OTHER_EVENT_ID}/email-templates").status_code == 404
    assert client.patch(
        "/api/email-templates/foreign-template",
        json={"subject": "Probe"},
    ).status_code == 404
    assert fake.rows("email_templates")[0]["subject"] == "Private"


def test_log_only_returns_contacts_and_messages_from_the_event_org(comms_client):
    client, fake = comms_client
    fake.seed(
        "contacts",
        {
            "id": "contact-own",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Mae",
            "last_name": "Jemison",
            "email": "mae@example.com",
        },
    )
    fake.seed(
        "email_outbox",
        {
            "id": "outbox-own",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "contact_id": "contact-own",
            "template_key": "reminder",
            "payload": {"subject": "Speaker reminder", "to": "mae@example.com"},
            "status": "sent",
            "sent_at": "2026-08-08T12:00:00+00:00",
            "created_at": "2026-08-08T12:00:00+00:00",
        },
        {
            "id": "outbox-foreign",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "contact_id": "contact-own",
            "template_key": "private",
            "payload": {"subject": "Private"},
            "status": "sent",
            "created_at": "2026-08-09T12:00:00+00:00",
        },
    )

    response = client.get(f"/api/events/{TEST_EVENT_ID}/comms/log?limit=10")

    assert response.status_code == 200
    assert response.json()["log"] == [
        {
            **fake.rows("email_outbox")[0],
            "subject": "Speaker reminder",
            "recipient_name": "Mae Jemison",
            "recipient_email": "mae@example.com",
        }
    ]
