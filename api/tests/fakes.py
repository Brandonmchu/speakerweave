"""An in-memory stand-in for the PostgREST call chain.

There is no Supabase in CI, but the interesting behaviour of these routes IS
the query: the org predicate, the delete-then-upsert of a form layout, the
usage check that turns a delete into a 409. Asserting on a mock's call list
would test that the code calls what it calls; this executes it against a store
you can read back, so a missing `.eq("org_id", …)` shows up as a row from the
wrong org in the response.

Only the subset of the chain this app actually uses is implemented — anything
else should fail loudly rather than pretend.
"""

from __future__ import annotations

import uuid
from typing import Any

# Every module that binds `supabase` at import time. A route whose module is
# missing here would silently talk to the real client.
PATCH_TARGET_MODULES = (
    "routes.admin_routes",
    "routes.api_key_admin_routes",
    "routes.crm_routes",
    "routes.dashboard_routes",
    "routes.field_routes",
    "routes.form_admin_routes",
    "routes.portal_admin_routes",
    "routes.program_routes",
    "routes.public_routes",
    "routes.schedule_routes",
    "routes.taxonomy_routes",
    "services.api_keys",
    "services.content_pipeline",
    "services.crm",
    "services.evaluations",
    "services.forms",
    "services.integration_api",
    "services.magic_links",
    "services.onboarding",
    "services.org_scope",
    "services.portal",
    "services.session_revisions",
    "services.slugs",
    "services.submitter_selfservice",
)


class FakeResult:
    def __init__(self, data: list[dict]):
        self.data = data


def _match_or(row: dict, expression: str) -> bool:
    """PostgREST `or=(a.eq.1,b.is.null)` — only the operators we emit."""
    for clause in expression.split(","):
        parts = clause.split(".", 2)
        if len(parts) != 3:
            continue
        column, op, value = parts
        if op == "eq" and str(row.get(column)) == value:
            return True
        if op == "is" and value == "null" and row.get(column) is None:
            return True
    return False


def _project(row: dict, columns: str) -> dict:
    """Keep only the selected columns, the way PostgREST would."""
    if columns.strip() == "*":
        return row
    wanted = {part.strip() for part in columns.split(",") if part.strip()}
    return {key: value for key, value in row.items() if key in wanted}


class FakeQuery:
    def __init__(
        self,
        store: dict[str, list[dict]],
        table: str,
        log: list[dict],
        *,
        strict_columns: bool = False,
    ):
        self.store, self.table, self.log = store, table, log
        self.op = "select"
        self.payload: Any = None
        self.on_conflict: str | None = None
        self.filters: list[tuple[str, str, Any]] = []
        self.limit_n: int | None = None
        self.order_by: tuple[str, bool] | None = None
        self.columns = "*"
        self.strict_columns = strict_columns

    # -- builders ----------------------------------------------------------
    def select(self, *args, **_kwargs):
        if args:
            self.columns = str(args[0])
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def is_(self, key, value):
        self.filters.append(("is", key, value))
        return self

    def gt(self, key, value):
        self.filters.append(("gt", key, value))
        return self

    def in_(self, key, values):
        self.filters.append(("in", key, list(values)))
        return self

    def or_(self, expression):
        self.filters.append(("or", expression, None))
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def order(self, column, desc=False):
        self.order_by = (column, desc)
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def upsert(self, payload, on_conflict: str | None = None):
        self.op, self.payload, self.on_conflict = "upsert", payload, on_conflict
        return self

    def delete(self):
        self.op = "delete"
        return self

    # -- execution ---------------------------------------------------------
    def _matches(self, row: dict) -> bool:
        for kind, key, value in self.filters:
            if kind == "eq" and row.get(key) != value:
                return False
            if kind == "is" and value == "null" and row.get(key) is not None:
                return False
            if kind == "gt" and (row.get(key) is None or row.get(key) <= value):
                return False
            if kind == "in" and row.get(key) not in value:
                return False
            if kind == "or" and not _match_or(row, key):
                return False
        return True

    def _rows(self) -> list[dict]:
        return self.store.setdefault(self.table, [])

    def execute(self) -> FakeResult:
        self.log.append(
            {
                "table": self.table,
                "op": self.op,
                "filters": list(self.filters),
                "columns": self.columns,
            }
        )
        rows = self._rows()

        if self.op == "insert":
            records = self.payload if isinstance(self.payload, list) else [self.payload]
            created = [{"id": str(uuid.uuid4()), **record} for record in records]
            rows.extend(created)
            return FakeResult([dict(row) for row in created])

        if self.op == "upsert":
            records = self.payload if isinstance(self.payload, list) else [self.payload]
            keys = [k.strip() for k in (self.on_conflict or "id").split(",")]
            written = []
            for record in records:
                existing = next(
                    (r for r in rows if all(r.get(k) == record.get(k) for k in keys)), None
                )
                if existing:
                    existing.update(record)
                    written.append(dict(existing))
                else:
                    created = {"id": str(uuid.uuid4()), **record}
                    rows.append(created)
                    written.append(dict(created))
            return FakeResult(written)

        if self.op == "update":
            hits = [row for row in rows if self._matches(row)]
            for row in hits:
                row.update(self.payload)
            return FakeResult([dict(row) for row in hits])

        if self.op == "delete":
            hits = [row for row in rows if self._matches(row)]
            self.store[self.table] = [row for row in rows if not self._matches(row)]
            return FakeResult([dict(row) for row in hits])

        found = [dict(row) for row in rows if self._matches(row)]
        if self.strict_columns:
            # PostgREST hands back ONLY the projected columns. Off by default so
            # the suite keeps reading whole rows, but a test can switch it on to
            # catch code that verifies a column it forgot to select (the bug
            # that 404'd every bulk content reminder).
            found = [_project(row, self.columns) for row in found]
        if self.order_by:
            column, desc = self.order_by
            found.sort(
                key=lambda row: (row.get(column) is None, str(row.get(column) or "")),
                reverse=desc,
            )
        if self.limit_n is not None:
            found = found[: self.limit_n]
        return FakeResult(found)


