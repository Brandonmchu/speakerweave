"""The onboarding dashboard (requirement #6).

What matters here is the aggregation, not the plumbing: a speaker's task
progress has to come out of `task_assignments` correctly, `onboarding_complete`
has to mean what the UI badge claims it means, and none of it may see another
org's rows. The fake Supabase executes the real query chain, so a dropped
`.eq("org_id", …)` shows up as a foreign speaker in the payload.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

DASHBOARD_PATH = f"/api/events/{TEST_EVENT_ID}/dashboard"

S_ACCEPTED = "99999999-9999-9999-9999-9999999900a1"
S_PENDING = "99999999-9999-9999-9999-9999999900a2"
S_DRAFT = "99999999-9999-9999-9999-9999999900a3"
S_OTHER_ORG = "99999999-9999-9999-9999-9999999900ff"

ADA = "22222222-2222-2222-2222-2222222200a1"
GRACE = "22222222-2222-2222-2222-2222222200a2"
ALAN = "22222222-2222-2222-2222-2222222200a3"
KATHERINE = "22222222-2222-2222-2222-2222222200a4"
FOREIGN = "22222222-2222-2222-2222-2222222200ff"

T_BIO = "33333333-3333-3333-3333-3333333300a1"
T_HEADSHOT = "33333333-3333-3333-3333-3333333300a2"
T_SLIDES = "33333333-3333-3333-3333-3333333300a3"


@pytest.fixture(autouse=True)
def _mount_dashboard_router():
    """Mount the dashboard router on the app under test.

    main.py is wired by hand outside this change, so the router is attached
    here if it isn't already. Once `main.py` includes it the check short-
    circuits and these tests exercise the real app untouched.
    """
    from main import app
    from routes.dashboard_routes import router

    if not any(getattr(r, "path", "") == "/api/events/{event_id}/dashboard" for r in app.routes):
        app.include_router(router)
    yield


@pytest.fixture
def dashboard_db(seeded_db):
    """One event, four speakers at four different stages of onboarding.

    Ada  — portal visited, both tasks done            → onboarded
    Grace— portal visited, 1 of 3 done                → 2 outstanding
    Alan — never opened the portal, his one task done → not onboarded
    Kath — on a session, no tasks assigned yet        → not started
    """
    db = seeded_db
    db.seed(
        "sessions",
        {"id": S_ACCEPTED, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "status": "accepted"},
        {"id": S_PENDING, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "status": "pending"},
        {"id": S_DRAFT, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "status": "draft"},
    )
    db.seed(
        "session_participants",
        {"org_id": TEST_ORG_ID, "session_id": S_ACCEPTED, "contact_id": ADA, "role": "speaker"},
        # Same person, same session, two roles — one session, not two.
        {"org_id": TEST_ORG_ID, "session_id": S_ACCEPTED, "contact_id": ADA, "role": "submitter"},
        {"org_id": TEST_ORG_ID, "session_id": S_PENDING, "contact_id": ADA, "role": "speaker"},
        {"org_id": TEST_ORG_ID, "session_id": S_ACCEPTED, "contact_id": GRACE, "role": "speaker"},
        {"org_id": TEST_ORG_ID, "session_id": S_PENDING, "contact_id": ALAN, "role": "submitter"},
        {"org_id": TEST_ORG_ID, "session_id": S_DRAFT, "contact_id": KATHERINE, "role": "speaker"},
    )
    db.seed(
        "contacts",
        {
            "id": ADA,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Ada",
            "last_name": "Lovelace",
            "email": "ada@example.com",
            "last_portal_access_at": "2026-08-01T10:00:00+00:00",
        },
        {
            "id": GRACE,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Grace",
            "last_name": "Hopper",
            "email": "grace@example.com",
            "last_portal_access_at": "2026-08-02T09:00:00+00:00",
        },
        {
            "id": ALAN,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Alan",
            "last_name": "Turing",
            "email": "alan@example.com",
            "last_portal_access_at": None,
        },
        {
            "id": KATHERINE,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Katherine",
            "last_name": "Johnson",
            "email": "katherine@example.com",
            "last_portal_access_at": "2026-08-03T08:00:00+00:00",
        },
    )
    db.seed(
        "tasks",
        {
            "id": T_BIO,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Speaker bio",
            "kind": "todo",
        },
        {
            "id": T_HEADSHOT,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Headshot",
            "kind": "file_request",
        },
        {
            "id": T_SLIDES,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Slides",
            "kind": "file_request",
        },
    )
    db.seed(
        "task_assignments",
        {"org_id": TEST_ORG_ID, "task_id": T_BIO, "contact_id": ADA, "status": "done"},
        {"org_id": TEST_ORG_ID, "task_id": T_HEADSHOT, "contact_id": ADA, "status": "approved"},
        {"org_id": TEST_ORG_ID, "task_id": T_BIO, "contact_id": GRACE, "status": "done"},
        # Awaiting an organizer's approval — still outstanding.
        {"org_id": TEST_ORG_ID, "task_id": T_HEADSHOT, "contact_id": GRACE, "status": "submitted"},
        {"org_id": TEST_ORG_ID, "task_id": T_SLIDES, "contact_id": GRACE, "status": "todo"},
        {"org_id": TEST_ORG_ID, "task_id": T_BIO, "contact_id": ALAN, "status": "done"},
    )
    return db


def speakers_by_email(payload: dict) -> dict[str, dict]:
    return {s["email"]: s for s in payload["speakers"]}


# ── auth & scoping ──────────────────────────────────────────────────────────


def test_dashboard_requires_auth(client):
    assert client.get(DASHBOARD_PATH).status_code == 401


def test_dashboard_404s_for_an_unknown_event(client, auth_headers, seeded_db):
    missing = "11111111-1111-1111-1111-1111111100aa"
    assert client.get(f"/api/events/{missing}/dashboard", headers=auth_headers).status_code == 404


def test_dashboard_404s_for_another_orgs_event(client, auth_headers, seeded_db):
    """A foreign event is indistinguishable from one that doesn't exist."""
    response = client.get(f"/api/events/{OTHER_EVENT_ID}/dashboard", headers=auth_headers)
    assert response.status_code == 404


