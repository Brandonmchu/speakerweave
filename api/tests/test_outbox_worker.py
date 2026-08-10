"""Unit tests for the email_outbox drain worker.

These exercise the claim → deliver → tally orchestration and the retry-vs-fail
transitions without touching the database: the leaf DB helpers and the mailer are
stubbed, so the test asserts control flow, not PostgREST.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from services import outbox_worker
from tests.fakes import FakeSupabase


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


def test_auto_reminder_configuration_defaults_to_worker_and_reads_interval(monkeypatch):
    monkeypatch.delenv("AUTO_REMINDERS_ENABLED", raising=False)
    monkeypatch.setenv("OUTBOX_WORKER_ENABLED", "1")
    assert outbox_worker.auto_reminders_enabled() is True

    monkeypatch.setenv("AUTO_REMINDERS_ENABLED", "0")
    assert outbox_worker.auto_reminders_enabled() is False

    monkeypatch.setenv("AUTO_REMINDERS_INTERVAL_HOURS", "2.5")
    assert outbox_worker._reminder_sweep_interval() == timedelta(hours=2.5)


@pytest.mark.asyncio
async def test_reminder_sweep_queues_one_daily_row_and_filters_ineligible(monkeypatch):
    now = datetime(2026, 8, 10, 12, tzinfo=timezone.utc)
    overdue = "2026-08-09T10:00:00+00:00"
    assignments = [
        {
            "id": "a1",
            "org_id": "org-1",
            "contact_id": "contact-1",
            "status": "todo",
            "tasks": {
                "id": "task-1",
                "event_id": "event-1",
                "name": "Upload slides",
                "due_at": overdue,
            },
        },
        {
            "id": "a2",
            "org_id": "org-1",
            "contact_id": "contact-1",
            "status": "denied",
            "tasks": {
                "id": "task-2",
                "event_id": "event-1",
                "name": "Revise biography",
                "due_at": "2026-08-08T10:00:00+00:00",
            },
        },
        {
            "id": "done",
            "org_id": "org-1",
            "contact_id": "contact-2",
            "status": "done",
            "tasks": {
                "id": "task-3",
                "event_id": "event-1",
                "name": "Already complete",
                "due_at": overdue,
            },
        },
        {
            "id": "approved",
            "org_id": "org-1",
            "contact_id": "contact-2",
            "status": "approved",
            "tasks": {
                "id": "task-4",
                "event_id": "event-1",
                "name": "Already approved",
                "due_at": overdue,
            },
        },
        {
            "id": "future",
            "org_id": "org-1",
            "contact_id": "contact-3",
            "status": "todo",
            "tasks": {
                "id": "task-5",
                "event_id": "event-1",
                "name": "Future task",
                "due_at": "2026-08-11T10:00:00+00:00",
            },
        },
    ]

    async def load_assignments(sweep_now, limit):
        assert sweep_now == now
        assert limit == outbox_worker.REMINDER_ASSIGNMENT_LIMIT
        return assignments

    fake = FakeSupabase()

    async def immediate_db(operation, _label="query"):
        return operation()

    monkeypatch.setattr(outbox_worker, "_load_overdue_assignments", load_assignments)
    monkeypatch.setattr(outbox_worker, "supabase", fake)
    monkeypatch.setattr(outbox_worker, "db", immediate_db)

    first = await outbox_worker.sweep_overdue_reminders(now=now)
    second = await outbox_worker.sweep_overdue_reminders(now=now)

    assert first == {"assignments": 5, "contacts": 1, "queued": 1}
    assert second == {"assignments": 5, "contacts": 1, "queued": 0}
    queued = fake.rows("email_outbox")
    assert len(queued) == 1
    assert queued[0]["contact_id"] == "contact-1"
    assert queued[0]["template_key"] == "auto_task_reminder"
    assert queued[0]["status"] == "queued"
    assert queued[0]["dedupe_key"] == "auto-task-reminder:contact-1:2026-08-10"
    html = queued[0]["payload"]["html"]
    assert "Upload slides" in html and "2026-08-09" in html
    assert "Revise biography" in html and "2026-08-08" in html
    assert "Already complete" not in html
    assert "Already approved" not in html
    assert "Future task" not in html


@pytest.mark.asyncio
async def test_reminder_sweep_runs_only_after_interval(monkeypatch):
    start = datetime(2026, 8, 10, 12, tzinfo=timezone.utc)
    clock = {"now": start}
    sweeps: list[datetime] = []

    async def sweep(*, now=None, limit=outbox_worker.REMINDER_ASSIGNMENT_LIMIT):
        sweeps.append(now)
        return {"assignments": 0, "contacts": 0, "queued": 0}

    monkeypatch.setenv("OUTBOX_WORKER_ENABLED", "1")
    monkeypatch.delenv("AUTO_REMINDERS_ENABLED", raising=False)
    monkeypatch.delenv("AUTO_REMINDERS_INTERVAL_HOURS", raising=False)
    monkeypatch.setattr(outbox_worker, "_now", lambda: clock["now"])
    monkeypatch.setattr(outbox_worker, "sweep_overdue_reminders", sweep)
    monkeypatch.setattr(outbox_worker, "_last_reminder_sweep_at", None)

    assert await outbox_worker._maybe_sweep_overdue_reminders() is True
    clock["now"] = start + timedelta(hours=5, minutes=59)
    assert await outbox_worker._maybe_sweep_overdue_reminders() is False
    clock["now"] = start + timedelta(hours=6)
    assert await outbox_worker._maybe_sweep_overdue_reminders() is True
    assert sweeps == [start, start + timedelta(hours=6)]


@pytest.mark.asyncio
async def test_sweep_exception_does_not_stop_the_drain_loop(monkeypatch):
    calls: list[str] = []

    async def broken_sweep():
        calls.append("sweep")
        raise RuntimeError("database unavailable")

    async def drain():
        calls.append("drain")
        return {"sent": 0, "failed": 0, "requeued": 0}

    async def stop_after_cycle(_seconds):
        raise asyncio.CancelledError

    monkeypatch.setattr(outbox_worker, "_maybe_sweep_overdue_reminders", broken_sweep)
    monkeypatch.setattr(outbox_worker, "drain_once", drain)
    monkeypatch.setattr(outbox_worker.asyncio, "sleep", stop_after_cycle)

    with pytest.raises(asyncio.CancelledError):
        await outbox_worker.run_forever(idle_sleep=0)

    assert calls == ["sweep", "drain"]
