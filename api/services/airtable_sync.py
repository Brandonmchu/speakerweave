"""Organization-scoped Airtable configuration and conference-data sync.

The database client is a Supabase service-role client, so every query in this
module includes ``org_id``. Airtable HTTP is isolated behind :class:`AirtableClient`:
tests inject a fake and never need a network connection.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, Self
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from services import evaluations
from services.speaker_crm import full_name
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

AIRTABLE_KIND = "airtable"
AIRTABLE_API_URL = "https://api.airtable.com"
AIRTABLE_BATCH_SIZE = 10

TABLE_FIELDS: dict[str, tuple[str, ...]] = {
    "Speakers": ("Name", "Email", "Company", "Title", "Status", "Sessions count"),
    "Submissions": (
        "Friendly ID",
        "Title",
        "Submitter",
        "Track",
        "Status",
        "Review score",
    ),
}

TABLE_SCHEMAS: dict[str, list[dict[str, Any]]] = {
    "Speakers": [
        {"name": "Name", "type": "singleLineText"},
        {"name": "Email", "type": "email"},
        {"name": "Company", "type": "singleLineText"},
        {"name": "Title", "type": "singleLineText"},
        {"name": "Status", "type": "singleLineText"},
        {"name": "Sessions count", "type": "number", "options": {"precision": 0}},
    ],
    "Submissions": [
        {"name": "Friendly ID", "type": "singleLineText"},
        {"name": "Title", "type": "singleLineText"},
        {"name": "Submitter", "type": "singleLineText"},
        {"name": "Track", "type": "singleLineText"},
        {"name": "Status", "type": "singleLineText"},
        {"name": "Review score", "type": "number", "options": {"precision": 2}},
    ],
}


class AirtableHttpError(RuntimeError):
    """A non-success response from Airtable, retaining its status for fallback."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class AirtableSetupError(RuntimeError):
    """Configuration/schema problem whose full text is safe for the organizer."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _mask_token(token: str | None) -> str | None:
    if not token:
        return None
    # A short test token should not be recoverable from its "hint".
    return "••••" if len(token) <= 8 else f"••••{token[-4:]}"


def _safe_config(config: dict[str, Any], *, source: str | None) -> dict[str, Any]:
    token = str(config.get("token") or "")
    base_id = str(config.get("base_id") or "")
    enabled = bool(config.get("enabled", False))
    return {
        "enabled": enabled,
        "base_id": base_id or None,
        "has_token": bool(token),
        "token_hint": _mask_token(token),
        "configured": bool(token and base_id),
        "last_synced_at": config.get("last_synced_at"),
        "source": source,
    }


async def _stored_config(org_id: str) -> dict[str, Any] | None:
    row = first(
        await db(
            lambda: supabase.table("org_integrations")
            .select("config")
            .eq("org_id", org_id)
            .eq("kind", AIRTABLE_KIND)
            .limit(1)
            .execute(),
            "airtable_config_get",
        )
    )
    if not row:
        return None
    config = row.get("config")
    return dict(config) if isinstance(config, dict) else {}


def _env_config(org_id: str) -> dict[str, Any] | None:
    if org_id != "org_dev":
        return None
    token = (os.getenv("AIRTABLE_API_KEY") or "").strip()
    base_id = (os.getenv("AIRTABLE_BASE_ID") or "").strip()
    if not token and not base_id:
        return None
    return {
        "token": token,
        "base_id": base_id,
        "enabled": True,
        "last_synced_at": None,
    }


async def get_config(org_id: str) -> tuple[dict[str, Any], str | None]:
    """Return the effective secret-bearing config and where it came from."""
    stored = await _stored_config(org_id)
    if stored is not None:
        return stored, "database"
    fallback = _env_config(org_id)
    return (fallback or {}), ("environment" if fallback else None)


async def get_public_config(org_id: str) -> dict[str, Any]:
    config, source = await get_config(org_id)
    return _safe_config(config, source=source)


async def save_config(
    org_id: str,
    *,
    token: str | None,
    base_id: str,
    enabled: bool,
) -> dict[str, Any]:
    """Upsert one org's config. An omitted/blank token preserves the old secret."""
    existing, _source = await get_config(org_id)
    next_config = {
        "token": (token or "").strip() or str(existing.get("token") or ""),
        "base_id": base_id.strip(),
        "enabled": enabled,
        "last_synced_at": existing.get("last_synced_at"),
    }
    updated_at = _now_iso()
    await db(
        lambda: supabase.table("org_integrations")
        .upsert(
            {
                "org_id": org_id,
                "kind": AIRTABLE_KIND,
                "provider": AIRTABLE_KIND,
                "config": next_config,
                "updated_at": updated_at,
            },
            on_conflict="org_id,kind",
        )
        .execute(),
        "airtable_config_upsert",
    )
    return _safe_config(next_config, source="database")


async def _store_last_synced(org_id: str, config: dict[str, Any], synced_at: str) -> None:
    next_config = {**config, "last_synced_at": synced_at}
    await db(
        lambda: supabase.table("org_integrations")
        .upsert(
            {
                "org_id": org_id,
                "kind": AIRTABLE_KIND,
                "provider": AIRTABLE_KIND,
                "config": next_config,
                "updated_at": synced_at,
            },
            on_conflict="org_id,kind",
        )
        .execute(),
        "airtable_sync_timestamp",
    )


