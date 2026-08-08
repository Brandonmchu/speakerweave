"""The field library."""

from __future__ import annotations

import pytest

from services.slugs import dedupe_name
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID


def seed_field(db, field_id: str, **overrides) -> dict:
    record = {
        "id": field_id,
        "org_id": TEST_ORG_ID,
        "event_id": TEST_EVENT_ID,
        "scope": "session",
        "internal_name": field_id,
        "public_name": field_id.title(),
        "field_type": "text",
        "options": {},
        "required": False,
        "created_at": f"2026-08-0{len(db.rows('fields')) + 1}T00:00:00+00:00",
        **overrides,
    }
    db.seed("fields", record)
    return record


def test_list_requires_auth(client):
    assert client.get(f"/api/events/{TEST_EVENT_ID}/fields").status_code == 401


def test_list_returns_event_and_org_global_fields(client, auth_headers, seeded_db):
    """event_id null means org-global — every event may use it."""
    seed_field(seeded_db, "abstract")
    seed_field(seeded_db, "global_bio", event_id=None)
    seed_field(seeded_db, "elsewhere", event_id=OTHER_EVENT_ID)
    seed_field(seeded_db, "theirs", org_id=OTHER_ORG_ID)

    body = client.get(f"/api/events/{TEST_EVENT_ID}/fields", headers=auth_headers).json()

    assert {field["id"] for field in body["fields"]} == {"abstract", "global_bio"}


def test_list_filters_by_scope(client, auth_headers, seeded_db):
    seed_field(seeded_db, "abstract", scope="session")
    seed_field(seeded_db, "bio", scope="contact")

    body = client.get(
        f"/api/events/{TEST_EVENT_ID}/fields?scope=contact", headers=auth_headers
    ).json()

    assert [field["id"] for field in body["fields"]] == ["bio"]


def test_list_rejects_an_unknown_scope(client, auth_headers, seeded_db):
    response = client.get(f"/api/events/{TEST_EVENT_ID}/fields?scope=alien", headers=auth_headers)
    assert response.status_code == 400


def test_list_on_a_foreign_event_404s(client, auth_headers, seeded_db):
    assert (
        client.get(f"/api/events/{OTHER_EVENT_ID}/fields", headers=auth_headers).status_code == 404
    )


def test_create_derives_an_internal_name(client, auth_headers, seeded_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/fields",
        headers=auth_headers,
        json={
            "scope": "session",
            "public_name": "Key Takeaways!",
            "field_type": "textarea",
            "options": {"max_length": 1000},
            "required": True,
        },
    )

    assert response.status_code == 201
    field = response.json()["field"]
    assert field["internal_name"] == "key_takeaways"
    assert field["public_name"] == "Key Takeaways!"
    assert field["org_id"] == TEST_ORG_ID
    assert field["event_id"] == TEST_EVENT_ID
    assert field["options"] == {"max_length": 1000}
    assert field["required"] is True


def test_create_dedupes_a_taken_internal_name(client, auth_headers, seeded_db):
    seed_field(seeded_db, "existing", internal_name="key_takeaways")

    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/fields",
        headers=auth_headers,
        json={"scope": "session", "public_name": "Key takeaways", "field_type": "text"},
    )

    assert response.json()["field"]["internal_name"] == "key_takeaways_2"


@pytest.mark.parametrize("field_type", ["text", "checkbox", "multi_select", "divider"])
def test_create_accepts_every_type_the_schema_allows(client, auth_headers, seeded_db, field_type):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/fields",
        headers=auth_headers,
        json={"scope": "session", "public_name": "X", "field_type": field_type},
    )
    assert response.status_code == 201


def test_create_rejects_a_type_the_check_constraint_would(client, auth_headers, seeded_db):
    """A 400 naming the problem beats a 500 from a CHECK violation."""
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/fields",
        headers=auth_headers,
        json={"scope": "session", "public_name": "X", "field_type": "signature"},
    )
    assert response.status_code == 400
    assert "signature" in response.json()["detail"]
    assert seeded_db.rows("fields") == []


def test_create_rejects_an_unknown_scope(client, auth_headers, seeded_db):
    response = client.post(
        f"/api/events/{TEST_EVENT_ID}/fields",
        headers=auth_headers,
        json={"scope": "session_or_something", "public_name": "X", "field_type": "text"},
    )
    assert response.status_code == 400


def test_create_on_a_foreign_event_404s(client, auth_headers, seeded_db):
    response = client.post(
        f"/api/events/{OTHER_EVENT_ID}/fields",
        headers=auth_headers,
        json={"scope": "session", "public_name": "X", "field_type": "text"},
    )
    assert response.status_code == 404


def test_patch_renames_and_reoptions(client, auth_headers, seeded_db):
    seed_field(seeded_db, "abstract", public_name="Abstract")

    response = client.patch(
        "/api/fields/abstract",
        headers=auth_headers,
        json={"public_name": "  Session abstract  ", "options": {"max_length": 500}},
    )

    assert response.status_code == 200
    field = response.json()["field"]
    assert field["public_name"] == "Session abstract"
    assert field["options"] == {"max_length": 500}
    # identity is stable: answers are keyed by id, and internal_name is a key
    assert field["internal_name"] == "abstract"


def test_patch_refuses_to_change_the_type(client, auth_headers, seeded_db):
    """Every stored answer was shaped by the old type."""
    seed_field(seeded_db, "abstract", field_type="textarea")

    response = client.patch(
        "/api/fields/abstract", headers=auth_headers, json={"field_type": "number"}
    )

    assert response.status_code == 400
    assert "cannot be changed" in response.json()["detail"]
    assert seeded_db.rows("fields")[0]["field_type"] == "textarea"


def test_patch_on_another_orgs_field_404s(client, auth_headers, seeded_db):
    seed_field(seeded_db, "abstract", org_id=OTHER_ORG_ID, public_name="Theirs")
    response = client.patch(
        "/api/fields/abstract", headers=auth_headers, json={"public_name": "Mine"}
    )
    assert response.status_code == 404
    assert seeded_db.rows("fields")[0]["public_name"] == "Theirs"


def test_patch_with_nothing_to_change_400s(client, auth_headers, seeded_db):
    seed_field(seeded_db, "abstract")
    assert client.patch("/api/fields/abstract", headers=auth_headers, json={}).status_code == 400


@pytest.mark.parametrize(
    "base,taken,expected",
    [
        ("bio", set(), "bio"),
        ("bio", {"bio"}, "bio_2"),
        ("bio", {"bio", "bio_2"}, "bio_3"),
        ("bio", {"other"}, "bio"),
    ],
)
def test_dedupe_name(base, taken, expected):
    assert dedupe_name(base, taken) == expected