def test_dashboard_ignores_another_orgs_rows(client, auth_headers, dashboard_db):
    """Every query carries the org predicate — nothing foreign leaks in."""
    dashboard_db.seed(
        "sessions",
        {
            "id": S_OTHER_ORG,
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "status": "accepted",
        },
    )
    dashboard_db.seed(
        "session_participants",
        {
            "org_id": OTHER_ORG_ID,
            "session_id": S_OTHER_ORG,
            "contact_id": FOREIGN,
            "role": "speaker",
        },
        # A foreign participant row pointing at one of OUR sessions: the
        # org predicate on session_participants is the only thing keeping it out.
        {
            "org_id": OTHER_ORG_ID,
            "session_id": S_ACCEPTED,
            "contact_id": FOREIGN,
            "role": "speaker",
        },
    )
    dashboard_db.seed(
        "contacts",
        {
            "id": FOREIGN,
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Someone",
            "last_name": "Else",
            "email": "intruder@example.com",
        },
    )
    dashboard_db.seed(
        "task_assignments",
        {"org_id": OTHER_ORG_ID, "task_id": T_BIO, "contact_id": FOREIGN, "status": "todo"},
    )

    payload = client.get(DASHBOARD_PATH, headers=auth_headers).json()

    assert "intruder@example.com" not in speakers_by_email(payload)
    assert payload["totals"]["speakers"] == 4
    # The foreign session must not inflate the funnel either.
    assert payload["submission_funnel"]["accepted"] == 1
    assert payload["submission_funnel"]["total"] == 3


# ── shape ───────────────────────────────────────────────────────────────────


def test_dashboard_submission_funnel(client, auth_headers, dashboard_db):
    funnel = client.get(DASHBOARD_PATH, headers=auth_headers).json()["submission_funnel"]

    assert funnel["pending"] == 1
    assert funnel["accepted"] == 1
    assert funnel["accept_queue"] == 0
    assert funnel["decline_queue"] == 0
    assert funnel["declined"] == 0
    assert funnel["withdrawn"] == 0
    # Drafts have no queue of their own but are still sessions on the event.
    assert funnel["total"] == 3


def test_dashboard_speaker_aggregates(client, auth_headers, dashboard_db):
    payload = client.get(DASHBOARD_PATH, headers=auth_headers).json()
    speakers = speakers_by_email(payload)

    ada = speakers["ada@example.com"]
    assert ada["name"] == "Ada Lovelace"
    assert ada["contact_id"] == ADA
    # Two roles on one session plus a second session = 2, not 3.
    assert ada["session_count"] == 2
    assert ada["status_summary"] == {"accepted": 1, "pending": 1}
    assert (ada["tasks_total"], ada["tasks_done"], ada["tasks_outstanding"]) == (2, 2, 0)
    assert ada["last_portal_access_at"] == "2026-08-01T10:00:00+00:00"

    grace = speakers["grace@example.com"]
    # `submitted` is waiting on the organizer and `todo` hasn't started —
    # both still count as outstanding.
    assert (grace["tasks_total"], grace["tasks_done"], grace["tasks_outstanding"]) == (3, 1, 2)


def test_dashboard_totals(client, auth_headers, dashboard_db):
    totals = client.get(DASHBOARD_PATH, headers=auth_headers).json()["totals"]

    assert totals["speakers"] == 4
    assert totals["onboarded"] == 1  # Ada only
    assert totals["outstanding_tasks"] == 2  # Grace's two


def test_dashboard_sorts_outstanding_first(client, auth_headers, dashboard_db):
    """The chase list: work owed at the top, people already done at the bottom."""
    payload = client.get(DASHBOARD_PATH, headers=auth_headers).json()
    order = [s["email"] for s in payload["speakers"]]

    assert order[0] == "grace@example.com"
    assert order[-1] == "ada@example.com"


