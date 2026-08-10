"""Single-use magic links and the short-lived portal sessions they create.

Only SHA-256 hashes of magic-link tokens are persisted.  The raw value exists
long enough for the caller to put it in an email, then redemption exchanges it
for a signed, HttpOnly-cookie session.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

from services.supabase_helpers import db, first
from supabase_client import supabase

logger = logging.getLogger(__name__)

MAGIC_LINK_PURPOSES = {"portal", "review", "demo"}
PORTAL_SESSION_PURPOSES = {"portal", "review"}

# Purposes whose link is a BEARER credential rather than a one-shot sign-in.
#
# A reviewer link is the reviewer's only way back into their scorecard: it lives
# in an email they reopen over the days of a review round, on more than one
# device, and behind mail clients that pre-fetch links. Consuming it on first
# sight turned every second visit into "this link is already used" — a dead end
# with no self-serve recovery, since a reviewer has no account to sign into.
# So a review link validates without being consumed, exactly like the submitter
# manage link (services/submitter_selfservice). It stays bounded the same way:
# it is scoped to one org + one evaluator, expires (168h at mint), and an
# organizer can revoke it — the ONLY thing dropped is single-use.
REUSABLE_PURPOSES = {"review"}


class InvalidMagicLinkError(ValueError):
    """The supplied link cannot be redeemed."""


def generate_token() -> str:
    """Return a high-entropy token that is safe to embed in a URL."""
    return secrets.token_urlsafe(32)


def hash_token(raw: str) -> str:
    """One-way representation stored in ``magic_link_tokens``."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now(value: datetime | None = None) -> datetime:
    current = value or datetime.now(timezone.utc)
    return current if current.tzinfo else current.replace(tzinfo=timezone.utc)


def _parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def mint(
    org_id: str,
    purpose: str,
    *,
    contact_id: str | None = None,
    evaluator_id: str | None = None,
    ttl_hours: float,
    now: datetime | None = None,
) -> str:
    """Persist a token hash and return the raw token for delivery."""
    if purpose not in MAGIC_LINK_PURPOSES:
        raise ValueError("Unsupported magic-link purpose")
    if ttl_hours <= 0:
        raise ValueError("ttl_hours must be positive")

    current = _now(now)
    raw = generate_token()
    result = await db(
        lambda: supabase.table("magic_link_tokens")
        .insert(
            {
                "org_id": org_id,
                "token_hash": hash_token(raw),
                "purpose": purpose,
                "contact_id": contact_id,
                "evaluator_id": evaluator_id,
                "expires_at": (current + timedelta(hours=ttl_hours)).isoformat(),
            }
        )
        .execute(),
        "magic_link_mint",
    )
    if not first(result):
        raise RuntimeError("Could not create magic link")
    return raw


async def redeem(raw: str, *, now: datetime | None = None) -> dict:
    """Validate a magic link and return its portal context.

    Single-use purposes are consumed atomically here. A purpose in
    ``REUSABLE_PURPOSES`` is validated and left alone, so reopening the same
    link works for as long as it is unrevoked and unexpired.
    """
    current = _now(now)
    result = await db(
        lambda: supabase.table("magic_link_tokens")
        .select(
            "id, org_id, purpose, contact_id, evaluator_id, "
            "expires_at, used_at, revoked_at"
        )
        .eq("token_hash", hash_token(raw))
        .limit(1)
        .execute(),
        "magic_link_lookup",
    )
    row = first(result)
    reusable = bool(row) and row.get("purpose") in REUSABLE_PURPOSES
    expires_at = _parse_timestamp(row.get("expires_at")) if row else None
    if (
        not row
        or row.get("revoked_at") is not None
        or (row.get("used_at") is not None and not reusable)
        or expires_at is None
        or expires_at <= current
    ):
        raise InvalidMagicLinkError("Magic link is invalid or expired")

    if reusable:
        # Nothing to consume: expiry and revocation are the whole guard. The
        # first-seen stamp is still recorded (best effort) so an organizer can
        # tell an opened invitation from an untouched one.
        if row.get("used_at") is None:
            try:
                await db(
                    lambda: supabase.table("magic_link_tokens")
                    .update({"used_at": current.isoformat()})
                    .eq("id", row["id"])
                    .is_("used_at", "null")
                    .execute(),
                    "magic_link_mark_seen",
                )
            except Exception:  # a stamp is never worth failing a valid sign-in
                logger.warning("magic link: could not stamp first use", exc_info=True)
        return {
            "org_id": row.get("org_id"),
            "purpose": row.get("purpose"),
            "contact_id": row.get("contact_id"),
            "evaluator_id": row.get("evaluator_id"),
        }

    # Re-check every validity condition in the UPDATE itself. If two requests
    # race after the lookup, only one can change used_at from NULL and receive a
    # row back; the loser is rejected below.
    consumed = first(
        await db(
            lambda: supabase.table("magic_link_tokens")
            .update({"used_at": current.isoformat()})
            .eq("id", row["id"])
            .is_("used_at", "null")
            .is_("revoked_at", "null")
            .gt("expires_at", current.isoformat())
            .execute(),
            "magic_link_consume",
        )
    )
    if not consumed:
        raise InvalidMagicLinkError("Magic link is invalid or expired")

    return {
        "org_id": consumed.get("org_id"),
        "purpose": consumed.get("purpose"),
        "contact_id": consumed.get("contact_id"),
        "evaluator_id": consumed.get("evaluator_id"),
    }


def _session_secret() -> str | None:
    return os.getenv("PORTAL_SESSION_SECRET") or os.getenv("SUPABASE_JWT_SECRET")


def issue_session(
    purpose: str,
    org_id: str,
    *,
    contact_id: str | None = None,
    evaluator_id: str | None = None,
    ttl_hours: float = 72,
) -> str:
    """Create a compact HS256 session token for an HttpOnly cookie."""
    secret = _session_secret()
    if not secret:
        raise RuntimeError("PORTAL_SESSION_SECRET is not configured")
    if purpose not in PORTAL_SESSION_PURPOSES:
        raise ValueError("Unsupported portal session purpose")
    if ttl_hours <= 0:
        raise ValueError("ttl_hours must be positive")

    current = datetime.now(timezone.utc)
    claims: dict[str, Any] = {
        "purpose": purpose,
        "org_id": org_id,
        "iat": current,
        "exp": current + timedelta(hours=ttl_hours),
    }
    if contact_id is not None:
        claims["contact_id"] = contact_id
    if evaluator_id is not None:
        claims["evaluator_id"] = evaluator_id
    return jwt.encode(claims, secret, algorithm="HS256")


def read_session(cookie_value: str) -> dict | None:
    """Verify a portal cookie and return its claims, or ``None`` if unusable."""
    secret = _session_secret()
    if not secret or not cookie_value:
        return None
    try:
        claims = jwt.decode(
            cookie_value,
            secret,
            algorithms=["HS256"],
            options={"verify_exp": True, "require": ["exp", "purpose", "org_id"]},
        )
    except jwt.InvalidTokenError:
        return None

    if claims.get("purpose") not in PORTAL_SESSION_PURPOSES:
        return None
    if not isinstance(claims.get("org_id"), str) or not claims["org_id"]:
        return None
    return claims
