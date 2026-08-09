"""Unit tests for the email_outbox drain worker.

These exercise the claim → deliver → tally orchestration and the retry-vs-fail
transitions without touching the database: the leaf DB helpers and the mailer are
stubbed, so the test asserts control flow, not PostgREST.
"""

from __future__ import annotations

import pytest

from services import outbox_worker


@pytest.fixture
def stub_finalizers(monkeypatch):
    """Record which terminal transition each row took."""
    calls: dict[str, object] = {"sent": [], "failure": []}

    async def _mark_sent(row_id):
        calls["sent"].append(row_id)

    async def _mark_failure(row_id, attempts_after, error):
        calls["failure"].append((row_id, attempts_after, error))
        return "failed" if attempts_after >= outbox_worker.MAX_ATTEMPTS else "requeued"

    monkeypatch.setattr(outbox_worker, "_mark_sent", _mark_sent)
    monkeypatch.setattr(outbox_worker, "_mark_failure", _mark_failure)
    return calls


@pytest.mark.asyncio
async def test_deliver_sends_and_marks_sent(monkeypatch, stub_finalizers):
    sent_to: list[dict] = []

    async def _resolve(row):
        return "speaker@example.com"

    async def _send(*, to, subject, html, idempotency_key=None):
        sent_to.append(
            {"to": to, "subject": subject, "html": html, "idempotency_key": idempotency_key}
        )
        return {"id": "resend_123"}

    monkeypatch.setattr(outbox_worker, "_resolve_recipient", _resolve)
    monkeypatch.setattr(outbox_worker.mailer, "send_email", _send)

    row = {"id": "r1", "attempts": 0, "payload": {"subject": "Hi", "html": "<p>x</p>"}}
    outcome = await outbox_worker._deliver(row)

    assert outcome == "sent"
    assert stub_finalizers["sent"] == ["r1"]
    # row id is forwarded as the idempotency key so a retried send can't double-deliver
    assert sent_to == [
        {
            "to": "speaker@example.com",
            "subject": "Hi",
            "html": "<p>x</p>",
            "idempotency_key": "r1",
        }
    ]


@pytest.mark.asyncio
async def test_deliver_no_recipient_fails(monkeypatch, stub_finalizers):
    async def _resolve(row):
        return None

    monkeypatch.setattr(outbox_worker, "_resolve_recipient", _resolve)

    row = {"id": "r2", "attempts": 0, "payload": {"subject": "Hi", "html": "x"}}
    outcome = await outbox_worker._deliver(row)

    assert outcome == "failed"
    # marked failed immediately, no retry
    assert stub_finalizers["failure"][0][0] == "r2"
    assert stub_finalizers["failure"][0][1] >= outbox_worker.MAX_ATTEMPTS


@pytest.mark.asyncio
async def test_deliver_transient_error_requeues_then_fails(monkeypatch, stub_finalizers):
    async def _resolve(row):
        return "speaker@example.com"

    async def _boom(*, to, subject, html, idempotency_key=None):
        raise RuntimeError("resend 503")

    monkeypatch.setattr(outbox_worker, "_resolve_recipient", _resolve)
    monkeypatch.setattr(outbox_worker.mailer, "send_email", _boom)

    # Early attempt → requeued for backoff.
    early = await outbox_worker._deliver({"id": "r3", "attempts": 0, "payload": {}})
    assert early == "requeued"

    # Final attempt → given up as failed.
    final = await outbox_worker._deliver(
        {"id": "r3", "attempts": outbox_worker.MAX_ATTEMPTS - 1, "payload": {}}
    )
    assert final == "failed"


@pytest.mark.asyncio
async def test_drain_once_tallies_and_skips_lost_claims(monkeypatch):
    due = [{"id": "a"}, {"id": "b"}, {"id": "c"}]

    async def _poll(limit):
        return due

    # 'b' is lost to a racing worker (claim returns False).
    async def _claim(row):
        return row["id"] != "b"

    async def _deliver(row):
        return "sent" if row["id"] == "a" else "failed"

    monkeypatch.setattr(outbox_worker, "_poll_due", _poll)
    monkeypatch.setattr(outbox_worker, "_claim", _claim)
    monkeypatch.setattr(outbox_worker, "_deliver", _deliver)

    result = await outbox_worker.drain_once()

    assert result == {
        "due": 3,
        "sent": 1,
        "failed": 1,
        "requeued": 0,
        "skipped": 0,
        "lost": 1,
    }


@pytest.mark.asyncio
async def test_deliver_skips_demo_recipient_in_real_mode(monkeypatch, stub_finalizers):
    """With a provider key set, a reserved demo address is cancelled, not sent."""
    cancelled: list[tuple[str, str]] = []

    async def _resolve(row):
        return "hannah.cole@example.com"

    async def _mark_cancelled(row_id, note):
        cancelled.append((row_id, note))

    async def _never_send(**kwargs):
        raise AssertionError("send_email must not be called for a demo recipient")

    monkeypatch.setenv("RESEND_API_KEY", "re_dummy")
    monkeypatch.setattr(outbox_worker, "_resolve_recipient", _resolve)
    monkeypatch.setattr(outbox_worker, "_mark_cancelled", _mark_cancelled)
    monkeypatch.setattr(outbox_worker.mailer, "send_email", _never_send)

    outcome = await outbox_worker._deliver({"id": "r9", "attempts": 0, "payload": {}})

    assert outcome == "skipped"
    assert cancelled == [("r9", "demo address — delivery suppressed")]
    assert stub_finalizers["sent"] == [] and stub_finalizers["failure"] == []


def test_demo_recipient_detection(monkeypatch):
    from services import mailer

    assert mailer.is_demo_recipient("a@example.com") is True
    assert mailer.is_demo_recipient("a@sub.example.org") is True
    assert mailer.is_demo_recipient("a@thing.test") is True
    assert mailer.is_demo_recipient("a@agentmail.to") is False
    assert mailer.is_demo_recipient("a@speakerweave.com") is False
    # suppression is gated on real-delivery mode
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    assert mailer.demo_suppressed("a@example.com") is False
    monkeypatch.setenv("RESEND_API_KEY", "re_dummy")
    assert mailer.demo_suppressed("a@example.com") is True
    assert mailer.demo_suppressed("a@agentmail.to") is False


def test_is_enabled_reads_env(monkeypatch):
    monkeypatch.delenv("OUTBOX_WORKER_ENABLED", raising=False)
    assert outbox_worker.is_enabled() is False
    monkeypatch.setenv("OUTBOX_WORKER_ENABLED", "1")
    assert outbox_worker.is_enabled() is True
    monkeypatch.setenv("OUTBOX_WORKER_ENABLED", "true")
    assert outbox_worker.is_enabled() is True
    monkeypatch.setenv("OUTBOX_WORKER_ENABLED", "0")
    assert outbox_worker.is_enabled() is False
