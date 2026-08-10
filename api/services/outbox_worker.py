"""Background drain of email_outbox → real delivery via the mailer (Resend).

Queued rows (portal / reviewer / decision invites) are written with
status='queued' by the request handlers so a slow or failing send never blocks
the invite that triggered it. This worker claims those rows and delivers them.
Comms broadcasts already send inline and land as status='sent', so the worker
never re-touches them.

Concurrency: the API runs several uvicorn workers, each running this loop. A row
is claimed with an optimistic compare-and-set on (id, status='queued',
attempts=n) — the first writer flips attempts to n+1 and wins; a racing worker's
guarded update matches zero rows and moves on. No dedicated 'sending' state is
needed (the schema's status CHECK does not define one), and send_after is pushed
into the future on claim so a send that crashes mid-flight is retried after the
lease rather than being lost.
"""

from __future__ import annotations

import asyncio
import html as html_module
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.logging_config import get_logger
from services import mailer
from services.supabase_helpers import db, rows
from supabase_client import supabase

logger = get_logger(__name__)

MAX_ATTEMPTS = 4
BATCH = 25
IDLE_SLEEP = 15.0  # seconds between polls when there was nothing to do
BUSY_SLEEP = 1.0  # short pause after a batch, to keep draining promptly
RETRY_BACKOFF_MIN = 5  # wait this long before retrying a transient send failure
CLAIM_LEASE_MIN = 3  # push send_after out this far while a claim is in flight
REMINDER_SWEEP_INTERVAL = timedelta(hours=6)
REMINDER_ASSIGNMENT_LIMIT = 200
DONE_TASK_STATUSES = frozenset({"approved", "done"})
INCOMPLETE_TASK_STATUSES = ("todo", "submitted", "denied")

_last_reminder_sweep_at: datetime | None = None


