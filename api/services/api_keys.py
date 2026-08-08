"""API-key minting and resolution for the public ``/v1`` API.

The public API authenticates with an ``x-access-token`` header (Sessionboard's
own convention), not a Clerk JWT. A key is minted once, shown once, and only its
SHA-256 hash is persisted in ``api_tokens.token_hash`` — exactly how magic-link
tokens are stored (``services.magic_links.hash_token`` is reused so the two can
never drift apart). A lost key is rotated, never recovered.

Keys are formatted ``dais_<uuid4 hex>`` so they are recognisable in logs and a
malformed value can be rejected before it ever hits the database.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from services.magic_links import hash_token
from services.supabase_helpers import db, first
from supabase_client import supabase

logger = logging.getLogger(__name__)

# Recognisable, greppable, and unlikely to collide with a JWT.
KEY_PREFIX = "dais_"

# A single read scope is enough for every /v1 endpoint today. Writes are out of
# scope for the public API, so a token that only carries "read" can still do
# everything the API exposes — the scope is recorded for the day writes land.
DEFAULT_SCOPES: tuple[str, ...] = ("read",)


def generate_key() -> str:
    """A fresh raw key. High-entropy (uuid4) with a stable, greppable prefix."""
    return f"{KEY_PREFIX}{uuid.uuid4().hex}"


async def mint_api_key(
    org_id: str,
    name: str,
    scopes: list[str] | tuple[str, ...] | None = None,
) -> str:
    """Create an API token for ``org_id`` and return the RAW key (once).

    Only the hash is written; the raw value is returned to the caller to show
    the user a single time. ``org_id`` comes from the authenticated request,
    never from the body.
    """
    raw = generate_key()
    record = {
        "org_id": org_id,
        "name": (name or "").strip() or "API token",
        "token_hash": hash_token(raw),
        "scopes": list(scopes) if scopes else list(DEFAULT_SCOPES),
    }
    created = first(
        await db(
            lambda: supabase.table("api_tokens").insert(record).execute(),
            "mint_api_key",
        )
    )
    if not created:
        raise RuntimeError("Could not create API token")
    return raw


async def resolve_api_key(raw: str | None) -> tuple[str, list[str]] | None:
    """Look up a raw key → ``(org_id, scopes)`` or ``None``.

    Fails closed on anything that is not a well-formed ``dais_`` key before
    touching the database. On a hit, best-effort stamps ``last_used_at`` so an
    operator can see whether a token is live (a failed stamp never fails the
    request the caller is authenticating).
    """
    if not raw or not raw.startswith(KEY_PREFIX):
        return None

    row = first(
        await db(
            lambda: supabase.table("api_tokens")
            .select("id, org_id, scopes")
            .eq("token_hash", hash_token(raw))
            .limit(1)
            .execute(),
            "resolve_api_key",
        )
    )
    if not row:
        return None

    try:
        await db(
            lambda: supabase.table("api_tokens")
            .update({"last_used_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", row["id"])
            .execute(),
            "api_key_touch",
        )
    except Exception:
        logger.warning("api_keys: last_used_at stamp failed", exc_info=True)

    return row["org_id"], list(row.get("scopes") or [])
