"""Public speaker-portal routes (requirement #2).

What matters is the scoping and the flows: the cookie's ``(org_id, contact_id)``
is the only authority, one speaker can never touch another's row, a headshot /
task file is validated before it is stored, and a completed todo lands as
``done``. The fake Supabase runs the real query chain, so a dropped
``.eq("contact_id", …)`` shows up as a foreign row leaking into the response.
"""

from __future__ import annotations

import pytest

from routes.portal_session_routes import COOKIE_NAME
from services.magic_links import issue_session
from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

ADA = "22222222-2222-2222-2222-2222222200a1"
BEN = "22222222-2222-2222-2222-2222222200a2"
FOREIGN = "22222222-2222-2222-2222-2222222200ff"

SESSION_A = "99999999-9999-9999-9999-9999999900a1"

T_TODO = "33333333-3333-3333-3333-3333333300a1"
T_FILE = "33333333-3333-3333-3333-3333333300a2"

ASSIGN_ADA_TODO = "44444444-4444-4444-4444-4444444400a1"
ASSIGN_ADA_FILE = "44444444-4444-4444-4444-4444444400a2"
ASSIGN_BEN_TODO = "44444444-4444-4444-4444-4444444400b1"


@pytest.fixture(autouse=True)
def _mount_portal_routers():
    """Attach the portal routers to the app under test (main.py is wired by hand
    outside this change; the check short-circuits once it is)."""
    from main import app
    from routes.portal_routes import router

    if not any(getattr(r, "path", "") == "/public/portal/me" for r in app.routes):
        app.include_router(router)
    yield


@pytest.fixture
def portal_db(seeded_db):
    db = seeded_db
    db.seed(
        "contacts",
        {
            "id": ADA,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Ada",
            "last_name": "Lovelace",
            "email": "ada@example.com",
            "about": "",
        },
        {
            "id": BEN,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Ben",
            "last_name": "Franklin",
            "email": "ben@example.com",
        },
        {
            "id": FOREIGN,
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Foreign",
            "last_name": "Speaker",
            "email": "foreign@example.com",
        },
    )
    db.seed(
        "sessions",
        {
            "id": SESSION_A,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Intro to Analytical Engines",
            "status": "accepted",
            "friendly_id": "SESS-1",
        },
    )
    db.seed(
        "session_participants",
        {"org_id": TEST_ORG_ID, "session_id": SESSION_A, "contact_id": ADA, "role": "speaker", "is_primary": True},
    )
    db.seed(
        "portals",
        {
            "id": "55555555-5555-5555-5555-555555550001",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Speakers",
            "welcome_html": "<p>Welcome!</p><script>alert(1)</script>",
            "accent_color": "#4962E2",
        },
    )
    db.seed(
        "tasks",
        {"id": T_TODO, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "kind": "todo", "name": "Confirm bio", "order": 0},
        {"id": T_FILE, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "kind": "file_request", "name": "Upload slides", "order": 1},
    )
    db.seed(
        "task_assignments",
        {"id": ASSIGN_ADA_TODO, "org_id": TEST_ORG_ID, "task_id": T_TODO, "contact_id": ADA, "status": "todo"},
        {"id": ASSIGN_ADA_FILE, "org_id": TEST_ORG_ID, "task_id": T_FILE, "contact_id": ADA, "status": "todo"},
        {"id": ASSIGN_BEN_TODO, "org_id": TEST_ORG_ID, "task_id": T_TODO, "contact_id": BEN, "status": "todo"},
    )
    return db


def _cookie(contact_id: str, org_id: str = TEST_ORG_ID) -> dict[str, str]:
    token = issue_session("portal", org_id, contact_id=contact_id)
    return {"Cookie": f"{COOKIE_NAME}={token}"}


# ── GET /me ─────────────────────────────────────────────────────────────────


def test_me_returns_profile_sessions_tasks_and_stamps_access(client, portal_db):
    resp = client.get("/public/portal/me", headers=_cookie(ADA))
    assert resp.status_code == 200
    body = resp.json()

    assert body["contact"]["email"] == "ada@example.com"
    assert body["event"]["name"] == "AI Builders Summit"
    # welcome_html is sanitized on the way out — the <script> is gone.
    assert "<script>" not in body["portal"]["welcome_html"]
    assert "Welcome!" in body["portal"]["welcome_html"]

    assert [s["title"] for s in body["sessions"]] == ["Intro to Analytical Engines"]
    assert body["sessions"][0]["role"] == "speaker"

    tasks = {t["task"]["name"]: t for t in body["tasks"]}
    assert set(tasks) == {"Confirm bio", "Upload slides"}
    assert tasks["Confirm bio"]["task"]["kind"] == "todo"
    assert tasks["Upload slides"]["file"] is None

    # last_portal_access_at is stamped as a side effect of the call.
    ada = next(c for c in portal_db.rows("contacts") if c["id"] == ADA)
    assert ada.get("last_portal_access_at")


def test_me_only_sees_own_tasks(client, portal_db):
    body = client.get("/public/portal/me", headers=_cookie(BEN)).json()
    # Ben has only the todo assignment — never sees Ada's file task.
    assert [t["task"]["name"] for t in body["tasks"]] == ["Confirm bio"]
    assert body["sessions"] == []


