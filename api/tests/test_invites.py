"""Invite ledger semantics + the two routes that expose them.

There is no Supabase in CI, so the ledger behaviour — the thing that makes
"Send invites" safe to press twice — runs against a small in-memory stand-in
for the PostgREST call chain. Everything else is pure or route-level.
"""

from __future__ import annotations

import email
import uuid

import pytest

from routes import admin_routes, ics_routes
from services import invites
from services.invites import (
    InviteTargetNotFound,
    SessionNotScheduled,
    invite_uid,
    payload_hash,
)

SESSION_ID = "11111111-1111-1111-1111-111111111111"
CONTACT_ID = "22222222-2222-2222-2222-222222222222"
UID = f"dais-{SESSION_ID}-{CONTACT_ID}@dais.events"

BASE = ("2026-10-12T16:00:00+00:00", "2026-10-12T16:30:00+00:00", "Scaling LLMs", "Main Stage")


# ── derivation ─────────────────────────────────────────────────────────────


def test_uid_is_stable_and_derived():
    assert invite_uid(SESSION_ID, CONTACT_ID) == UID
    assert invite_uid(SESSION_ID, CONTACT_ID) == invite_uid(SESSION_ID, CONTACT_ID)


def test_uid_is_unique_per_attendee():
    assert invite_uid(SESSION_ID, CONTACT_ID) != invite_uid(SESSION_ID, "33333333")


@pytest.mark.parametrize("index", range(4))
def test_every_calendar_relevant_field_changes_the_hash(index):
    changed = list(BASE)
    changed[index] = changed[index] + "-changed"
    assert payload_hash(*BASE) != payload_hash(*changed)


def test_identical_payload_hashes_identically():
    """This equality is what stops a second 'Send invites' from mailing again."""
    assert payload_hash(*BASE) == payload_hash(*BASE)


# ── GET /public/invites/{uid}.ics ──────────────────────────────────────────


def test_public_ics_download(client, monkeypatch):
    async def fake(uid: str) -> str:
        assert uid == UID
        return "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"

    monkeypatch.setattr(ics_routes, "build_ics_for_uid", fake)
    response = client.get(f"/public/invites/{UID}.ics")

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/calendar; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="invite.ics"'
    assert response.text.endswith("END:VCALENDAR\r\n")


def test_public_ics_unknown_uid_404s(client, monkeypatch):
    async def fake(uid: str) -> str:
        raise InviteTargetNotFound("Invite not found")

    monkeypatch.setattr(ics_routes, "build_ics_for_uid", fake)
    assert client.get("/public/invites/nope@dais.events.ics").status_code == 404


def test_public_ics_unscheduled_session_409s(client, monkeypatch):
    async def fake(uid: str) -> str:
        raise SessionNotScheduled("Session is not scheduled")

    monkeypatch.setattr(ics_routes, "build_ics_for_uid", fake)
    assert client.get(f"/public/invites/{UID}.ics").status_code == 409


# ── POST /api/sessions/{id}/send-invites ───────────────────────────────────


def test_send_invites_requires_auth(client):
    assert client.post(f"/api/sessions/{SESSION_ID}/send-invites").status_code == 401


def test_send_invites_passes_org_and_dry_run(client, monkeypatch, auth_headers):
    seen = {}

    async def fake(session_id, org_id, *, dry_run=False):
        seen.update(session_id=session_id, org_id=org_id, dry_run=dry_run)
        return {"session_id": session_id, "results": [], "counts": {}}

    monkeypatch.setattr(admin_routes, "send_session_invites", fake)
    response = client.post(
        f"/api/sessions/{SESSION_ID}/send-invites?dry_run=true", headers=auth_headers
    )

    assert response.status_code == 200
    assert seen == {"session_id": SESSION_ID, "org_id": "org_dev", "dry_run": True}


def test_send_invites_on_unscheduled_session_409s(client, monkeypatch, auth_headers):
    async def fake(session_id, org_id, *, dry_run=False):
        raise SessionNotScheduled("Session has no start/end time yet")

    monkeypatch.setattr(admin_routes, "send_session_invites", fake)
    response = client.post(f"/api/sessions/{SESSION_ID}/send-invites", headers=auth_headers)
    assert response.status_code == 409
    assert "start/end" in response.json()["detail"]


def test_send_invites_on_foreign_session_404s(client, monkeypatch, auth_headers):
    async def fake(session_id, org_id, *, dry_run=False):
        raise InviteTargetNotFound("Session not found")

    monkeypatch.setattr(admin_routes, "send_session_invites", fake)
    response = client.post(f"/api/sessions/{SESSION_ID}/send-invites", headers=auth_headers)
    assert response.status_code == 404


