"""The public org-token ``/v1`` API.

Exercises the contract shaped after Other Conference/CFP Software: ``x-access-token`` auth, the
list + ``/search`` variants, the ``{data, page, pageSize, total}`` envelope,
pagination limits, the nested session/contact shapes, and org isolation (a key
for one org cannot read another org's event).
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.magic_links import hash_token
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

READ_KEY = "dais_readkey"
OTHER_KEY = "dais_otherkey"
HEADERS = {"x-access-token": READ_KEY}


@pytest.fixture
def v1_client():
    from routes.v1_routes import router

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def api_db(seeded_db):
    """seeded_db (org + two events) plus a read key for each org."""
    seeded_db.seed(
        "api_tokens",
        {"id": "k1", "org_id": TEST_ORG_ID, "token_hash": hash_token(READ_KEY), "scopes": ["read"]},
        {"id": "k2", "org_id": OTHER_ORG_ID, "token_hash": hash_token(OTHER_KEY), "scopes": ["read"]},
    )
    return seeded_db


def _seed_session(db, sid: str, raw: int, **overrides) -> None:
    db.seed(
        "sessions",
        {
            "id": sid,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "friendly_id_raw": raw,
            "friendly_id": f"SESS-{raw}",
            "title": f"Session {raw}",
            "description": "",
            "status": "accepted",
            "is_abstract": False,
            "starts_at": None,
            "ends_at": None,
            **overrides,
        },
    )


def _seed_contact(db, cid: str, **overrides) -> None:
    db.seed(
        "contacts",
        {
            "id": cid,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": f"{cid}@example.com",
            "first_name": "Ada",
            "last_name": "Lovelace",
            **overrides,
        },
    )


# ── auth ─────────────────────────────────────────────────────────────────────


def test_missing_key_401s(v1_client, api_db):
    assert v1_client.get("/v1/events").status_code == 401


def test_invalid_key_401s(v1_client, api_db):
    assert v1_client.get("/v1/events", headers={"x-access-token": "dais_nope"}).status_code == 401
    assert v1_client.get("/v1/events", headers={"x-access-token": "garbage"}).status_code == 401


# ── events ───────────────────────────────────────────────────────────────────


def test_list_events_is_scoped_to_the_key_org(v1_client, api_db):
    response = v1_client.get("/v1/events", headers=HEADERS)

    assert response.status_code == 200
    events = response.json()["data"]
    # Only org_dev's event, never OTHER_ORG's.
    assert [e["slug"] for e in events] == ["ai-builders-summit"]
    assert set(events[0]) == {
        "id",
        "name",
        "slug",
        "starts_at",
        "ends_at",
        "timezone",
        "branding",
    }


def test_get_event_and_cross_org_404(v1_client, api_db):
    response = v1_client.get(f"/v1/events/{TEST_EVENT_ID}", headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["data"]["id"] == TEST_EVENT_ID
    assert v1_client.get(f"/v1/events/{OTHER_EVENT_ID}", headers=HEADERS).status_code == 404


# ── sessions: list + search ──────────────────────────────────────────────────


def test_sessions_shape_includes_room_track_and_speakers(v1_client, api_db):
    api_db.seed("rooms", {"id": "room1", "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Main Hall", "capacity": 300})
    api_db.seed("tracks", {"id": "track1", "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "AI", "color": "#123456"})
    _seed_contact(api_db, "c1", first_name="Grace", last_name="Hopper")
    _seed_session(api_db, "s1", 8, room_id="room1", track_id="track1", title="Keynote", description="Hi")
    api_db.seed(
        "session_participants",
        {"id": "p1", "org_id": TEST_ORG_ID, "session_id": "s1", "contact_id": "c1", "role": "speaker", "is_primary": True},
        # A non-speaker participant must NOT show up in speakers[].
        {"id": "p2", "org_id": TEST_ORG_ID, "session_id": "s1", "contact_id": "c1", "role": "moderator", "is_primary": False},
    )

    response = v1_client.get(f"/v1/events/{TEST_EVENT_ID}/sessions", headers=HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    session = body["data"][0]
    assert session["friendly_id"] == "SESS-8"
    assert session["title"] == "Keynote"
    assert session["is_abstract"] is False
    assert session["room"] == {"id": "room1", "name": "Main Hall", "capacity": 300}
    assert session["track"] == {"id": "track1", "name": "AI", "color": "#123456"}
    assert session["speakers"] == [{"id": "c1", "full_name": "Grace Hopper", "email": "c1@example.com"}]


def test_sessions_null_room_and_track(v1_client, api_db):
    _seed_session(api_db, "s1", 1)
    session = v1_client.get(f"/v1/events/{TEST_EVENT_ID}/sessions", headers=HEADERS).json()["data"][0]
    assert session["room"] is None
    assert session["track"] is None
    assert session["speakers"] == []


def test_sessions_status_filter(v1_client, api_db):
    _seed_session(api_db, "s1", 1, status="accepted")
    _seed_session(api_db, "s2", 2, status="pending")

    accepted = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/sessions", headers=HEADERS, params={"status": "accepted"}
    ).json()
    assert accepted["total"] == 1
    assert accepted["data"][0]["id"] == "s1"


def test_sessions_unknown_status_400s(v1_client, api_db):
    response = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/sessions", headers=HEADERS, params={"status": "bogus"}
    )
    assert response.status_code == 400


def test_sessions_pagination(v1_client, api_db):
    for i in range(1, 6):
        _seed_session(api_db, f"s{i}", i)

    page1 = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/sessions", headers=HEADERS, params={"page": 1, "pageSize": 2}
    ).json()
    assert page1 == {"data": page1["data"], "page": 1, "pageSize": 2, "total": 5}
    assert len(page1["data"]) == 2

    page3 = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/sessions", headers=HEADERS, params={"page": 3, "pageSize": 2}
    ).json()
    assert len(page3["data"]) == 1
    assert page3["total"] == 5


@pytest.mark.parametrize("params", [{"page": 0}, {"pageSize": 0}, {"pageSize": 101}, {"page": 1000}])
def test_bad_pagination_400s(v1_client, api_db, params):
    response = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/sessions", headers=HEADERS, params=params
    )
    assert response.status_code == 400


def test_search_sessions_mirrors_list(v1_client, api_db):
    _seed_session(api_db, "s1", 1, status="accepted")
    _seed_session(api_db, "s2", 2, status="declined")

    response = v1_client.post(
        f"/v1/events/{TEST_EVENT_ID}/sessions/search",
        headers=HEADERS,
        json={"status": "accepted", "page": 1, "pageSize": 25},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["data"][0]["id"] == "s1"


def test_search_sessions_empty_body_defaults(v1_client, api_db):
    _seed_session(api_db, "s1", 1)
    response = v1_client.post(f"/v1/events/{TEST_EVENT_ID}/sessions/search", headers=HEADERS, json={})
    assert response.status_code == 200
    assert response.json() == {"data": response.json()["data"], "page": 1, "pageSize": 25, "total": 1}


def test_search_sessions_bad_pagination_400s(v1_client, api_db):
    response = v1_client.post(
        f"/v1/events/{TEST_EVENT_ID}/sessions/search", headers=HEADERS, json={"pageSize": 500}
    )
    assert response.status_code == 400


def test_submission_get_create_update_and_track_filter(v1_client, api_db):
    api_db.seed(
        "tracks",
        {
            "id": "track1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "AI",
        },
    )
    created = v1_client.post(
        f"/v1/events/{TEST_EVENT_ID}/submissions",
        headers=HEADERS,
        json={
            "title": "  Agentic conferences  ",
            "abstract": "Original abstract",
            "submitter_email": "speaker@example.com",
            "submitter_first_name": "Ada",
            "submitter_last_name": "Lovelace",
            "track_id": "track1",
        },
    )
    assert created.status_code == 201
    submission_id = created.json()["data"]["id"]
    assert created.json()["data"]["status"] == "pending"

    fetched = v1_client.get(f"/v1/submissions/{submission_id}", headers=HEADERS)
    assert fetched.status_code == 200
    assert fetched.json()["data"]["title"] == "Agentic conferences"

    updated = v1_client.patch(
        f"/v1/submissions/{submission_id}",
        headers=HEADERS,
        json={
            "status": "accepted",
            "title": "Agentic Events",
            "abstract": "Final",
            "feedback": "Strong fit for the audience.",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["status"] == "accepted"
    assert updated.json()["data"]["description"] == "Final"
    stored = next(row for row in api_db.rows("sessions") if row["id"] == submission_id)
    assert stored["custom_fields"]["decision_feedback"] == "Strong fit for the audience."

    filtered = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/submissions",
        headers=HEADERS,
        params={"track": "AI"},
    ).json()
    assert filtered["total"] == 1
    assert filtered["data"][0]["id"] == submission_id


def test_submission_direct_cross_org_404(v1_client, api_db):
    api_db.seed(
        "sessions",
        {
            "id": "foreign-session",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "title": "Private",
            "status": "pending",
        },
    )
    assert v1_client.get("/v1/submissions/foreign-session", headers=HEADERS).status_code == 404
    assert (
        v1_client.patch(
            "/v1/submissions/foreign-session",
            headers=HEADERS,
            json={"status": "accepted"},
        ).status_code
        == 404
    )


# ── contacts ─────────────────────────────────────────────────────────────────


def test_contacts_shape_and_full_name(v1_client, api_db):
    _seed_contact(
        api_db,
        "c1",
        first_name="Ada",
        last_name="Lovelace",
        company_name="Analytical Engines",
        title="Mathematician",
        about="First programmer",
    )

    response = v1_client.get(f"/v1/events/{TEST_EVENT_ID}/contacts", headers=HEADERS)

    assert response.status_code == 200
    contact = response.json()["data"][0]
    assert contact == {
        "id": "c1",
        "full_name": "Ada Lovelace",
        "email": "c1@example.com",
        "company_name": "Analytical Engines",
        "title": "Mathematician",
        "about": "First programmer",
    }


def test_contacts_search_and_pagination(v1_client, api_db):
    _seed_contact(api_db, "c1", last_name="Adams")
    _seed_contact(api_db, "c2", last_name="Baker")
    _seed_contact(api_db, "c3", last_name="Clarke")

    body = v1_client.post(
        f"/v1/events/{TEST_EVENT_ID}/contacts/search", headers=HEADERS, json={"page": 1, "pageSize": 2}
    ).json()
    assert body["total"] == 3
    assert [c["full_name"] for c in body["data"]] == ["Ada Adams", "Ada Baker"]


# ── speakers ─────────────────────────────────────────────────────────────────


def test_speaker_list_create_get_and_update(v1_client, api_db):
    created = v1_client.post(
        f"/v1/events/{TEST_EVENT_ID}/speakers",
        headers=HEADERS,
        json={
            "email": "grace@example.com",
            "first_name": "Grace",
            "last_name": "Hopper",
            "speaker_status": "invited",
            "logistics_notes": "Needs a confidence monitor",
        },
    )
    assert created.status_code == 201
    speaker_id = created.json()["data"]["id"]

    listed = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/speakers",
        headers=HEADERS,
        params={"status": "invited", "filter": "hopper"},
    ).json()
    assert listed["total"] == 1
    assert listed["data"][0]["logistics_notes"] == "Needs a confidence monitor"

    updated = v1_client.patch(
        f"/v1/speakers/{speaker_id}",
        headers=HEADERS,
        json={"speaker_status": "confirmed", "logistics_notes": "Arriving Sunday"},
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["speaker_status"] == "confirmed"
    assert updated.json()["data"]["logistics_notes"] == "Arriving Sunday"
    assert v1_client.get(f"/v1/speakers/{speaker_id}", headers=HEADERS).status_code == 200


def test_speaker_direct_cross_org_404(v1_client, api_db):
    api_db.seed(
        "contacts",
        {
            "id": "foreign-speaker",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "email": "private@example.com",
        },
    )
    assert v1_client.get("/v1/speakers/foreign-speaker", headers=HEADERS).status_code == 404
    assert (
        v1_client.patch(
            "/v1/speakers/foreign-speaker",
            headers=HEADERS,
            json={"speaker_status": "confirmed"},
        ).status_code
        == 404
    )


# ── schedule + taxonomies ────────────────────────────────────────────────────


def test_schedule_place_list_and_unschedule(v1_client, api_db):
    api_db.seed(
        "rooms",
        {
            "id": "room1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Main Hall",
            "capacity": 300,
        },
    )
    _seed_session(api_db, "schedule-me", 7)
    placed = v1_client.put(
        "/v1/sessions/schedule-me/schedule",
        headers=HEADERS,
        json={"room": "Main Hall", "start": "2026-09-14T17:00:00Z"},
    )
    assert placed.status_code == 200
    assert placed.json()["data"]["room"]["id"] == "room1"

    schedule = v1_client.get(f"/v1/events/{TEST_EVENT_ID}/schedule", headers=HEADERS)
    assert schedule.status_code == 200
    assert schedule.json()["data"]["sessions"][0]["id"] == "schedule-me"

    removed = v1_client.delete("/v1/sessions/schedule-me/schedule", headers=HEADERS)
    assert removed.status_code == 200
    assert removed.json()["data"]["starts_at"] is None
    assert removed.json()["data"]["room"] is None


def test_taxonomy_lists_are_paginated_and_cross_org_scoped(v1_client, api_db):
    for table in ("tracks", "formats", "rooms"):
        api_db.seed(
            table,
            {
                "id": f"{table}-1",
                "org_id": TEST_ORG_ID,
                "event_id": TEST_EVENT_ID,
                "name": f"First {table}",
            },
            {
                "id": f"{table}-2",
                "org_id": TEST_ORG_ID,
                "event_id": TEST_EVENT_ID,
                "name": f"Second {table}",
            },
        )
        response = v1_client.get(
            f"/v1/events/{TEST_EVENT_ID}/{table}",
            headers=HEADERS,
            params={"pageSize": 1},
        )
        assert response.status_code == 200
        assert response.json()["total"] == 2
        assert len(response.json()["data"]) == 1
        assert (
            v1_client.get(f"/v1/events/{OTHER_EVENT_ID}/{table}", headers=HEADERS).status_code
            == 404
        )


def test_schedule_session_cross_org_404(v1_client, api_db):
    api_db.seed(
        "sessions",
        {
            "id": "foreign-scheduled",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "title": "No peeking",
        },
    )
    assert (
        v1_client.delete("/v1/sessions/foreign-scheduled/schedule", headers=HEADERS).status_code
        == 404
    )


# ── content + evaluation summaries ───────────────────────────────────────────


def test_content_items_list_status_and_cross_org_404(v1_client, api_db):
    _seed_contact(api_db, "content-speaker")
    api_db.seed(
        "tasks",
        {
            "id": "headshot-task",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Headshot",
            "kind": "file_request",
            "required": True,
        },
    )
    api_db.seed(
        "task_assignments",
        {
            "id": "content-1",
            "org_id": TEST_ORG_ID,
            "task_id": "headshot-task",
            "contact_id": "content-speaker",
            "status": "todo",
            "file_id": None,
        },
    )
    response = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/content-items",
        headers=HEADERS,
        params={"status": "missing"},
    )
    assert response.status_code == 200
    assert response.json()["data"][0]["status"] == "missing"
    assert response.json()["meta"]["counts"]["missing"] == 1

    status = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/content-status", headers=HEADERS
    )
    assert status.status_code == 200
    assert status.json()["data"]["counts"]["missing"] == 1
    assert status.json()["data"]["outstanding"][0]["contact_id"] == "content-speaker"
    assert (
        v1_client.get(f"/v1/events/{OTHER_EVENT_ID}/content-items", headers=HEADERS).status_code
        == 404
    )


def test_evaluation_plan_list_summary_and_cross_org_404(v1_client, api_db):
    api_db.seed(
        "evaluation_plans",
        {
            "id": "plan-1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Program committee",
            "instructions": "",
            "anonymized": False,
            "scale": "1_5",
            "criteria": [{"name": "Quality", "weight": 100}],
            "status": "open",
            "session_filter": {},
        },
        {
            "id": "foreign-plan",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "name": "Private plan",
            "criteria": [],
            "status": "open",
        },
    )
    plans = v1_client.get(
        f"/v1/events/{TEST_EVENT_ID}/evaluation-plans", headers=HEADERS
    )
    assert plans.status_code == 200
    assert [plan["id"] for plan in plans.json()["data"]] == ["plan-1"]

    summary = v1_client.get("/v1/evaluation-plans/plan-1/summary", headers=HEADERS)
    assert summary.status_code == 200
    assert summary.json()["data"]["plan"]["id"] == "plan-1"
    assert summary.json()["data"]["assignment_count"] == 0
    assert (
        v1_client.get("/v1/evaluation-plans/foreign-plan/summary", headers=HEADERS).status_code
        == 404
    )


# ── org isolation ────────────────────────────────────────────────────────────


def test_key_cannot_read_another_orgs_event(v1_client, api_db):
    """A key for org_dev asking for OTHER_ORG's event gets a 404, not a leak."""
    assert (
        v1_client.get(f"/v1/events/{OTHER_EVENT_ID}/sessions", headers=HEADERS).status_code == 404
    )
    assert (
        v1_client.get(f"/v1/events/{OTHER_EVENT_ID}/contacts", headers=HEADERS).status_code == 404
    )