def test_dashboard_reports_the_last_email(client, auth_headers, dashboard_db):
    dashboard_db.seed(
        "email_outbox",
        {
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "contact_id": ADA,
            "template_key": "submission_received",
            "status": "sent",
            "sent_at": "2026-07-01T12:00:00+00:00",
        },
        {
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "contact_id": ADA,
            "template_key": "acceptance",
            "status": "sent",
            "sent_at": "2026-07-20T12:00:00+00:00",
        },
        {
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "contact_id": ADA,
            "template_key": "leaked",
            "status": "sent",
            "sent_at": "2026-07-30T12:00:00+00:00",
        },
    )

    speakers = speakers_by_email(client.get(DASHBOARD_PATH, headers=auth_headers).json())

    assert speakers["ada@example.com"]["last_email"] == {
        "template_key": "acceptance",
        "status": "sent",
        "sent_at": "2026-07-20T12:00:00+00:00",
        "last_error": None,
    }
    assert speakers["grace@example.com"]["last_email"] is None


def test_dashboard_reports_the_last_email_suppression_reason(
    client, auth_headers, dashboard_db
):
    dashboard_db.seed(
        "email_outbox",
        {
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "contact_id": GRACE,
            "template_key": "portal_invite",
            "status": "cancelled",
            "last_error": "demo address — delivery suppressed",
            "created_at": "2026-07-20T12:00:00+00:00",
        },
    )

    speakers = speakers_by_email(client.get(DASHBOARD_PATH, headers=auth_headers).json())

    assert speakers["grace@example.com"]["last_email"]["status"] == "cancelled"
    assert (
        speakers["grace@example.com"]["last_email"]["last_error"]
        == "demo address — delivery suppressed"
    )


def test_dashboard_is_empty_before_anyone_submits(client, auth_headers, seeded_db):
    payload = client.get(DASHBOARD_PATH, headers=auth_headers).json()

    assert payload["speakers"] == []
    assert payload["totals"] == {"speakers": 0, "onboarded": 0, "outstanding_tasks": 0}
    assert payload["submission_funnel"]["total"] == 0


# ── the onboarding_complete rule ────────────────────────────────────────────


def test_onboarding_complete_needs_a_portal_visit_and_zero_outstanding(
    client, auth_headers, dashboard_db
):
    speakers = speakers_by_email(client.get(DASHBOARD_PATH, headers=auth_headers).json())

    # Visited the portal, every assigned task finished.
    assert speakers["ada@example.com"]["onboarding_complete"] is True
    # Visited, but two tasks still owed.
    assert speakers["grace@example.com"]["onboarding_complete"] is False
    # Task done, but never opened the portal — we can't call that onboarded.
    assert speakers["alan@example.com"]["onboarding_complete"] is False
    # Visited, but nothing has been assigned yet: not started, not complete.
    assert speakers["katherine@example.com"]["onboarding_complete"] is False
    assert speakers["katherine@example.com"]["tasks_total"] == 0


def test_denied_task_keeps_a_speaker_outstanding(client, auth_headers, dashboard_db):
    """A denied upload has to be redone, so it is not progress."""
    for row in dashboard_db.rows("task_assignments"):
        if row["contact_id"] == ADA and row["task_id"] == T_HEADSHOT:
            row["status"] = "denied"

    ada = speakers_by_email(client.get(DASHBOARD_PATH, headers=auth_headers).json())[
        "ada@example.com"
    ]

    assert ada["tasks_done"] == 1
    assert ada["tasks_outstanding"] == 1
    assert ada["onboarding_complete"] is False


def test_dashboard_ignores_tasks_from_another_event(client, auth_headers, dashboard_db):
    """Task counts are scoped to the event whose dashboard this is."""
    other_task = "33333333-3333-3333-3333-3333333300ff"
    dashboard_db.seed(
        "tasks",
        {
            "id": other_task,
            "org_id": TEST_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "name": "Someone else's task",
        },
    )
    dashboard_db.seed(
        "task_assignments",
        {"org_id": TEST_ORG_ID, "task_id": other_task, "contact_id": ADA, "status": "todo"},
    )

    ada = speakers_by_email(client.get(DASHBOARD_PATH, headers=auth_headers).json())[
        "ada@example.com"
    ]

    assert ada["tasks_total"] == 2
    assert ada["onboarding_complete"] is True


def test_dashboard_counts_only_speaking_roles(client, auth_headers, dashboard_db):
    """A chairperson runs the room; they don't owe a headshot."""
    chair = "22222222-2222-2222-2222-2222222200c1"
    dashboard_db.seed(
        "session_participants",
        {
            "org_id": TEST_ORG_ID,
            "session_id": S_ACCEPTED,
            "contact_id": chair,
            "role": "chairperson",
        },
    )
    dashboard_db.seed(
        "contacts",
        {
            "id": chair,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Chair",
            "last_name": "Person",
            "email": "chair@example.com",
        },
    )

    payload = client.get(DASHBOARD_PATH, headers=auth_headers).json()

    assert "chair@example.com" not in speakers_by_email(payload)
    assert payload["totals"]["speakers"] == 4