def test_cancel_invites_route(client, monkeypatch, auth_headers):
    async def fake(session_id, org_id):
        return {"session_id": session_id, "method": "CANCEL", "results": []}

    monkeypatch.setattr(admin_routes, "cancel_session_invites", fake)
    response = client.post(f"/api/sessions/{SESSION_ID}/cancel-invites", headers=auth_headers)
    assert response.status_code == 200
    assert response.json()["method"] == "CANCEL"


# ── the ledger, against an in-memory PostgREST ─────────────────────────────

ORG_ID = "org_dev"
EVENT_ID = "eeeeeeee-1111-1111-1111-111111111111"
ROOM_ID = "33333333-3333-3333-3333-333333333301"
SPEAKER_ID = "22222222-2222-2222-2222-222222222201"


def _seed() -> dict[str, list[dict]]:
    return {
        "sessions": [
            {
                "id": SESSION_ID,
                "org_id": ORG_ID,
                "event_id": EVENT_ID,
                "title": "Scaling LLM inference",
                "description": "A practical tour.",
                "status": "accepted",
                "starts_at": "2026-10-12T16:00:00+00:00",
                "ends_at": "2026-10-12T16:30:00+00:00",
                "room_id": ROOM_ID,
                "submitter_contact_id": SPEAKER_ID,
            }
        ],
        "events": [
            {
                "id": EVENT_ID,
                "org_id": ORG_ID,
                "name": "AI Builders Summit",
                "slug": "ai-builders-summit",
                "timezone": "America/Los_Angeles",
                "location": "San Francisco, CA",
                "settings": {},
            }
        ],
        "rooms": [{"id": ROOM_ID, "org_id": ORG_ID, "name": "Main Stage"}],
        "session_participants": [
            {
                "id": "p1",
                "org_id": ORG_ID,
                "session_id": SESSION_ID,
                "contact_id": SPEAKER_ID,
                "role": "speaker",
                "is_primary": True,
            }
        ],
        "contacts": [
            {
                "id": SPEAKER_ID,
                "org_id": ORG_ID,
                "email": "ada@example.com",
                "first_name": "Ada",
                "last_name": "Lovelace",
            }
        ],
        "calendar_invites": [],
    }


class _Result:
    def __init__(self, data: list[dict]):
        self.data = data


class _Query:
    """Only the chain services/invites.py actually calls."""

    def __init__(self, store: dict, table: str):
        self.store, self.table = store, table
        self.op, self.payload = "select", None
        self.eqs: list[tuple[str, object]] = []
        self.ins: list[tuple[str, list]] = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.eqs.append((key, value))
        return self

    def in_(self, key, values):
        self.ins.append((key, list(values)))
        return self

    def limit(self, _n):
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def _matches(self, row: dict) -> bool:
        return all(row.get(k) == v for k, v in self.eqs) and all(
            row.get(k) in values for k, values in self.ins
        )

    def execute(self):
        table = self.store.setdefault(self.table, [])
        if self.op == "insert":
            row = {"id": str(uuid.uuid4()), **self.payload}
            table.append(row)
            return _Result([row])
        if self.op == "update":
            hits = [row for row in table if self._matches(row)]
            for row in hits:
                row.update(self.payload)
            return _Result(hits)
        return _Result([dict(row) for row in table if self._matches(row)])


class _Ledger:
    """Stubbed DB + dev outbox: a "send" is a row in `store` and a file on disk."""

    def __init__(self, store: dict, outbox):
        self.store, self.outbox = store, outbox

    def rows(self, table: str) -> list[dict]:
        return self.store[table]

    def mails(self) -> list[str]:
        return [p.read_text(encoding="utf-8") for p in sorted(self.outbox.glob("*.eml"))]

    def last_calendar_part(self):
        message = email.message_from_string(self.mails()[-1])
        return next(p for p in message.walk() if p.get_content_type() == "text/calendar")

    def last_ics(self) -> str:
        return self.last_calendar_part().get_payload(decode=True).decode("utf-8")


@pytest.fixture
def ledger(monkeypatch, tmp_path):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.setenv("OUTBOX_DIR", str(tmp_path))
    store = _seed()

    class _FakeSupabase:
        def table(self, name):
            return _Query(store, name)

    monkeypatch.setattr(invites, "supabase", _FakeSupabase())
    return _Ledger(store, tmp_path)


async def test_first_send_writes_the_ledger_and_mails_the_speaker(ledger):
    result = await invites.send_session_invites(SESSION_ID, ORG_ID)

    assert result["counts"] == {"sent": 1}
    row = ledger.rows("calendar_invites")[0]
    assert row["ics_uid"] == invite_uid(SESSION_ID, SPEAKER_ID)
    assert (row["sequence"], row["last_method"]) == (0, "REQUEST")
    assert row["last_payload_hash"]
    assert len(ledger.mails()) == 1
    assert "DTSTART:20261012T160000Z" in ledger.last_ics()


