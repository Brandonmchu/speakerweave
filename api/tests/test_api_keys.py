"""API-key minting/resolution and the organizer token-management routes.

Two surfaces meet here:

* ``services.api_keys`` — the hash-only store and the resolve-then-touch read.
* ``routes.api_key_admin_routes`` — the JWT-authed ``/api/api-tokens`` CRUD that
  lets an org create/list/revoke keys (the raw key shown exactly once).
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import api_keys
from services.magic_links import hash_token
from tests.conftest import OTHER_ORG_ID, TEST_ORG_ID


def _seed_key(fake_db, raw: str, *, org_id: str = TEST_ORG_ID, scopes=("read",), **overrides) -> dict:
    record = {
        "id": f"tok-{len(fake_db.rows('api_tokens')) + 1}",
        "org_id": org_id,
        "name": "CI token",
        "token_hash": hash_token(raw),
        "scopes": list(scopes),
        "created_at": "2026-08-01T00:00:00+00:00",
        "last_used_at": None,
        **overrides,
    }
    fake_db.seed("api_tokens", record)
    return record


@pytest.fixture
def admin_client():
    from routes.api_key_admin_routes import router

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


# ── services.api_keys ────────────────────────────────────────────────────────


async def test_mint_returns_prefixed_raw_and_stores_only_the_hash(fake_db):
    raw = await api_keys.mint_api_key(TEST_ORG_ID, "My integration")

    assert raw.startswith("dais_")
    row = fake_db.rows("api_tokens")[0]
    assert row["org_id"] == TEST_ORG_ID
    assert row["name"] == "My integration"
    assert row["scopes"] == ["read"]
    # Only the hash is persisted — the raw key appears in no column.
    assert row["token_hash"] == hash_token(raw)
    assert raw not in row.values()


async def test_mint_blank_name_falls_back(fake_db):
    await api_keys.mint_api_key(TEST_ORG_ID, "   ")
    assert fake_db.rows("api_tokens")[0]["name"] == "API token"


async def test_resolve_returns_org_and_scopes_and_stamps_last_used(fake_db):
    _seed_key(fake_db, "dais_livekey", scopes=("read",))

    resolved = await api_keys.resolve_api_key("dais_livekey")

    assert resolved == (TEST_ORG_ID, ["read"])
    assert fake_db.rows("api_tokens")[0]["last_used_at"] is not None


async def test_resolve_rejects_unknown_and_malformed_keys(fake_db):
    _seed_key(fake_db, "dais_realkey")

    assert await api_keys.resolve_api_key("dais_wrongkey") is None
    assert await api_keys.resolve_api_key("not-a-dais-key") is None
    assert await api_keys.resolve_api_key("") is None
    assert await api_keys.resolve_api_key(None) is None


async def test_mint_then_resolve_round_trip(fake_db):
    raw = await api_keys.mint_api_key(TEST_ORG_ID, "round-trip")
    assert await api_keys.resolve_api_key(raw) == (TEST_ORG_ID, ["read"])


# ── /api/api-tokens (organizer JWT surface) ──────────────────────────────────


def test_create_requires_jwt(admin_client, fake_db):
    assert admin_client.post("/api/api-tokens", json={"name": "x"}).status_code == 401


def test_create_returns_the_raw_token_once_and_persists_a_hash(
    admin_client, auth_headers, seeded_db
):
    response = admin_client.post(
        "/api/api-tokens", headers=auth_headers, json={"name": "Zapier"}
    )

    assert response.status_code == 201
    body = response.json()
    assert body["token"].startswith("dais_")
    assert body["name"] == "Zapier"

    row = seeded_db.rows("api_tokens")[0]
    assert row["org_id"] == TEST_ORG_ID
    assert row["token_hash"] == hash_token(body["token"])
    # The raw secret is never stored.
    assert body["token"] not in row.values()


def test_list_returns_metadata_without_the_secret(admin_client, auth_headers, seeded_db):
    _seed_key(seeded_db, "dais_one", last_used_at="2026-08-05T00:00:00+00:00")

    response = admin_client.get("/api/api-tokens", headers=auth_headers)

    assert response.status_code == 200
    tokens = response.json()["tokens"]
    assert len(tokens) == 1
    token = tokens[0]
    assert set(token) == {"id", "name", "scopes", "created_at", "last_used_at"}
    assert "token_hash" not in token
    assert token["last_used_at"] == "2026-08-05T00:00:00+00:00"


def test_list_is_org_scoped(admin_client, auth_headers, seeded_db):
    _seed_key(seeded_db, "dais_mine")
    _seed_key(seeded_db, "dais_theirs", org_id=OTHER_ORG_ID)

    tokens = admin_client.get("/api/api-tokens", headers=auth_headers).json()["tokens"]
    assert [t["name"] for t in tokens] == ["CI token"]
    assert len(tokens) == 1


def test_delete_revokes_own_token(admin_client, auth_headers, seeded_db):
    _seed_key(seeded_db, "dais_kill", id="tok-kill")

    response = admin_client.delete("/api/api-tokens/tok-kill", headers=auth_headers)

    assert response.status_code == 204
    assert seeded_db.rows("api_tokens") == []


def test_delete_on_another_orgs_token_404s(admin_client, auth_headers, seeded_db):
    _seed_key(seeded_db, "dais_foreign", id="tok-foreign", org_id=OTHER_ORG_ID)

    response = admin_client.delete("/api/api-tokens/tok-foreign", headers=auth_headers)

    assert response.status_code == 404
    assert len(seeded_db.rows("api_tokens")) == 1