def test_me_is_scoped_to_org(client, portal_db):
    # A cookie claiming the foreign speaker under THIS org resolves to nobody.
    resp = client.get("/public/portal/me", headers=_cookie(FOREIGN, org_id=TEST_ORG_ID))
    assert resp.status_code == 404


def test_me_without_cookie_is_401(client, portal_db):
    assert client.get("/public/portal/me").status_code == 401


# ── PATCH /profile ──────────────────────────────────────────────────────────


def test_profile_update_is_scoped_and_sanitizes_bio(client, portal_db):
    resp = client.patch(
        "/public/portal/profile",
        headers=_cookie(ADA),
        json={
            "title": "  Mathematician  ",
            "about": "<b>Pioneer</b><script>steal()</script>",
            "company_name": "Analytical Co",
        },
    )
    assert resp.status_code == 200
    contact = resp.json()["contact"]
    assert contact["title"] == "Mathematician"  # trimmed
    assert "<script>" not in contact["about"]
    assert "Pioneer" in contact["about"]

    # Ben's row is untouched — the write was scoped to Ada's contact_id.
    ben = next(c for c in portal_db.rows("contacts") if c["id"] == BEN)
    assert ben.get("title") in (None, "")


def test_profile_update_rejects_empty_patch(client, portal_db):
    resp = client.patch("/public/portal/profile", headers=_cookie(ADA), json={})
    assert resp.status_code == 400


# ── POST /tasks/{id}/complete ───────────────────────────────────────────────


def test_complete_todo_marks_done(client, portal_db):
    resp = client.post(f"/public/portal/tasks/{ASSIGN_ADA_TODO}/complete", headers=_cookie(ADA))
    assert resp.status_code == 200
    assert resp.json()["status"] == "done"

    row = next(a for a in portal_db.rows("task_assignments") if a["id"] == ASSIGN_ADA_TODO)
    assert row["status"] == "done"
    assert row["completed_at"]


def test_cannot_complete_another_speakers_task(client, portal_db):
    # Ada's cookie against Ben's assignment: 404, and Ben's row is untouched.
    resp = client.post(f"/public/portal/tasks/{ASSIGN_BEN_TODO}/complete", headers=_cookie(ADA))
    assert resp.status_code == 404
    ben = next(a for a in portal_db.rows("task_assignments") if a["id"] == ASSIGN_BEN_TODO)
    assert ben["status"] == "todo"


def test_complete_rejects_a_file_request_task(client, portal_db):
    resp = client.post(f"/public/portal/tasks/{ASSIGN_ADA_FILE}/complete", headers=_cookie(ADA))
    assert resp.status_code == 400


# ── POST /tasks/{id}/upload ─────────────────────────────────────────────────


def test_upload_stores_file_and_submits_assignment(client, portal_db):
    resp = client.post(
        f"/public/portal/tasks/{ASSIGN_ADA_FILE}/upload",
        headers=_cookie(ADA),
        files={"file": ("slides.pdf", b"%PDF-1.5 fake slide deck bytes", "application/pdf")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "submitted"
    assert body["file"]["url"]

    assignment = next(a for a in portal_db.rows("task_assignments") if a["id"] == ASSIGN_ADA_FILE)
    assert assignment["status"] == "submitted"
    assert assignment["file_id"]
    files = [f for f in portal_db.rows("files") if f.get("task_assignment_id") == ASSIGN_ADA_FILE]
    assert len(files) == 1
    assert files[0]["filename"] == "slides.pdf"
    # the bytes actually reached the (fake) bucket
    assert portal_db.storage.uploads.get("portal-files")


def test_upload_rejects_content_that_does_not_match_extension(client, portal_db):
    resp = client.post(
        f"/public/portal/tasks/{ASSIGN_ADA_FILE}/upload",
        headers=_cookie(ADA),
        files={"file": ("slides.pdf", b"MZ this is actually an exe", "application/pdf")},
    )
    assert resp.status_code == 400
    assignment = next(a for a in portal_db.rows("task_assignments") if a["id"] == ASSIGN_ADA_FILE)
    assert assignment["status"] == "todo"  # unchanged


def test_upload_rejects_wrong_task_kind(client, portal_db):
    resp = client.post(
        f"/public/portal/tasks/{ASSIGN_ADA_TODO}/upload",
        headers=_cookie(ADA),
        files={"file": ("slides.pdf", b"%PDF-1.5 deck", "application/pdf")},
    )
    assert resp.status_code == 400


# ── POST /headshot ──────────────────────────────────────────────────────────


def test_headshot_validates_and_sets_photo_url(client, portal_db):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    resp = client.post(
        "/public/portal/headshot",
        headers=_cookie(ADA),
        files={"file": ("me.png", png, "image/png")},
    )
    assert resp.status_code == 200
    assert resp.json()["photo_url"]

    ada = next(c for c in portal_db.rows("contacts") if c["id"] == ADA)
    assert ada["photo_url"]


def test_headshot_rejects_a_pdf(client, portal_db):
    resp = client.post(
        "/public/portal/headshot",
        headers=_cookie(ADA),
        files={"file": ("deck.pdf", b"%PDF-1.5 not an image", "application/pdf")},
    )
    assert resp.status_code == 400