class AirtableClient:
    """Small async Airtable client with bounded timeouts and batch-size checks."""

    def __init__(self, token: str, base_id: str):
        self.base_id = base_id
        self._client = httpx.AsyncClient(
            base_url=AIRTABLE_API_URL,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=httpx.Timeout(10.0, connect=3.0),
        )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise AirtableHttpError(502, f"Could not reach Airtable: {exc}") from exc
        if response.is_error:
            try:
                payload = response.json()
            except ValueError:
                payload = response.text
            detail = payload.get("error") if isinstance(payload, dict) else payload
            if isinstance(detail, dict):
                detail = detail.get("message") or detail.get("type") or detail
            raise AirtableHttpError(
                response.status_code,
                f"Airtable API returned {response.status_code}: {detail}",
            )
        if response.status_code == 204:
            return {}
        return response.json()

    async def create_table(self, name: str, fields: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/v0/meta/bases/{quote(self.base_id, safe='')}/tables",
            json={"name": name, "fields": fields},
        )

    async def list_tables(self) -> list[dict[str, Any]]:
        payload = await self._request(
            "GET", f"/v0/meta/bases/{quote(self.base_id, safe='')}/tables"
        )
        return list(payload.get("tables") or [])

    async def list_records(self, table_id: str, formula: str) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        offset: str | None = None
        while True:
            params = {"filterByFormula": formula, "pageSize": 100}
            if offset:
                params["offset"] = offset
            payload = await self._request(
                "GET",
                f"/v0/{quote(self.base_id, safe='')}/{quote(table_id, safe='')}",
                params=params,
            )
            records.extend(payload.get("records") or [])
            offset = payload.get("offset")
            if not offset:
                return records

    async def create_records(self, table_id: str, records: list[dict[str, Any]]) -> None:
        if len(records) > AIRTABLE_BATCH_SIZE:
            raise ValueError("Airtable batches may contain at most 10 records")
        await self._request(
            "POST",
            f"/v0/{quote(self.base_id, safe='')}/{quote(table_id, safe='')}",
            json={"records": [{"fields": record} for record in records], "typecast": True},
        )

    async def update_records(self, table_id: str, records: list[dict[str, Any]]) -> None:
        if len(records) > AIRTABLE_BATCH_SIZE:
            raise ValueError("Airtable batches may contain at most 10 records")
        await self._request(
            "PATCH",
            f"/v0/{quote(self.base_id, safe='')}/{quote(table_id, safe='')}",
            json={"records": records, "typecast": True},
        )


def _setup_instructions() -> str:
    lines = ["Airtable setup is incomplete. Create these exact tables and fields:"]
    for table_name, fields in TABLE_FIELDS.items():
        lines.append(f"- {table_name}: {', '.join(fields)}")
    lines.append(
        "Or add the schema.bases:write scope so SpeakerWeave can create them; "
        "add schema.bases:read so it can discover existing tables."
    )
    return "\n".join(lines)


def _validate_tables(tables: list[dict[str, Any]]) -> dict[str, str]:
    by_name = {str(table.get("name")): table for table in tables}
    resolved: dict[str, str] = {}
    for name, required_fields in TABLE_FIELDS.items():
        table = by_name.get(name)
        if not table:
            raise AirtableSetupError(_setup_instructions())
        actual_fields = {str(field.get("name")) for field in table.get("fields") or []}
        if set(required_fields) - actual_fields:
            raise AirtableSetupError(_setup_instructions())
        resolved[name] = str(table.get("id") or name)
    return resolved


async def ensure_tables(client: Any) -> dict[str, str]:
    """Create both schemas, falling back to meta discovery when creation is denied."""
    created: dict[str, str] = {}
    needs_discovery = False
    for name, fields in TABLE_SCHEMAS.items():
        try:
            table = await client.create_table(name, fields)
            created[name] = str(table.get("id") or name)
        except AirtableHttpError as exc:
            # 403 is the documented BYO-token path. 422 commonly means the
            # table already exists, which is equally safe to discover.
            if exc.status_code not in {403, 422}:
                raise
            needs_discovery = True
            break
    if not needs_discovery and len(created) == len(TABLE_SCHEMAS):
        return created
    try:
        return _validate_tables(await client.list_tables())
    except AirtableHttpError as exc:
        if exc.status_code == 403:
            raise AirtableSetupError(_setup_instructions()) from exc
        raise


def _chunks(items: list[dict[str, Any]], size: int = AIRTABLE_BATCH_SIZE):
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _formula_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _match_formula(key_field: str, values: list[str]) -> str:
    matches = [f'{{{key_field}}}="{_formula_value(value)}"' for value in values]
    return matches[0] if len(matches) == 1 else f"OR({','.join(matches)})"


