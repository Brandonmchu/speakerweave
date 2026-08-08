"""Organizer side of the portal: speaker roster, invites, task authoring, review.

The aggregation has to be correct and org-safe (a foreign speaker must never
appear), an invite has to both mint a portal link and enqueue the email, task
authoring must refuse contacts outside the event, and a review must move the
assignment AND queue the speaker's notification — the deny-notifies behaviour
that Sessionboard lacks.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

ADA = "22222222-2222-2222-2222-2222222200a1"
BEN = "22222222-2222-2222-2222-2222222200a2"
FOREIGN = "22222222-2222-2222-2222-2222222200ff"

SESSION_A = "99999999-9999-9999-9999-9999999900a1"
SESSION_B = "99999999-9999-9999-9999-9999999900a2"

T_FILE = "33333333-3333-3333-3333-3333333300a2"
ASSIGN_ADA_FILE = "44444444-4444-4444-4444-4444444400a2"


@pytest.fixture(autouse=True)
def _mount_admin_router():
    from main import app
    from routes.portal_admin_routes import router

    if not any(getattr(r, "path", "") == "/api/events/{event_id}/speakers" for r in app.routes):
        app.include_router(router)
    yield


@pytest.fixture
def admin_db(seeded_db):
    db = seeded_db
    db.seed(
        "contacts",
        {"id": ADA, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com", "last_portal_access_at": "2026-08-01T00:00:00+00:00"},
        {"id": BEN, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "first_name": "Ben", "last_name": "Franklin", "email": "ben@example.com"},
        {"id": FOREIGN, "org_id": OTHER_ORG_ID, "event_id": OTHER_EVENT_ID, "first_name": "Foreign", "last_name": "Speaker", "email": "foreign@example.com"},
    )
    db.seed(
        "sessions",
        {"id": SESSION_A, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "status": "accepted"},
        {"id": SESSION_B, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "status": "pending"},
    )
    db.seed(
        "session_participants",
        {"org_id": TEST_ORG_ID, "session_id": SESSION_A, "contact_id": ADA, "role": "speaker"},
        {"org_id": TEST_ORG_ID, "session_id": SESSION_B, "contact_id": ADA, "role": "speaker"},
        {"org_id": TEST_ORG_ID, "session_id": SESSION_A, "contact_id": BEN, "role": "submitter"},
    )
    db.seed(
        "tasks",
        {"id": T_FILE, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "kind": "file_request", "name": "Upload slides"},
    )
    db.seed(
        "task_assignments",
        {"id": ASSIGN_ADA_FILE, "org_id": TEST_ORG_ID, "task_id": T_FILE, "contact_id": ADA, "status": "submitted"},
        {"org_id": TEST_ORG_ID, "task_id": T_FILE, "contact_id": BEN, "status": "todo"},
    )
    # Ada was already invited; Ben was not.
    db.seed(
        "magic_link_tokens",
        {"org_id": TEST_ORG_ID, "purpose": "portal", "contact_id": ADA, "token_hash": "seed", "expires_at": "2027-01-01T00:00:00+00:00"},
    )
    return db


# ── speaker roster ──────────────────────────────────────────────────────────


def test_speakers_aggregation(client, auth_headers, admin_db):
    resp = client.get(f"/api/events/{TEST_EVENT_ID}/speakers", headers=auth_headers)
    assert resp.status_code == 200
    speakers = {s["contact_id"]: s for s in resp.json()["speakers"]}

    assert set(speakers) == {ADA, BEN}  # no foreign speaker
    ada = speakers[ADA]
    assert ada["session_count"] == 2
    assert ada["tasks_total"] == 1
    assert ada["tasks_done"] == 0  # 'submitted' is not done
    assert ada["tasks_outstanding"] == 1
    assert ada["invited"] is True
    assert ada["last_portal_access_at"]

    ben = speakers[BEN]
    assert ben["session_count"] == 1
    assert ben["invited"] is False


def test_speakers_requires_matching_org(client, auth_headers, admin_db):
    resp = client.get(f"/api/events/{OTHER_EVENT_ID}/speakers", headers=auth_headers)
    assert resp.status_code == 404


# ── portal invite ───────────────────────────────────────────────────────────


def test_portal_invite_mints_link_and_queues_email(client, auth_headers, admin_db):
    resp = client.post(f"/api/contacts/{BEN}/portal-invite", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # a fresh portal token was minted for Ben
    tokens = [
        t for t in admin_db.rows("magic_link_tokens")
        if t.get("contact_id") == BEN and t.get("purpose") == "portal"
    ]
    assert len(tokens) == 1

    # and the invite is sitting in the outbox with the portal link in its body
    queued = [e for e in admin_db.rows("email_outbox") if e.get("contact_id") == BEN]
    assert len(queued) == 1
    assert queued[0]["template_key"] == "portal_invite"
    assert queued[0]["status"] == "queued"
    assert "AI Builders Summit" in queued[0]["payload"]["subject"]
    assert "/portal/" in queued[0]["payload"]["html"]


def test_portal_invite_rejects_foreign_contact(client, auth_headers, admin_db):
    assert client.post(f"/api/contacts/{FOREIGN}/portal-invite", headers=auth_headers).status_code == 404


# ── task authoring ──────────────────────────────────────────────────────────


def test_create_task_assigns_only_valid_contacts(client, auth_headers, admin_db):
    resp = client.post(
        f"/api/events/{TEST_EVENT_ID}/tasks",
        headers=auth_headers,
        json={
            "name": "Sign the speaker agreement",
            "kind": "todo",
            "required": True,
            "contact_ids": [ADA, BEN, FOREIGN],
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["assignments_created"] == 2  # FOREIGN filtered out

    task_id = body["task"]["id"]
    created = [a for a in admin_db.rows("task_assignments") if a.get("task_id") == task_id]
    assert {a["contact_id"] for a in created} == {ADA, BEN}
    assert all(a["status"] == "todo" for a in created)


def test_create_task_rejects_unknown_kind(client, auth_headers, admin_db):
    resp = client.post(
        f"/api/events/{TEST_EVENT_ID}/tasks",
        headers=auth_headers,
        json={"name": "Bad", "kind": "wormhole", "contact_ids": []},
    )
    assert resp.status_code == 400


# ── file review ─────────────────────────────────────────────────────────────


def test_review_approved_notifies(client, auth_headers, admin_db):
    resp = client.patch(
        f"/api/task-assignments/{ASSIGN_ADA_FILE}/review",
        headers=auth_headers,
        json={"decision": "approved"},
    )
    assert resp.status_code == 200
    assert resp.json()["assignment"]["status"] == "approved"

    emails = [e for e in admin_db.rows("email_outbox") if e.get("template_key") == "task_approved"]
    assert len(emails) == 1
    assert emails[0]["contact_id"] == ADA


def test_review_denied_notifies_and_allows_resubmit(client, auth_headers, admin_db):
    resp = client.patch(
        f"/api/task-assignments/{ASSIGN_ADA_FILE}/review",
        headers=auth_headers,
        json={"decision": "denied"},
    )
    assert resp.status_code == 200
    assert resp.json()["assignment"]["status"] == "denied"

    # This is the notify-on-deny that Sessionboard lacks.
    emails = [e for e in admin_db.rows("email_outbox") if e.get("template_key") == "task_denied"]
    assert len(emails) == 1
    row = next(a for a in admin_db.rows("task_assignments") if a["id"] == ASSIGN_ADA_FILE)
    assert row["status"] == "denied"  # re-submittable, not locked


def test_review_rejects_bad_decision(client, auth_headers, admin_db):
    resp = client.patch(
        f"/api/task-assignments/{ASSIGN_ADA_FILE}/review",
        headers=auth_headers,
        json={"decision": "maybe"},
    )
    assert resp.status_code == 400
