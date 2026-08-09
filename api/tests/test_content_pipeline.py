"""Content-collection pipeline: versioning, comments, library, reminders, export.

The pipeline layers onto the portal's file-request tasks. What matters and is
tested here:

* **Versioning** — a re-upload keeps history (v1, v2 …); the portal shows the
  current version and the prior ones.
* **Comments** — scoped both ways: a speaker sees and replies to feedback on
  their own item only; an organizer sees their org's threads only.
* **Library** — the cross-speaker list is org-scoped and filterable by type +
  status, and knows who is outstanding.
* **Reminders** — one queued email per speaker missing required content.
* **Export** — bundles the right (current-version) files.
"""

from __future__ import annotations

import io
import zipfile

import pytest

from routes.portal_session_routes import COOKIE_NAME
from services.magic_links import issue_session
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

ADA = "22222222-2222-2222-2222-2222222200a1"
BEN = "22222222-2222-2222-2222-2222222200a2"

T_SLIDES = "33333333-3333-3333-3333-3333333300s1"
T_HEADSHOT = "33333333-3333-3333-3333-3333333300h1"
T_BIO = "33333333-3333-3333-3333-3333333300b1"
T_FOREIGN = "33333333-3333-3333-3333-3333333300ff"

A_ADA_SLIDES = "44444444-4444-4444-4444-4444444400s1"
A_ADA_HEADSHOT = "44444444-4444-4444-4444-4444444400h1"
A_BEN_SLIDES = "44444444-4444-4444-4444-4444444400s2"
A_BEN_BIO = "44444444-4444-4444-4444-4444444400b2"
A_FOREIGN = "44444444-4444-4444-4444-4444444400ff"

FILE_ADA_SLIDES = "66666666-6666-6666-6666-6666666600s1"


@pytest.fixture(autouse=True)
def _mount_routers():
    from main import app
    from routes.portal_admin_routes import router as admin_router
    from routes.portal_routes import router as portal_router

    if not any(getattr(r, "path", "") == "/api/events/{event_id}/content" for r in app.routes):
        app.include_router(admin_router)
    if not any(getattr(r, "path", "") == "/public/portal/me" for r in app.routes):
        app.include_router(portal_router)
    yield


