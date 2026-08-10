"""Airtable config secrecy, tenancy, schema fallback, and batched upserts."""

from __future__ import annotations

from typing import Any, Self

import pytest

from services import airtable_sync
from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID, make_token


class FakeAirtable:
    def __init__(
        self,
        _token: str,
        _base_id: str,
        *,
        deny_create: bool = False,
        existing: dict[str, list[dict[str, Any]]] | None = None,
    ):
        self.deny_create = deny_create
        self.existing = existing or {}
        self.created_tables: list[str] = []
        self.list_table_calls = 0
        self.create_batches: list[tuple[str, list[dict[str, Any]]]] = []
        self.update_batches: list[tuple[str, list[dict[str, Any]]]] = []
        self.formulas: list[tuple[str, str]] = []

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def create_table(self, name: str, _fields: list[dict[str, Any]]) -> dict:
        self.created_tables.append(name)
        if self.deny_create:
            raise airtable_sync.AirtableHttpError(403, "forbidden")
        return {"id": f"tbl-{name.lower()}", "name": name}

    async def list_tables(self) -> list[dict]:
        self.list_table_calls += 1
        return [
            {
                "id": f"existing-{name.lower()}",
                "name": name,
                "fields": [{"name": field} for field in fields],
            }
            for name, fields in airtable_sync.TABLE_FIELDS.items()
        ]

    async def list_records(self, table_id: str, formula: str) -> list[dict]:
        self.formulas.append((table_id, formula))
        return list(self.existing.get(table_id, []))

    async def create_records(self, table_id: str, records: list[dict]) -> None:
        self.create_batches.append((table_id, records))

    async def update_records(self, table_id: str, records: list[dict]) -> None:
        self.update_batches.append((table_id, records))


def _seed_config(fake_db, *, org_id: str = TEST_ORG_ID, token: str = "pat-secret-token"):
    fake_db.seed(
        "org_integrations",
        {
            "org_id": org_id,
            "kind": "airtable",
            "config": {
                "token": token,
                "base_id": "app-test-base",
                "enabled": True,
                "last_synced_at": None,
            },
        },
    )


def test_config_round_trip_never_echoes_token(client, fake_db, auth_headers):
    raw_token = "pat-this-must-never-come-back"
    saved = client.put(
        "/api/integrations/airtable",
        headers=auth_headers,
        json={"token": raw_token, "base_id": "app-round-trip", "enabled": True},
    )

    assert saved.status_code == 200
    assert raw_token not in saved.text
    assert "token" not in saved.json()
    assert saved.json() == {
        "enabled": True,
        "base_id": "app-round-trip",
        "has_token": True,
        "token_hint": "••••back",
        "configured": True,
        "last_synced_at": None,
        "source": "database",
    }

    fetched = client.get("/api/integrations/airtable", headers=auth_headers)
    assert fetched.status_code == 200
    assert raw_token not in fetched.text
    assert fetched.json()["token_hint"] == "••••back"
    stored = fake_db.rows("org_integrations")[0]["config"]
    assert stored["token"] == raw_token


def test_config_is_scoped_to_the_authenticated_org(client, fake_db, auth_headers):
    _seed_config(fake_db, token="pat-ours-secret")
    _seed_config(fake_db, org_id=OTHER_ORG_ID, token="pat-theirs-secret")

    ours = client.get("/api/integrations/airtable", headers=auth_headers).json()
    theirs = client.get(
        "/api/integrations/airtable",
        headers={"Authorization": f"Bearer {make_token(org_id=OTHER_ORG_ID)}"},
    ).json()

    assert ours["token_hint"] == "••••cret"
    assert theirs["token_hint"] == "••••cret"
    assert ours["base_id"] == "app-test-base"
    # Updating ours must not overwrite the other org's row.
    client.put(
        "/api/integrations/airtable",
        headers=auth_headers,
        json={"base_id": "app-ours-only", "enabled": False},
    )
    other = next(row for row in fake_db.rows("org_integrations") if row["org_id"] == OTHER_ORG_ID)
    assert other["config"]["base_id"] == "app-test-base"


@pytest.mark.asyncio
async def test_demo_org_uses_env_fallback_only_when_no_database_row(fake_db, monkeypatch):
    monkeypatch.setenv("AIRTABLE_API_KEY", "pat-env-secret-token")
    monkeypatch.setenv("AIRTABLE_BASE_ID", "app-env-base")

    config = await airtable_sync.get_public_config(TEST_ORG_ID)

    assert config == {
        "enabled": True,
        "base_id": "app-env-base",
        "has_token": True,
        "token_hint": "••••oken",
        "configured": True,
        "last_synced_at": None,
        "source": "environment",
    }
    # The fallback is deliberately demo-only, never a cross-org default.
    assert (await airtable_sync.get_public_config(OTHER_ORG_ID))["configured"] is False