async def upsert_table(
    client: Any,
    table_id: str,
    *,
    key_field: str,
    records: list[dict[str, Any]],
) -> dict[str, int]:
    """Upsert by a stable Airtable field, with every write capped at 10 rows."""
    created_count = 0
    updated_count = 0
    for batch in _chunks(records):
        keyed = [record for record in batch if str(record.get(key_field) or "").strip()]
        if not keyed:
            continue
        keys = [str(record[key_field]) for record in keyed]
        existing = await client.list_records(table_id, _match_formula(key_field, keys))
        existing_by_key = {
            str((record.get("fields") or {}).get(key_field)): str(record.get("id"))
            for record in existing
            if record.get("id") and (record.get("fields") or {}).get(key_field) is not None
        }
        creates: list[dict[str, Any]] = []
        updates: list[dict[str, Any]] = []
        for record in keyed:
            record_id = existing_by_key.get(str(record[key_field]))
            if record_id:
                updates.append({"id": record_id, "fields": record})
            else:
                creates.append(record)
        if creates:
            await client.create_records(table_id, creates)
            created_count += len(creates)
        if updates:
            await client.update_records(table_id, updates)
            updated_count += len(updates)
    return {"created": created_count, "updated": updated_count}


async def _sync_records(org_id: str) -> dict[str, list[dict[str, Any]]]:
    contacts = rows(
        await db(
            lambda: supabase.table("contacts").select("*").eq("org_id", org_id).execute(),
            "airtable_contacts",
        )
    )
    sessions = rows(
        await db(
            lambda: supabase.table("sessions").select("*").eq("org_id", org_id).execute(),
            "airtable_sessions",
        )
    )
    session_ids = [str(row["id"]) for row in sessions if row.get("id")]
    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("session_id, contact_id, role")
            .eq("org_id", org_id)
            .execute(),
            "airtable_participants",
        )
    )
    tracks = rows(
        await db(
            lambda: supabase.table("tracks").select("id, name").eq("org_id", org_id).execute(),
            "airtable_tracks",
        )
    )
    review_scores = await evaluations.session_review_scores(org_id, session_ids)

    contact_by_id = {str(row.get("id")): row for row in contacts if row.get("id")}
    track_by_id = {str(row.get("id")): row for row in tracks if row.get("id")}
    session_count: dict[str, int] = {}
    for participant in participants:
        if participant.get("role") != "speaker" or not participant.get("contact_id"):
            continue
        contact_id = str(participant["contact_id"])
        session_count[contact_id] = session_count.get(contact_id, 0) + 1

    speaker_records = [
        {
            "Name": full_name(row.get("first_name"), row.get("last_name"), row.get("email")),
            "Email": str(row.get("email") or ""),
            "Company": str(row.get("company_name") or ""),
            "Title": str(row.get("title") or ""),
            "Status": str(row.get("speaker_status") or ""),
            "Sessions count": session_count.get(str(row.get("id")), 0),
        }
        for row in contacts
        if row.get("email")
    ]
    submission_records: list[dict[str, Any]] = []
    for row in sessions:
        submitter = contact_by_id.get(str(row.get("submitter_contact_id")))
        track = track_by_id.get(str(row.get("track_id")))
        score = review_scores.get(str(row.get("id")), {}).get("review_score")
        submission_records.append(
            {
                "Friendly ID": str(row.get("friendly_id") or ""),
                "Title": str(row.get("title") or ""),
                "Submitter": (
                    full_name(
                        submitter.get("first_name"),
                        submitter.get("last_name"),
                        submitter.get("email"),
                    )
                    if submitter
                    else ""
                ),
                "Track": str(track.get("name") or "") if track else "",
                "Status": str(row.get("status") or ""),
                "Review score": score,
            }
        )

    speaker_records.sort(key=lambda row: str(row["Email"]).casefold())
    submission_records.sort(key=lambda row: str(row["Friendly ID"]).casefold())
    return {"Speakers": speaker_records, "Submissions": submission_records}


async def sync_org(
    org_id: str,
    *,
    client_factory: Callable[[str, str], Any] = AirtableClient,
) -> dict[str, Any]:
    config, _source = await get_config(org_id)
    if not config.get("enabled"):
        raise HTTPException(status_code=400, detail="Enable Airtable sync before syncing.")
    token = str(config.get("token") or "").strip()
    base_id = str(config.get("base_id") or "").strip()
    if not token or not base_id:
        raise HTTPException(
            status_code=400,
            detail="Airtable setup is incomplete. Save both an Airtable token and base ID.",
        )

    records = await _sync_records(org_id)
    try:
        async with client_factory(token, base_id) as client:
            table_ids = await ensure_tables(client)
            results = {
                "Speakers": await upsert_table(
                    client,
                    table_ids["Speakers"],
                    key_field="Email",
                    records=records["Speakers"],
                ),
                "Submissions": await upsert_table(
                    client,
                    table_ids["Submissions"],
                    key_field="Friendly ID",
                    records=records["Submissions"],
                ),
            }
    except AirtableSetupError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AirtableHttpError as exc:
        raise HTTPException(status_code=502, detail=exc.detail) from exc

    synced_at = _now_iso()
    await _store_last_synced(org_id, config, synced_at)
    return {"tables": results, "last_synced_at": synced_at}
