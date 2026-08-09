"""Speaker CRM: profile aggregate, CSV import, and profile edit.

The three things that turn the roster into a CRM, and the three things that can
go wrong: a foreign speaker must never be reachable (org AND event scoped), a
bulk import must upsert on email and survive a bad row, and an edit must refuse
an email that collides with the event's unique constraint.

The pure CSV/validation helpers are tested directly too — that logic is where
a paste-gone-wrong actually gets caught.
"""

from __future__ import annotations

import pytest

from services import speaker_crm
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

ADA = "22222222-2222-2222-2222-2222222200a1"
BEN = "22222222-2222-2222-2222-2222222200a2"
FOREIGN = "22222222-2222-2222-2222-2222222200ff"

SUB_SESSION = "99999999-9999-9999-9999-9999999900a1"
SCHED_SESSION = "99999999-9999-9999-9999-9999999900a2"
ROOM = "88888888-8888-8888-8888-8888888800a1"

T_DONE = "33333333-3333-3333-3333-3333333300a1"
T_OPEN = "33333333-3333-3333-3333-3333333300a2"


@pytest.fixture
def crm_db(seeded_db):
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
            "company_name": "Analytical Engines",
            "title": "Chief Mathematician",
            "about": "Wrote the first algorithm.",
            "last_portal_access_at": "2026-08-01T00:00:00+00:00",
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
            "event_id": OTHER_EVENT_ID,
            "first_name": "Foreign",
            "last_name": "Speaker",
            "email": "foreign@example.com",
        },
    )
    db.seed("rooms", {"id": ROOM, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Main Hall"})
    db.seed(
        "sessions",
        {
            "id": SUB_SESSION,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "On the Analytical Engine",
            "status": "pending",
            "submitter_contact_id": ADA,
            "submitted_at": "2026-07-01T00:00:00+00:00",
        },
        {
            "id": SCHED_SESSION,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Keynote: Computing's Future",
            "status": "accepted",
            "starts_at": "2026-09-01T17:00:00+00:00",
            "ends_at": "2026-09-01T18:00:00+00:00",
            "room_id": ROOM,
        },
    )
    db.seed(
        "session_participants",
        {"org_id": TEST_ORG_ID, "session_id": SCHED_SESSION, "contact_id": ADA, "role": "speaker", "is_primary": True},
    )
    db.seed(
        "tasks",
        {"id": T_DONE, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Sign agreement", "kind": "todo", "required": True},
        {"id": T_OPEN, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Upload slides", "kind": "file_request", "required": True},
    )
    db.seed(
        "task_assignments",
        {"id": "44444444-4444-4444-4444-4444444400a1", "org_id": TEST_ORG_ID, "task_id": T_DONE, "contact_id": ADA, "status": "approved"},
        {"id": "44444444-4444-4444-4444-4444444400a2", "org_id": TEST_ORG_ID, "task_id": T_OPEN, "contact_id": ADA, "status": "submitted"},
    )
    db.seed(
        "email_outbox",
        {
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "contact_id": ADA,
            "template_key": "accept",
            "payload": {"subject": "You're in!"},
            "status": "sent",
            "sent_at": "2026-07-05T00:00:00+00:00",
            "created_at": "2026-07-05T00:00:00+00:00",
        },
    )
    db.seed(
        "magic_link_tokens",
        {"org_id": TEST_ORG_ID, "purpose": "portal", "contact_id": ADA, "token_hash": "seed", "expires_at": "2027-01-01T00:00:00+00:00"},
    )
    return db


# ── pure helpers ─────────────────────────────────────────────────────────────


def test_looks_like_email():
    assert speaker_crm.looks_like_email("a@b.com")
    assert not speaker_crm.looks_like_email("")
    assert not speaker_crm.looks_like_email("no-at-sign")
    assert not speaker_crm.looks_like_email("@nope.com")
    assert not speaker_crm.looks_like_email("trailing@")
    assert not speaker_crm.looks_like_email("no-dot@domain")


def test_parse_speaker_csv_maps_aliases_and_skips_blanks():
    text = "First Name,Last Name,Email,Company,Role\nAda,Lovelace,ada@x.com,Engines,Math\n\nBen,Franklin,ben@x.com,,Printer\n"
    rows, error, parse_errors = speaker_crm.parse_speaker_csv(text)
    assert error is None
    assert parse_errors == []
    assert [r["email"] for r in rows] == ["ada@x.com", "ben@x.com"]
    assert rows[0]["company"] == "Engines"
    assert rows[0]["title"] == "Math"  # "Role" alias → title
    assert rows[1]["line"] == 4  # header is line 1, blank line 3 skipped


def test_parse_speaker_csv_requires_email_column():
    rows, error, parse_errors = speaker_crm.parse_speaker_csv("name,company\nAda,Engines\n")
    assert rows == []
    assert error and "email" in error.lower()
    assert parse_errors == []


def test_parse_speaker_csv_survives_oversized_cell():
    # A cell far larger than csv's DEFAULT field-size limit (131_072). Before the
    # fix this raised csv.Error and aborted the whole parse; now the reader keeps
    # going and both rows come back for length validation downstream.
    huge = "x" * 200_000
    text = f"first_name,last_name,email,company,title\nAda,Lovelace,ada@x.com,{huge},Math\nBen,Franklin,ben@x.com,Press,Printer\n"
    rows, error, _parse_errors = speaker_crm.parse_speaker_csv(text)
    assert error is None
    assert [r["email"] for r in rows] == ["ada@x.com", "ben@x.com"]  # nothing aborted


def test_collect_import_flags_oversized_field():
    parsed = [
        {"email": "ada@x.com", "company": "y" * 400, "line": 2},  # over the 300 cap
        {"email": "ben@x.com", "company": "Press", "line": 3},
    ]
    valid, errors, _dup = speaker_crm.collect_import(parsed)
    assert [v["email"] for v in valid] == ["ben@x.com"]  # good row still imports
    assert len(errors) == 1 and errors[0]["line"] == 2
    assert "too long" in errors[0]["message"].lower()


def test_collect_import_dedupes_and_flags_bad_rows():
    parsed = [
        {"email": "Ada@X.com", "first_name": "Ada", "line": 2},
        {"email": "ada@x.com", "first_name": "Ada2", "line": 3},  # dup (case-fold)
        {"email": "bad-email", "first_name": "Nope", "line": 4},  # invalid
        {"email": "ben@x.com", "first_name": "Ben", "line": 5},
    ]
    valid, errors, dup = speaker_crm.collect_import(parsed)
    assert [v["email"] for v in valid] == ["ada@x.com", "ben@x.com"]  # normalized, first wins
    assert dup == 1
    assert len(errors) == 1 and errors[0]["line"] == 4


def test_contact_patch_fills_and_overwrites_without_blanking():
    existing = {"first_name": "Ada", "company_name": "", "title": "Math"}
    row = {"first_name": "Ada", "company_name": "", "company": "Engines", "title": "", "last_name": "Lovelace"}
    patch = speaker_crm.contact_patch(row, existing)
    assert patch == {"company_name": "Engines", "last_name": "Lovelace"}  # title empty → not blanked


# ── profile aggregate ────────────────────────────────────────────────────────


def test_speaker_profile_aggregate(client, auth_headers, crm_db):
    resp = client.get(f"/api/events/{TEST_EVENT_ID}/speakers/{ADA}", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()

    speaker = body["speaker"]
    assert speaker["name"] == "Ada Lovelace"
    assert speaker["email"] == "ada@example.com"
    assert speaker["company_name"] == "Analytical Engines"
    assert speaker["title"] == "Chief Mathematician"
    assert speaker["about"] == "Wrote the first algorithm."
    assert speaker["invited"] is True
    assert speaker["tasks_total"] == 2
    assert speaker["tasks_done"] == 1  # 'approved' counts, 'submitted' does not
    assert speaker["tasks_outstanding"] == 1

    assert [s["title"] for s in body["submissions"]] == ["On the Analytical Engine"]
    assert body["submissions"][0]["status"] == "pending"

    sessions = body["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["title"] == "Keynote: Computing's Future"
    assert sessions[0]["room"] == "Main Hall"
    assert sessions[0]["scheduled"] is True
    assert sessions[0]["role"] == "speaker"

    assert {t["name"] for t in body["onboarding"]} == {"Sign agreement", "Upload slides"}
    assert [c["subject"] for c in body["communications"]] == ["You're in!"]


def test_speaker_profile_foreign_contact_404s(client, auth_headers, crm_db):
    resp = client.get(f"/api/events/{TEST_EVENT_ID}/speakers/{FOREIGN}", headers=auth_headers)
    assert resp.status_code == 404


def test_speaker_profile_foreign_event_404s(client, auth_headers, crm_db):
    resp = client.get(f"/api/events/{OTHER_EVENT_ID}/speakers/{ADA}", headers=auth_headers)
    assert resp.status_code == 404


# ── CSV import ───────────────────────────────────────────────────────────────


def test_import_csv_creates_updates_skips_and_reports_errors(client, auth_headers, crm_db):
    # New (Carla), update (Ben gains a company), duplicate of the new one,
    # and one bad row with no @.
    csv_text = (
        "first_name,last_name,email,company,title\n"
        "Carla,Curie,carla@example.com,Radium Labs,Physicist\n"
        "Ben,Franklin,Ben@Example.com,Franklin Press,Printer\n"
        "Carla,Dup,carla@example.com,Dup Co,Dup\n"
        "Bad,Row,not-an-email,,\n"
    )
    resp = client.post(
        f"/api/events/{TEST_EVENT_ID}/speakers/import",
        headers=auth_headers,
        json={"csv": csv_text},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["created"] == 1  # Carla
    assert body["updated"] == 1  # Ben got a company
    assert body["skipped"] == 1  # the in-file duplicate
    assert len(body["errors"]) == 1  # the bad email
    assert body["errors"][0]["email"] == "not-an-email"

    # Carla was inserted, normalized + org/event scoped.
    carla = [c for c in crm_db.rows("contacts") if c.get("email") == "carla@example.com"]
    assert len(carla) == 1
    assert carla[0]["org_id"] == TEST_ORG_ID and carla[0]["event_id"] == TEST_EVENT_ID
    assert carla[0]["company_name"] == "Radium Labs"

    # Ben was updated in place (case-folded email match), not duplicated.
    ben = [c for c in crm_db.rows("contacts") if c.get("email") == "ben@example.com"]
    assert len(ben) == 1
    assert ben[0]["company_name"] == "Franklin Press"


def test_import_survives_oversized_row(client, auth_headers, crm_db):
    # One row has a company cell larger than csv's default field-size limit; the
    # rest are valid. The good rows must import, the fat row must land in errors,
    # and no exception may escape (a 500 would fail the request outright).
    huge = "x" * 200_000
    csv_text = (
        "first_name,last_name,email,company,title\n"
        "Grace,Hopper,grace@example.com,Navy,Admiral\n"
        f"Katherine,Johnson,katherine@example.com,{huge},Mathematician\n"
        "Dorothy,Vaughan,dorothy@example.com,NASA,Supervisor\n"
    )
    resp = client.post(
        f"/api/events/{TEST_EVENT_ID}/speakers/import",
        headers=auth_headers,
        json={"csv": csv_text},
    )
    assert resp.status_code == 200  # not a 500, and not aborted
    body = resp.json()
    assert body["created"] == 2  # Grace + Dorothy
    assert len(body["errors"]) == 1
    assert body["errors"][0]["email"] == "katherine@example.com"
    assert "too long" in body["errors"][0]["message"].lower()

    emails = {c.get("email") for c in crm_db.rows("contacts")}
    assert {"grace@example.com", "dorothy@example.com"} <= emails
    assert "katherine@example.com" not in emails  # the oversized row was skipped


def test_import_rejects_bad_header(client, auth_headers, crm_db):
    resp = client.post(
        f"/api/events/{TEST_EVENT_ID}/speakers/import",
        headers=auth_headers,
        json={"csv": "name,company\nAda,Engines\n"},
    )
    assert resp.status_code == 400


def test_import_structured_rows_manual_add(client, auth_headers, crm_db):
    resp = client.post(
        f"/api/events/{TEST_EVENT_ID}/speakers/import",
        headers=auth_headers,
        json={"rows": [{"first_name": "Grace", "last_name": "Hopper", "email": "grace@example.com", "company": "Navy"}]},
    )
    assert resp.status_code == 200
    assert resp.json()["created"] == 1
    grace = [c for c in crm_db.rows("contacts") if c.get("email") == "grace@example.com"]
    assert len(grace) == 1 and grace[0]["first_name"] == "Grace"


def test_import_requires_a_payload(client, auth_headers, crm_db):
    resp = client.post(
        f"/api/events/{TEST_EVENT_ID}/speakers/import",
        headers=auth_headers,
        json={},
    )
    assert resp.status_code == 400


def test_import_foreign_event_404s(client, auth_headers, crm_db):
    resp = client.post(
        f"/api/events/{OTHER_EVENT_ID}/speakers/import",
        headers=auth_headers,
        json={"rows": [{"email": "x@example.com"}]},
    )
    assert resp.status_code == 404


# ── profile edit ─────────────────────────────────────────────────────────────


def test_update_speaker_fields(client, auth_headers, crm_db):
    resp = client.patch(
        f"/api/events/{TEST_EVENT_ID}/speakers/{BEN}",
        headers=auth_headers,
        json={"company_name": "Franklin Press", "title": "Founder", "about": "Polymath."},
    )
    assert resp.status_code == 200
    speaker = resp.json()["speaker"]
    assert speaker["company_name"] == "Franklin Press"
    assert speaker["title"] == "Founder"
    assert speaker["about"] == "Polymath."
    row = next(c for c in crm_db.rows("contacts") if c["id"] == BEN)
    assert row["company_name"] == "Franklin Press"


def test_update_speaker_foreign_404s(client, auth_headers, crm_db):
    resp = client.patch(
        f"/api/events/{TEST_EVENT_ID}/speakers/{FOREIGN}",
        headers=auth_headers,
        json={"title": "Nope"},
    )
    assert resp.status_code == 404


def test_update_speaker_email_collision_409s(client, auth_headers, crm_db):
    resp = client.patch(
        f"/api/events/{TEST_EVENT_ID}/speakers/{ADA}",
        headers=auth_headers,
        json={"email": "ben@example.com"},
    )
    assert resp.status_code == 409


def test_update_speaker_invalid_email_400s(client, auth_headers, crm_db):
    resp = client.patch(
        f"/api/events/{TEST_EVENT_ID}/speakers/{ADA}",
        headers=auth_headers,
        json={"email": "not-an-email"},
    )
    assert resp.status_code == 400