class FakeRpc:
    """`supabase.rpc(fn, params).execute()` — one canned scalar per call."""

    def __init__(self, value: Any):
        self.value = value

    def execute(self) -> FakeResult:
        return FakeResult(self.value)


class FakeStorageBucket:
    """`supabase.storage.from_(bucket)` — records uploads, hands back a URL."""

    def __init__(self, bucket: str, uploads: dict[str, dict[str, bytes]]):
        self.bucket = bucket
        self.uploads = uploads

    def upload(self, path: str, file: bytes, file_options: dict | None = None) -> dict:
        self.uploads.setdefault(self.bucket, {})[path] = file
        return {"path": path}

    def get_public_url(self, path: str) -> str:
        return f"https://storage.test/{self.bucket}/{path}"

    def download(self, path: str) -> bytes:
        data = self.uploads.get(self.bucket, {}).get(path)
        if data is None:
            raise FileNotFoundError(path)
        return data


class FakeStorage:
    def __init__(self) -> None:
        # {bucket: {path: bytes}}
        self.uploads: dict[str, dict[str, bytes]] = {}

    def from_(self, bucket: str) -> FakeStorageBucket:
        return FakeStorageBucket(bucket, self.uploads)


class FakeSupabase:
    def __init__(self, store: dict[str, list[dict]] | None = None):
        self.store: dict[str, list[dict]] = store if store is not None else {}
        self.log: list[dict] = []
        self.rpc_calls: list[tuple[str, dict]] = []
        self.storage = FakeStorage()
        # Flip to True in a test to make selects honour their column list.
        self.strict_columns = False

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(self.store, name, self.log, strict_columns=self.strict_columns)

    def rpc(self, function_name: str, params: dict | None = None) -> FakeRpc:
        self.rpc_calls.append((function_name, dict(params or {})))
        if function_name == "next_friendly_id":
            return FakeRpc(len([c for c in self.rpc_calls if c[0] == function_name]))
        return FakeRpc(None)

    # -- test conveniences -------------------------------------------------
    def rows(self, table: str) -> list[dict]:
        return self.store.setdefault(table, [])

    def seed(self, table: str, *records: dict) -> None:
        self.store.setdefault(table, []).extend(dict(record) for record in records)

    def tables_touched(self, op: str) -> list[str]:
        return [entry["table"] for entry in self.log if entry["op"] == op]