@pytest.fixture
def content_db(seeded_db):
    db = seeded_db
    db.seed(
        "contacts",
        {"id": ADA, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com"},
        {"id": BEN, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "first_name": "Ben", "last_name": "Franklin", "email": "ben@example.com"},
    )
    db.seed(
        "tasks",
        {"id": T_SLIDES, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "kind": "file_request", "name": "Upload slides", "required": True, "order": 0},
        {"id": T_HEADSHOT, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "kind": "file_request", "name": "Headshot photo", "required": True, "order": 1},
        {"id": T_BIO, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "kind": "file_request", "name": "Speaker bio", "required": False, "order": 2},
        # Foreign org's task — must never leak into TEST_ORG's library.
        {"id": T_FOREIGN, "org_id": OTHER_ORG_ID, "event_id": OTHER_EVENT_ID, "kind": "file_request", "name": "Foreign slides", "required": True},
    )
    db.seed(
        "task_assignments",
        {"id": A_ADA_SLIDES, "org_id": TEST_ORG_ID, "task_id": T_SLIDES, "contact_id": ADA, "status": "submitted", "file_id": FILE_ADA_SLIDES},
        {"id": A_ADA_HEADSHOT, "org_id": TEST_ORG_ID, "task_id": T_HEADSHOT, "contact_id": ADA, "status": "todo"},
        {"id": A_BEN_SLIDES, "org_id": TEST_ORG_ID, "task_id": T_SLIDES, "contact_id": BEN, "status": "todo"},
        {"id": A_BEN_BIO, "org_id": TEST_ORG_ID, "task_id": T_BIO, "contact_id": BEN, "status": "todo"},
        {"id": A_FOREIGN, "org_id": OTHER_ORG_ID, "task_id": T_FOREIGN, "contact_id": "c-foreign", "status": "todo"},
    )
    db.seed(
        "files",
        {"id": FILE_ADA_SLIDES, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "contact_id": ADA, "task_assignment_id": A_ADA_SLIDES, "bucket_path": "seed/ada-slides-v1.pdf", "filename": "slides.pdf", "mimetype": "application/pdf", "size": 12, "version": 1},
    )
    return db


def _cookie(contact_id: str, org_id: str = TEST_ORG_ID) -> dict[str, str]:
    token = issue_session("portal", org_id, contact_id=contact_id)
    return {"Cookie": f"{COOKIE_NAME}={token}"}


def _pdf(name: str = "deck.pdf") -> dict:
    return {"file": (name, b"%PDF-1.5 fake slide deck bytes", "application/pdf")}


# ── versioning ───────────────────────────────────────────────────────────────


def test_reupload_keeps_version_history(client, content_db):
    # Two uploads to the same file-request → v1 then v2, both retained.
    first = client.post(f"/public/portal/tasks/{A_BEN_SLIDES}/upload", headers=_cookie(BEN), files=_pdf("v1.pdf"))
    assert first.status_code == 200
    assert first.json()["version"] == 1

    second = client.post(f"/public/portal/tasks/{A_BEN_SLIDES}/upload", headers=_cookie(BEN), files=_pdf("v2.pdf"))
    assert second.status_code == 200
    assert second.json()["version"] == 2

    # History is not overwritten: two files rows for the one assignment.
    files = [f for f in content_db.rows("files") if f.get("task_assignment_id") == A_BEN_SLIDES]
    assert sorted(f["version"] for f in files) == [1, 2]

    # The portal shows the current version and the prior one.
    me = client.get("/public/portal/me", headers=_cookie(BEN)).json()
    slides = next(t for t in me["tasks"] if t["task"]["name"] == "Upload slides")
    assert slides["file"]["version"] == 2
    assert [v["version"] for v in slides["versions"]] == [2, 1]
    assert slides["versions"][0]["is_current"] is True
    assert slides["versions"][1]["is_current"] is False


# ── comments (scoping both ways) ─────────────────────────────────────────────


def test_organizer_comment_visible_to_speaker_and_notifies(client, auth_headers, content_db):
    resp = client.post(
        f"/api/task-assignments/{A_ADA_SLIDES}/comments",
        headers=auth_headers,
        json={"body": "Headshot is too low-res — please re-upload."},
    )
    assert resp.status_code == 201
    assert resp.json()["comment"]["author_role"] == "organizer"

    # stored
    stored = [c for c in content_db.rows("content_comments") if c["task_assignment_id"] == A_ADA_SLIDES]
    assert len(stored) == 1

    # the speaker sees it in their own portal payload
    me = client.get("/public/portal/me", headers=_cookie(ADA)).json()
    slides = next(t for t in me["tasks"] if t["task"]["name"] == "Upload slides")
    assert [c["author_role"] for c in slides["comments"]] == ["organizer"]

    # and a feedback email was queued for the speaker
    queued = [e for e in content_db.rows("email_outbox") if e.get("template_key") == "content_feedback"]
    assert len(queued) == 1
    assert queued[0]["contact_id"] == ADA


def test_speaker_can_reply_on_own_item(client, content_db):
    resp = client.post(
        f"/public/portal/tasks/{A_ADA_SLIDES}/comments",
        headers=_cookie(ADA),
        json={"body": "Fixed — uploaded a sharper version."},
    )
    assert resp.status_code == 200
    assert resp.json()["comment"]["author_role"] == "speaker"

    me = client.get("/public/portal/me", headers=_cookie(ADA)).json()
    slides = next(t for t in me["tasks"] if t["task"]["name"] == "Upload slides")
    assert slides["comments"][-1]["author_label"] == "Ada Lovelace"


def test_speaker_cannot_comment_on_another_speakers_item(client, content_db):
    # Ada's cookie against Ben's assignment → 404, nothing written.
    resp = client.post(
        f"/public/portal/tasks/{A_BEN_SLIDES}/comments",
        headers=_cookie(ADA),
        json={"body": "sneaky"},
    )
    assert resp.status_code == 404
    assert content_db.rows("content_comments") == []


def test_organizer_cannot_touch_foreign_item(client, auth_headers, content_db):
    # TEST_ORG organizer against OTHER_ORG's assignment → 404 both ways.
    assert client.get(f"/api/task-assignments/{A_FOREIGN}/content", headers=auth_headers).status_code == 404
    assert client.post(
        f"/api/task-assignments/{A_FOREIGN}/comments", headers=auth_headers, json={"body": "x"}
    ).status_code == 404


def test_item_detail_returns_versions_and_thread(client, auth_headers, content_db):
    client.post(f"/api/task-assignments/{A_ADA_SLIDES}/comments", headers=auth_headers, json={"body": "hi", "notify": False})
    resp = client.get(f"/api/task-assignments/{A_ADA_SLIDES}/content", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["item"]["type"] == "slides"
    assert body["item"]["current_version"] == 1
    assert len(body["versions"]) == 1
    assert len(body["comments"]) == 1


# ── library (org-scoped list + filters) ──────────────────────────────────────


def test_library_lists_items_org_scoped_with_outstanding(client, auth_headers, content_db):
    resp = client.get(f"/api/events/{TEST_EVENT_ID}/content", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()

    by_id = {i["item_id"]: i for i in body["items"]}
    assert set(by_id) == {A_ADA_SLIDES, A_ADA_HEADSHOT, A_BEN_SLIDES, A_BEN_BIO}  # no foreign item

    assert by_id[A_ADA_SLIDES]["type"] == "slides"
    assert by_id[A_ADA_SLIDES]["status"] == "received"
    assert by_id[A_ADA_SLIDES]["current_version"] == 1
    assert by_id[A_ADA_HEADSHOT]["type"] == "headshot"
    assert by_id[A_ADA_HEADSHOT]["status"] == "missing"
    assert by_id[A_BEN_BIO]["type"] == "bio"

    # who's outstanding on REQUIRED content: Ada (headshot) + Ben (slides), not the optional bio.
    outstanding = {o["contact_id"] for o in body["outstanding"]}
    assert outstanding == {ADA, BEN}


def test_library_filters_by_type_and_status(client, auth_headers, content_db):
    slides = client.get(f"/api/events/{TEST_EVENT_ID}/content?type=slides", headers=auth_headers).json()
    assert {i["item_id"] for i in slides["items"]} == {A_ADA_SLIDES, A_BEN_SLIDES}

    missing = client.get(f"/api/events/{TEST_EVENT_ID}/content?status=missing", headers=auth_headers).json()
    assert {i["item_id"] for i in missing["items"]} == {A_ADA_HEADSHOT, A_BEN_SLIDES, A_BEN_BIO}


def test_library_requires_matching_org(client, auth_headers, content_db):
    assert client.get(f"/api/events/{OTHER_EVENT_ID}/content", headers=auth_headers).status_code == 404


# ── bulk reminders ───────────────────────────────────────────────────────────


def test_remind_outstanding_queues_one_email_per_speaker(client, auth_headers, content_db):
    resp = client.post(f"/api/events/{TEST_EVENT_ID}/content/remind", headers=auth_headers, json={})
    assert resp.status_code == 200
    assert resp.json()["reminded"] == 2  # Ada (headshot) + Ben (slides)

    queued = [e for e in content_db.rows("email_outbox") if e.get("template_key") == "content_reminder"]
    assert {e["contact_id"] for e in queued} == {ADA, BEN}


def test_remind_can_target_one_item_type(client, auth_headers, content_db):
    resp = client.post(
        f"/api/events/{TEST_EVENT_ID}/content/remind",
        headers=auth_headers,
        json={"required_only": False, "item_type": "bio"},
    )
    assert resp.status_code == 200
    assert resp.json()["reminded"] == 1  # only Ben is missing a bio
    assert resp.json()["contacts"] == [BEN]


def test_remind_is_deduped_within_the_day(client, auth_headers, content_db):
    # A second click the same day must not re-enqueue — no duplicate storm.
    first = client.post(f"/api/events/{TEST_EVENT_ID}/content/remind", headers=auth_headers, json={})
    assert first.json()["reminded"] == 2

    second = client.post(f"/api/events/{TEST_EVENT_ID}/content/remind", headers=auth_headers, json={})
    assert second.json()["reminded"] == 0  # deduped
    assert second.json()["outstanding"] == 2  # still reported as outstanding

    queued = [e for e in content_db.rows("email_outbox") if e.get("template_key") == "content_reminder"]
    assert len(queued) == 2  # one per contact, not four
    assert {e["contact_id"] for e in queued} == {ADA, BEN}


# ── bundle export ────────────────────────────────────────────────────────────


def test_export_manifest_is_metadata_only(client, auth_headers, content_db, monkeypatch):
    """The manifest lists files (with size + URL) WITHOUT downloading any bytes."""
    import services.content_pipeline as cp

    downloads: list[str] = []
    original = cp._download

    async def tracked(bucket_path):
        downloads.append(bucket_path)
        return await original(bucket_path)

    monkeypatch.setattr(cp, "_download", tracked)

    manifest = client.get(
        f"/api/events/{TEST_EVENT_ID}/content/export?format=manifest", headers=auth_headers
    ).json()

    assert downloads == []  # the whole point: zero downloads for a manifest
    # Ada's seeded file has NO bytes in storage, yet it is still listed — proof
    # the manifest is metadata-only and never tried to fetch it.
    assert manifest["count"] == 1
    assert {m["item_id"] for m in manifest["files"]} == {A_ADA_SLIDES}
    ada = next(m for m in manifest["files"] if m["item_id"] == A_ADA_SLIDES)
    assert ada["url"] and ada["size"] == 12
    assert "bucket_path" not in ada  # internal path is not leaked


def test_export_zip_bundles_downloadable_files(client, auth_headers, content_db):
    # Ben uploads a real (byte-backed) deck; Ada's seeded file has no bytes.
    client.post(f"/public/portal/tasks/{A_BEN_SLIDES}/upload", headers=_cookie(BEN), files=_pdf("ben.pdf"))

    resp = client.get(f"/api/events/{TEST_EVENT_ID}/content/export", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
    # Ben's downloadable deck is in; Ada's byte-less file is skipped, not fatal.
    assert any("Ben_Franklin" in n and "slides" in n.lower() for n in names)
    assert all(not n.startswith("/") and ".." not in n for n in names)


# ── export entry-name safety (pure helpers) ──────────────────────────────────


def test_slug_blocks_path_traversal():
    from services.content_pipeline import _slug

    # A speaker literally named ".." can't escape the archive.
    assert _slug("..", "spk") == "spk"
    assert _slug("...", "spk") == "spk"
    assert not _slug(".hidden", "spk").startswith(".")
    safe = _slug("../../etc/passwd", "spk")
    assert "/" not in safe and ".." not in safe


def test_entry_names_are_traversal_safe_and_unique():
    from services.content_pipeline import _entry_name

    # A traversal-y speaker + filename resolve to a single safe folder level.
    evil = _entry_name("../..", "c-1", "..", "a-1", 1, "../../evil.sh")
    assert not evil.startswith("/")
    assert ".." not in evil
    assert evil.count("/") == 1  # exactly one folder separator (the one we add)

    # Two identically-named speakers with the same task/file/version don't collide.
    e1 = _entry_name("Alex Kim", "contact-aaaa1111", "Upload slides", "assign-1111", 1, "deck.pdf")
    e2 = _entry_name("Alex Kim", "contact-bbbb2222", "Upload slides", "assign-2222", 1, "deck.pdf")
    assert e1 != e2
