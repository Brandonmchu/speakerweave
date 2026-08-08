"""The public, read-only ``/v1`` API.

Exercises the Sessionboard-shaped contract: ``x-access-token`` auth, the
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
    assert set(events[0]) == {"id", "name", "slug", "starts_at", "ends_at", "timezone"}


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