@pytest.mark.asyncio
async def test_upsert_takes_create_and_update_paths_in_batches_of_ten():
    existing = {
        "tbl-speakers": [
            {"id": "rec-existing", "fields": {"Email": "speaker-0@example.com"}}
        ]
    }
    fake = FakeAirtable("token", "base", existing=existing)
    records = [
        {"Email": f"speaker-{index}@example.com", "Name": f"Speaker {index}"}
        for index in range(23)
    ]

    result = await airtable_sync.upsert_table(
        fake,
        "tbl-speakers",
        key_field="Email",
        records=records,
    )

    # The fake returns speaker-0 as existing for each filter; only the first
    # chunk contains that key, so exactly one update and 22 creates occur.
    assert result == {"created": 22, "updated": 1}
    assert [len(batch) for _table, batch in fake.create_batches] == [9, 10, 3]
    assert [len(batch) for _table, batch in fake.update_batches] == [1]
    assert all(len(batch) <= 10 for _table, batch in fake.create_batches + fake.update_batches)
    assert len(fake.formulas) == 3
    assert fake.formulas[0][1].startswith("OR(")


@pytest.mark.asyncio
async def test_schema_write_403_falls_back_to_existing_tables():
    fake = FakeAirtable("token", "base", deny_create=True)

    resolved = await airtable_sync.ensure_tables(fake)

    assert fake.created_tables == ["Speakers"]
    assert fake.list_table_calls == 1
    assert resolved == {
        "Speakers": "existing-speakers",
        "Submissions": "existing-submissions",
    }


@pytest.mark.asyncio
async def test_schema_fallback_error_lists_exact_setup(monkeypatch):
    fake = FakeAirtable("token", "base", deny_create=True)

    async def missing_tables():
        return []

    monkeypatch.setattr(fake, "list_tables", missing_tables)
    with pytest.raises(airtable_sync.AirtableSetupError) as exc_info:
        await airtable_sync.ensure_tables(fake)

    message = str(exc_info.value)
    assert "Speakers: Name, Email, Company, Title, Status, Sessions count" in message
    assert "Submissions: Friendly ID, Title, Submitter, Track, Status, Review score" in message
    assert "schema.bases:write" in message
    assert "schema.bases:read" in message


@pytest.mark.asyncio
async def test_sync_maps_org_data_and_updates_last_synced(fake_db):
    _seed_config(fake_db)
    fake_db.seed(
        "contacts",
        {
            "id": "contact-1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "ada@example.com",
            "first_name": "Ada",
            "last_name": "Lovelace",
            "company_name": "Analytical Engines",
            "title": "Founder",
            "speaker_status": "confirmed",
        },
        {
            "id": "foreign-contact",
            "org_id": OTHER_ORG_ID,
            "email": "foreign@example.com",
        },
    )
    fake_db.seed(
        "tracks",
        {"id": "track-1", "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Systems"},
    )
    fake_db.seed(
        "sessions",
        {
            "id": "session-1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "friendly_id": "SESS-42",
            "title": "Mechanical computation",
            "status": "accepted",
            "track_id": "track-1",
            "submitter_contact_id": "contact-1",
        },
        {
            "id": "foreign-session",
            "org_id": OTHER_ORG_ID,
            "friendly_id": "SESS-99",
            "title": "Not ours",
        },
    )
    fake_db.seed(
        "session_participants",
        {
            "id": "participant-1",
            "org_id": TEST_ORG_ID,
            "session_id": "session-1",
            "contact_id": "contact-1",
            "role": "speaker",
        },
    )
    holder: dict[str, FakeAirtable] = {}

    def factory(token: str, base_id: str) -> FakeAirtable:
        holder["client"] = FakeAirtable(token, base_id)
        return holder["client"]

    result = await airtable_sync.sync_org(TEST_ORG_ID, client_factory=factory)

    assert result["tables"] == {
        "Speakers": {"created": 1, "updated": 0},
        "Submissions": {"created": 1, "updated": 0},
    }
    written = [record for _table, batch in holder["client"].create_batches for record in batch]
    assert any(record.get("Email") == "ada@example.com" and record["Sessions count"] == 1 for record in written)
    assert any(record.get("Friendly ID") == "SESS-42" and record["Track"] == "Systems" for record in written)
    assert all("foreign@example.com" not in record.values() for record in written)
    assert fake_db.rows("org_integrations")[0]["config"]["last_synced_at"] == result["last_synced_at"]