def test_other_orgs_key_cannot_read_this_orgs_event(v1_client, api_db):
    other = {"x-access-token": OTHER_KEY}
    assert v1_client.get(f"/v1/events/{TEST_EVENT_ID}/sessions", headers=other).status_code == 404


def test_sessions_never_leak_across_orgs_on_a_shared_event_id(v1_client, api_db):
    """Even if a foreign row somehow shares the event id, the org predicate hides it."""
    _seed_session(api_db, "mine", 1)
    api_db.seed(
        "sessions",
        {
            "id": "theirs",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "friendly_id_raw": 99,
            "friendly_id": "SESS-99",
            "title": "Not yours",
            "status": "accepted",
            "is_abstract": False,
        },
    )

    body = v1_client.get(f"/v1/events/{TEST_EVENT_ID}/sessions", headers=HEADERS).json()
    assert [s["id"] for s in body["data"]] == ["mine"]


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", f"/v1/events/{OTHER_EVENT_ID}", None),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/submissions", None),
        ("post", f"/v1/events/{OTHER_EVENT_ID}/submissions/search", {}),
        (
            "post",
            f"/v1/events/{OTHER_EVENT_ID}/submissions",
            {"title": "Private", "submitter_email": "private@example.com"},
        ),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/speakers", None),
        (
            "post",
            f"/v1/events/{OTHER_EVENT_ID}/speakers",
            {"email": "private@example.com"},
        ),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/schedule", None),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/tracks", None),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/formats", None),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/rooms", None),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/content-items", None),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/content-status", None),
        ("get", f"/v1/events/{OTHER_EVENT_ID}/evaluation-plans", None),
    ],
)
def test_every_event_scoped_endpoint_returns_cross_org_404(
    v1_client, api_db, method, path, payload
):
    response = v1_client.request(method.upper(), path, headers=HEADERS, json=payload)
    assert response.status_code == 404


def test_every_direct_resource_mutation_returns_cross_org_404(v1_client, api_db):
    api_db.seed(
        "sessions",
        {
            "id": "foreign-direct-session",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "title": "Private session",
            "status": "pending",
        },
    )
    api_db.seed(
        "contacts",
        {
            "id": "foreign-direct-speaker",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "email": "private@example.com",
        },
    )
    assert (
        v1_client.put(
            "/v1/sessions/foreign-direct-session/schedule",
            headers=HEADERS,
            json={"room": "Private", "start": "2026-09-14T17:00:00Z"},
        ).status_code
        == 404
    )
    assert (
        v1_client.delete(
            "/v1/sessions/foreign-direct-session/schedule", headers=HEADERS
        ).status_code
        == 404
    )
    assert (
        v1_client.get(
            "/v1/speakers/foreign-direct-speaker", headers=HEADERS
        ).status_code
        == 404
    )
