"""Tracks, rooms, formats, levels, tags.

One factory generates all twenty routes, so these tests aim at the factory:
what every kind must do identically (org scoping, ordering, delete safety) is
parametrized across all five, and only the per-kind columns are spelled out.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

KINDS = ("tracks", "rooms", "formats", "levels", "tags")
SINGULAR = {
    "tracks": "track",
    "rooms": "room",
    "formats": "format",
    "levels": "level",
    "tags": "tag",
}
SESSION_FK = {
    "tracks": "track_id",
    "rooms": "room_id",
    "formats": "format_id",
    "levels": "level_id",
}


def seed_item(db, kind: str, item_id: str, **overrides) -> dict:
    record = {
        "id": item_id,
        "org_id": TEST_ORG_ID,
        "event_id": TEST_EVENT_ID,
        "name": "Seeded",
        **overrides,
    }
    db.seed(kind, record)
    return record


# ── shape shared by every kind ─────────────────────────────────────────────


@pytest.mark.parametrize("kind", KINDS)
def test_requires_auth(client, kind):
    assert client.get(f"/api/events/{TEST_EVENT_ID}/{kind}").status_code == 401


@pytest.mark.parametrize("kind", KINDS)
def test_list_is_scoped_to_the_event_and_org(client, auth_headers, seeded_db, kind):
    seed_item(seeded_db, kind, "keep", name="Mine")
    seed_item(seeded_db, kind, "other-org", name="Theirs", org_id=OTHER_ORG_ID)
    seed_item(seeded_db, kind, "other-event", name="Elsewhere", event_id=OTHER_EVENT_ID)

    response = client.get(f"/api/events/{TEST_EVENT_ID}/{kind}", headers=auth_headers)

    assert response.status_code == 200
    assert [row["name"] for row in response.json()[kind]] == ["Mine"]


@pytest.mark.parametrize("kind", KINDS)
def test_list_on_a_foreign_event_404s(client, auth_headers, seeded_db, kind):
    seed_item(seeded_db, kind, "theirs", org_id=OTHER_ORG_ID, event_id=OTHER_EVENT_ID)
    response = client.get(f"/api/events/{OTHER_EVENT_ID}/{kind}", headers=auth_headers)
    assert response.status_code == 404


@pytest.mark.parametrize("kind", KINDS)
def test_create_takes_org_and_event_from_auth_and_path(client, auth_headers, seeded_db, kind):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/{kind}",
        headers=auth_headers,
        json={"name": "  Main Stage  ", "org_id": "org_injected"},
    )

    assert response.status_code == 201
    created = response.json()[SINGULAR[kind]]
    assert created["name"] == "Main Stage"
    assert created["org_id"] == TEST_ORG_ID
    assert created["event_id"] == TEST_EVENT_ID


@pytest.mark.parametrize("kind", KINDS)
def test_create_on_a_foreign_event_404s(client, auth_headers, seeded_db, kind):
    response = client.post(
        f"/api/events/{OTHER_EVENT_ID}/{kind}", headers=auth_headers, json={"name": "Nope"}
    )
    assert response.status_code == 404
    assert seeded_db.rows(kind) == []


@pytest.mark.parametrize("kind", KINDS)
def test_patch_renames(client, auth_headers, seeded_db, kind):
    seed_item(seeded_db, kind, "x1", name="Before")
    response = client.patch(f"/api/{kind}/x1", headers=auth_headers, json={"name": "After"})

    assert response.status_code == 200
    assert response.json()[SINGULAR[kind]]["name"] == "After"
    assert seeded_db.rows(kind)[0]["name"] == "After"


@pytest.mark.parametrize("kind", KINDS)
def test_patch_on_another_orgs_row_404s(client, auth_headers, seeded_db, kind):
    seed_item(seeded_db, kind, "x1", name="Theirs", org_id=OTHER_ORG_ID)
    response = client.patch(f"/api/{kind}/x1", headers=auth_headers, json={"name": "Mine now"})

    assert response.status_code == 404
    assert seeded_db.rows(kind)[0]["name"] == "Theirs"


@pytest.mark.parametrize("kind", KINDS)
def test_patch_with_nothing_to_change_400s(client, auth_headers, seeded_db, kind):
    seed_item(seeded_db, kind, "x1")
    assert client.patch(f"/api/{kind}/x1", headers=auth_headers, json={}).status_code == 400


@pytest.mark.parametrize("kind", KINDS)
def test_delete_removes_an_unused_row(client, auth_headers, seeded_db, kind):
    seed_item(seeded_db, kind, "x1")
    response = client.delete(f"/api/{kind}/x1", headers=auth_headers)

    assert response.status_code == 204
    assert response.content == b""
    assert seeded_db.rows(kind) == []


@pytest.mark.parametrize("kind", KINDS)
def test_delete_on_another_orgs_row_404s(client, auth_headers, seeded_db, kind):
    seed_item(seeded_db, kind, "x1", org_id=OTHER_ORG_ID)
    assert client.delete(f"/api/{kind}/x1", headers=auth_headers).status_code == 404
    assert len(seeded_db.rows(kind)) == 1


# ── ordering ───────────────────────────────────────────────────────────────


def test_list_orders_by_order_then_name(client, auth_headers, seeded_db):
    seed_item(seeded_db, "tracks", "t3", name="Zebra", order=0)
    seed_item(seeded_db, "tracks", "t1", name="Apples", order=0)
    seed_item(seeded_db, "tracks", "t2", name="Aardvark", order=1)

    body = client.get(f"/api/events/{TEST_EVENT_ID}/tracks", headers=auth_headers).json()
    assert [row["name"] for row in body["tracks"]] == ["Apples", "Zebra", "Aardvark"]


def test_kinds_without_an_order_column_sort_by_name(client, auth_headers, seeded_db):
    """formats/tags have no `order` in migration 001 — name is the whole sort."""
    seed_item(seeded_db, "formats", "f1", name="Workshop")
    seed_item(seeded_db, "formats", "f2", name="keynote")

    body = client.get(f"/api/events/{TEST_EVENT_ID}/formats", headers=auth_headers).json()
    assert [row["name"] for row in body["formats"]] == ["keynote", "Workshop"]


# ── per-kind columns ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "kind,payload,expected",
    [
        ("tracks", {"name": "Eng", "color": "#123456", "order": 2}, {"color": "#123456", "order": 2}),
        ("rooms", {"name": "Hall", "capacity": 400, "order": 1}, {"capacity": 400, "order": 1}),
        ("formats", {"name": "Talk", "default_duration_min": 30}, {"default_duration_min": 30}),
        ("levels", {"name": "Advanced", "order": 3}, {"order": 3}),
    ],
)
def test_create_accepts_the_columns_its_table_has(
    client, auth_headers, seeded_db, kind, payload, expected
):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/{kind}", headers=auth_headers, json=payload
    )
    assert response.status_code == 201
    created = response.json()[SINGULAR[kind]]
    for key, value in expected.items():
        assert created[key] == value


def test_create_drops_columns_the_table_does_not_have(client, auth_headers, seeded_db):
    """A colour on a room would be a Postgres error, not a feature request."""
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/rooms",
        headers=auth_headers,
        json={"name": "Hall", "color": "#ff0000", "default_duration_min": 30, "order": 1},
    )
    created = response.json()["room"]
    assert "color" not in created
    assert "default_duration_min" not in created
    assert created["order"] == 1


def test_create_drops_order_for_kinds_without_the_column(client, auth_headers, seeded_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/formats",
        headers=auth_headers,
        json={"name": "Talk", "order": 9},
    )
    assert "order" not in response.json()["format"]


def test_patch_updates_a_kind_specific_column(client, auth_headers, seeded_db):
    seed_item(seeded_db, "rooms", "r1", name="Hall", capacity=100)
    response = client.patch("/api/rooms/r1", headers=auth_headers, json={"capacity": 250})
    assert response.json()["room"]["capacity"] == 250


def test_patch_can_clear_a_nullable_column(client, auth_headers, seeded_db):
    """exclude_unset is what makes an explicit null different from an omission."""
    seed_item(seeded_db, "rooms", "r1", name="Hall", capacity=100)
    response = client.patch("/api/rooms/r1", headers=auth_headers, json={"capacity": None})
    assert response.status_code == 200
    assert response.json()["room"]["capacity"] is None


# ── delete safety ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("kind", tuple(SESSION_FK))
def test_delete_409s_while_a_session_still_points_at_it(client, auth_headers, seeded_db, kind):
    seed_item(seeded_db, kind, "x1")
    seeded_db.seed(
        "sessions",
        {
            "id": "s1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            SESSION_FK[kind]: "x1",
        },
    )

    response = client.delete(f"/api/{kind}/x1", headers=auth_headers)

    assert response.status_code == 409
    assert "in use" in response.json()["detail"]
    assert len(seeded_db.rows(kind)) == 1


def test_deleting_a_tag_409s_while_session_tags_reference_it(client, auth_headers, seeded_db):
    seed_item(seeded_db, "tags", "tag1")
    seeded_db.seed("session_tags", {"session_id": "s1", "tag_id": "tag1"})

    response = client.delete("/api/tags/tag1", headers=auth_headers)

    assert response.status_code == 409
    assert "in use" in response.json()["detail"]


def test_delete_ignores_another_orgs_session_pointing_at_the_same_id(
    client, auth_headers, seeded_db
):
    """The usage check carries the org predicate like every other query."""
    seed_item(seeded_db, "tracks", "t1")
    seeded_db.seed(
        "sessions",
        {"id": "s1", "org_id": OTHER_ORG_ID, "event_id": OTHER_EVENT_ID, "track_id": "t1"},
    )

    assert client.delete("/api/tracks/t1", headers=auth_headers).status_code == 204
