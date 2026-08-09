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
import os
from datetime import datetime, timedelta, timezone

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


def is_enabled() -> bool:
    """The loop only runs where explicitly turned on (prod). Off in tests."""
    return (os.getenv("OUTBOX_WORKER_ENABLED", "0") or "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


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
            result = await drain_once()
            worked = result["sent"] + result["failed"] + result["requeued"]
            await asyncio.sleep(BUSY_SLEEP if worked else idle_sleep)
        except asyncio.CancelledError:
            logger.info("outbox worker: stopped")
            raise
        except Exception:
            logger.exception("outbox worker: cycle error")
            await asyncio.sleep(idle_sleep)