def is_enabled() -> bool:
    """The loop only runs where explicitly turned on (prod). Off in tests."""
    return (os.getenv("OUTBOX_WORKER_ENABLED", "0") or "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def auto_reminders_enabled() -> bool:
    """Default on with the outbox worker, independently disableable."""
    default = "1" if is_enabled() else "0"
    return (os.getenv("AUTO_REMINDERS_ENABLED", default) or default).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _reminder_sweep_interval() -> timedelta:
    raw = os.getenv("AUTO_REMINDERS_INTERVAL_HOURS")
    if raw is None:
        return REMINDER_SWEEP_INTERVAL
    try:
        hours = float(raw)
    except ValueError:
        logger.warning("outbox: invalid AUTO_REMINDERS_INTERVAL_HOURS=%r; using 6", raw)
        return REMINDER_SWEEP_INTERVAL
    if hours <= 0:
        logger.warning("outbox: AUTO_REMINDERS_INTERVAL_HOURS must be positive; using 6")
        return REMINDER_SWEEP_INTERVAL
    return timedelta(hours=hours)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _assignment_task(assignment: dict) -> dict:
    task = assignment.get("tasks") or assignment.get("task") or {}
    if isinstance(task, list):
        return task[0] if task else {}
    return task if isinstance(task, dict) else {}


async def _load_overdue_assignments(now: datetime, limit: int) -> list[dict]:
    """Load at most ``limit`` overdue, unfinished assignments with task details."""
    result = await db(
        lambda: supabase.table("task_assignments")
        .select(
            "id, org_id, task_id, contact_id, status, "
            "tasks!inner(id, event_id, name, due_at)"
        )
        .in_("status", list(INCOMPLETE_TASK_STATUSES))
        .lt("tasks.due_at", _iso(now))
        .limit(limit)
        .execute(),
        "auto_task_reminder_overdue_assignments",
    )
    return rows(result)


async def _queue_auto_task_reminder(group: dict, day: str) -> bool:
    contact_id = str(group["contact_id"])
    event_id = str(group["event_id"])
    dedupe_key = f"auto-task-reminder:{contact_id}:{day}"
    existing = rows(
        await db(
            lambda: supabase.table("email_outbox")
            .select("id")
            .eq("event_id", event_id)
            .eq("dedupe_key", dedupe_key)
            .limit(1)
            .execute(),
            "auto_task_reminder_dedupe_check",
        )
    )
    if existing:
        return False

    items = "".join(
        "<li><strong>"
        f"{html_module.escape(str(item['name']))}</strong> — due {item['due_date']}</li>"
        for item in group["tasks"]
    )
    body = (
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
        'font-size:15px;line-height:1.5;color:#111">'
        "<p>Hello,</p><p>You have overdue event tasks:</p>"
        f"<ul>{items}</ul>"
        "<p>Please open your speaker portal to complete them. Thank you!</p></div>"
    )
    record = {
        "org_id": group["org_id"],
        "event_id": event_id,
        "contact_id": contact_id,
        "template_key": "auto_task_reminder",
        "payload": {"subject": "Reminder: overdue event tasks", "html": body},
        "status": "queued",
        "dedupe_key": dedupe_key,
    }
    try:
        await db(
            lambda: supabase.table("email_outbox").insert(record).execute(),
            "auto_task_reminder_queue",
        )
    except Exception:  # unique-key race or transient DB failure; the sweep carries on
        logger.warning(
            "outbox: could not queue automatic task reminder contact=%s",
            contact_id,
            exc_info=True,
        )
        return False
    return True


async def sweep_overdue_reminders(
    *, now: datetime | None = None, limit: int = REMINDER_ASSIGNMENT_LIMIT
) -> dict[str, int]:
    """Queue one daily email per contact for overdue, unfinished assignments."""
    sweep_now = now or _now()
    assignments = await _load_overdue_assignments(sweep_now, limit)
    grouped: dict[str, dict] = defaultdict(dict)

    for assignment in assignments[:limit]:
        if assignment.get("status") in DONE_TASK_STATUSES:
            continue
        task = _assignment_task(assignment)
        due_at = _parse_datetime(task.get("due_at"))
        if due_at is None or due_at >= sweep_now:
            continue
        contact_id = assignment.get("contact_id")
        event_id = task.get("event_id")
        org_id = assignment.get("org_id")
        if not contact_id or not event_id or not org_id:
            continue

        key = str(contact_id)
        if not grouped[key]:
            grouped[key] = {
                "org_id": org_id,
                "event_id": event_id,
                "contact_id": contact_id,
                "tasks": [],
            }
        grouped[key]["tasks"].append(
            {
                "name": task.get("name") or "Task",
                "due_date": due_at.date().isoformat(),
            }
        )

    queued = 0
    day = sweep_now.strftime("%Y-%m-%d")
    for group in grouped.values():
        group["tasks"].sort(key=lambda item: (item["due_date"], str(item["name"])))
        if await _queue_auto_task_reminder(group, day):
            queued += 1
    return {"assignments": len(assignments), "contacts": len(grouped), "queued": queued}


async def _maybe_sweep_overdue_reminders() -> bool:
    global _last_reminder_sweep_at

    if not auto_reminders_enabled():
        return False
    now = _now()
    if (
        _last_reminder_sweep_at is not None
        and now - _last_reminder_sweep_at < _reminder_sweep_interval()
    ):
        return False

    # Record the attempt before querying so a DB outage does not turn the
    # 15-second drain poll into an accidental hot loop against the database.
    _last_reminder_sweep_at = now
    await sweep_overdue_reminders(now=now)
    return True


async def _poll_due(limit: int) -> list[dict]:
    now = _iso(_now())
    result = await db(
        lambda: supabase.table("email_outbox")
        .select("*")
        .eq("status", "queued")
        .lte("send_after", now)
        .order("send_after")
        .limit(limit)
        .execute(),
        "outbox_poll",
    )
    return rows(result)


async def _claim(row: dict) -> bool:
    """Optimistic compare-and-set. True iff this worker won the row."""
    row_id = row["id"]
    attempts = int(row.get("attempts") or 0)
    lease_until = _iso(_now() + timedelta(minutes=CLAIM_LEASE_MIN))
    result = await db(
        lambda: supabase.table("email_outbox")
        .update({"attempts": attempts + 1, "send_after": lease_until})
        .eq("id", row_id)
        .eq("status", "queued")
        .eq("attempts", attempts)
        .execute(),
        "outbox_claim",
    )
    return len(rows(result)) == 1


async def _resolve_recipient(row: dict) -> str | None:
    payload = row.get("payload") or {}
    to = payload.get("to")
    if to:
        return str(to)
    contact_id = row.get("contact_id")
    if not contact_id:
        return None
    result = await db(
        lambda: supabase.table("contacts")
        .select("email")
        .eq("id", contact_id)
        .limit(1)
        .execute(),
        "outbox_resolve_contact",
    )
    recs = rows(result)
    if recs and recs[0].get("email"):
        return str(recs[0]["email"])
    return None


async def _mark_sent(row_id: str) -> None:
    now = _iso(_now())
    await db(
        lambda: supabase.table("email_outbox")
        .update({"status": "sent", "sent_at": now, "last_error": None})
        .eq("id", row_id)
        .execute(),
        "outbox_mark_sent",
    )


async def _mark_cancelled(row_id: str, note: str) -> None:
    """Deliberate non-delivery (demo/reserved recipient) — not a failure."""
    await db(
        lambda: supabase.table("email_outbox")
        .update({"status": "cancelled", "last_error": note})
        .eq("id", row_id)
        .execute(),
        "outbox_mark_cancelled",
    )


async def _mark_failure(row_id: str, attempts_after: int, error: str) -> str:
    """Give up after MAX_ATTEMPTS; otherwise requeue with a backoff. Returns the
    resulting status so the caller can tally the batch."""
    if attempts_after >= MAX_ATTEMPTS:
        update = {"status": "failed", "last_error": error[:2000]}
        status = "failed"
    else:
        update = {
            "status": "queued",
            "last_error": error[:2000],
            "send_after": _iso(_now() + timedelta(minutes=RETRY_BACKOFF_MIN)),
        }
        status = "requeued"
    await db(
        lambda: supabase.table("email_outbox").update(update).eq("id", row_id).execute(),
        "outbox_mark_failure",
    )
    return status


async def _deliver(row: dict) -> str:
    """Send one claimed row. Returns 'sent' | 'failed' | 'requeued'.

    The whole path — recipient resolution, render, send — is guarded: any
    exception routes through _mark_failure, so a claimed row can never be left
    stuck retrying forever with unbounded attempts (e.g. a DB error while
    resolving the recipient)."""
    row_id = row["id"]
    attempts_after = int(row.get("attempts") or 0) + 1
    try:
        payload = row.get("payload") or {}
        subject = str(payload.get("subject") or "")
        html = str(payload.get("html") or payload.get("body_html") or "")

        recipient = await _resolve_recipient(row)
        if not recipient:
            await _mark_failure(row_id, MAX_ATTEMPTS, "no recipient address")
            logger.warning("outbox: no recipient for row=%s (failed)", row_id)
            return "failed"

        if mailer.demo_suppressed(recipient):
            await _mark_cancelled(row_id, "demo address — delivery suppressed")
            logger.info("outbox: skipped demo recipient row=%s", row_id)
            return "skipped"

        # Row id as the idempotency key: a retry after an upstream success we
        # never got to record won't deliver the same email twice.
        await mailer.send_email(
            to=recipient, subject=subject, html=html, idempotency_key=str(row_id)
        )
    except Exception as exc:  # noqa: BLE001 — any failure retries via backoff, fails after MAX
        status = await _mark_failure(row_id, attempts_after, str(exc))
        logger.warning(
            "outbox: delivery failed row=%s attempt=%s (%s): %s",
            row_id,
            attempts_after,
            status,
            exc,
        )
        return status

    await _mark_sent(row_id)
    logger.info("outbox: sent row=%s", row_id)
    return "sent"


async def drain_once(limit: int = BATCH) -> dict[str, int]:
    """Claim and deliver up to `limit` due rows. Safe to call from anywhere."""
    due = await _poll_due(limit)
    sent = failed = requeued = skipped = lost = 0
    for row in due:
        if not await _claim(row):
            lost += 1  # another worker got there first
            continue
        outcome = await _deliver(row)
        if outcome == "sent":
            sent += 1
        elif outcome == "failed":
            failed += 1
        elif outcome == "skipped":
            skipped += 1
        else:
            requeued += 1
    return {
        "due": len(due),
        "sent": sent,
        "failed": failed,
        "requeued": requeued,
        "skipped": skipped,
        "lost": lost,
    }


async def run_forever(idle_sleep: float = IDLE_SLEEP) -> None:
    logger.info("outbox worker: started")
    while True:
        try:
            try:
                await _maybe_sweep_overdue_reminders()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Reminder discovery is ancillary to delivery: a broken sweep
                # must never stop already-queued mail from draining.
                logger.exception("outbox worker: reminder sweep error")
            result = await drain_once()
            worked = result["sent"] + result["failed"] + result["requeued"]
            await asyncio.sleep(BUSY_SLEEP if worked else idle_sleep)
        except asyncio.CancelledError:
            logger.info("outbox worker: stopped")
            raise
        except Exception:
            logger.exception("outbox worker: cycle error")
            await asyncio.sleep(idle_sleep)