async def test_resend_without_a_material_change_is_a_no_op(ledger):
    """The 'Accept + Send invites never duplicates' requirement."""
    await invites.send_session_invites(SESSION_ID, ORG_ID)
    again = await invites.send_session_invites(SESSION_ID, ORG_ID)

    assert again["counts"] == {"unchanged": 1}
    assert ledger.rows("calendar_invites")[0]["sequence"] == 0  # no phantom bump
    assert len(ledger.mails()) == 1  # no second email


async def test_reschedule_bumps_the_sequence_and_resends(ledger):
    await invites.send_session_invites(SESSION_ID, ORG_ID)
    ledger.rows("sessions")[0]["starts_at"] = "2026-10-12T17:00:00+00:00"
    ledger.rows("sessions")[0]["ends_at"] = "2026-10-12T17:30:00+00:00"

    updated = await invites.send_session_invites(SESSION_ID, ORG_ID)

    assert updated["counts"] == {"sent": 1}
    assert ledger.rows("calendar_invites")[0]["sequence"] == 1
    assert len(ledger.mails()) == 2
    assert "SEQUENCE:1" in ledger.last_ics()
    assert "DTSTART:20261012T170000Z" in ledger.last_ics()


async def test_dry_run_touches_nothing(ledger):
    preview = await invites.send_session_invites(SESSION_ID, ORG_ID, dry_run=True)

    assert preview["counts"] == {"dry_run": 1}
    assert preview["results"][0]["ics"].startswith("BEGIN:VCALENDAR\r\n")
    assert ledger.rows("calendar_invites") == []
    assert ledger.mails() == []


async def test_cancel_sends_method_cancel_and_bumps_the_sequence(ledger):
    await invites.send_session_invites(SESSION_ID, ORG_ID)
    cancelled = await invites.cancel_session_invites(SESSION_ID, ORG_ID)

    assert cancelled["counts"] == {"sent": 1}
    row = ledger.rows("calendar_invites")[0]
    assert (row["sequence"], row["last_method"]) == (1, "CANCEL")

    assert ledger.last_calendar_part().get_param("method") == "CANCEL"
    body = ledger.last_ics()
    assert "METHOD:CANCEL" in body
    assert "STATUS:CANCELLED" in body
    assert "SEQUENCE:1" in body
    # Same UID as the REQUEST, or the client cannot match the cancellation.
    assert invite_uid(SESSION_ID, SPEAKER_ID) in body.replace("\r\n ", "")


async def test_cancelling_twice_is_a_no_op(ledger):
    await invites.send_session_invites(SESSION_ID, ORG_ID)
    await invites.cancel_session_invites(SESSION_ID, ORG_ID)
    again = await invites.cancel_session_invites(SESSION_ID, ORG_ID)

    assert again["counts"] == {"unchanged": 1}
    assert ledger.rows("calendar_invites")[0]["sequence"] == 1


async def test_unscheduled_session_is_refused(ledger):
    ledger.rows("sessions")[0]["starts_at"] = None
    with pytest.raises(SessionNotScheduled):
        await invites.send_session_invites(SESSION_ID, ORG_ID)
    assert ledger.mails() == []


async def test_another_orgs_session_is_not_found(ledger):
    with pytest.raises(InviteTargetNotFound):
        await invites.send_session_invites(SESSION_ID, "org_someone_else")


async def test_public_ics_is_regenerated_from_live_session_data(ledger):
    await invites.send_session_invites(SESSION_ID, ORG_ID)
    ledger.rows("sessions")[0]["title"] = "Renamed after the invite went out"

    document = await invites.build_ics_for_uid(invite_uid(SESSION_ID, SPEAKER_ID))

    assert "SUMMARY:Renamed after the invite went out" in document
    assert "METHOD:REQUEST" in document


async def test_public_ics_honours_a_cancelled_invite(ledger):
    """Once cancelled, the download must stay a CANCEL — not resurrect a hold."""
    await invites.send_session_invites(SESSION_ID, ORG_ID)
    await invites.cancel_session_invites(SESSION_ID, ORG_ID)

    document = await invites.build_ics_for_uid(invite_uid(SESSION_ID, SPEAKER_ID))

    assert "METHOD:CANCEL" in document
    assert "STATUS:CANCELLED" in document
    assert "SEQUENCE:1" in document  # the stored sequence, honoured


async def test_public_ics_cancel_survives_an_unscheduled_session(ledger):
    """A CANCEL is matched on UID + SEQUENCE, so missing times are fine."""
    await invites.send_session_invites(SESSION_ID, ORG_ID)
    await invites.cancel_session_invites(SESSION_ID, ORG_ID)
    ledger.rows("sessions")[0]["starts_at"] = None
    ledger.rows("sessions")[0]["ends_at"] = None

    document = await invites.build_ics_for_uid(invite_uid(SESSION_ID, SPEAKER_ID))
    assert "METHOD:CANCEL" in document
    assert "STATUS:CANCELLED" in document
