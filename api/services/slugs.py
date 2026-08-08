"""Slugs: readable, ASCII, and unique against the table that owns them.

`events.slug` and `forms.slug` are both GLOBALLY unique (migration 001), not
unique per org — a collision is therefore possible between two tenants who
both run "AI Summit", and it must resolve without an error the organizer has
to think about. Hence: slugify, probe, and on a hit append a short random
suffix rather than a guessable counter (a counter tells tenant B that tenant A
exists).
"""

from __future__ import annotations

import logging
import re
import secrets
import string
import unicodedata
from uuid import uuid4

from services.supabase_helpers import db, first
from supabase_client import supabase

logger = logging.getLogger(__name__)

_SEPARATORS = re.compile(r"[^a-z0-9]+")
_SUFFIX_ALPHABET = string.ascii_lowercase + string.digits


def slugify(value: str | None, *, separator: str = "-", fallback: str = "item", max_length: int = 60) -> str:
    """'Café Sessions!' -> 'cafe-sessions'. Never empty, never non-ASCII."""
    ascii_value = (
        unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode("ascii")
    )
    slug = _SEPARATORS.sub(separator, ascii_value.strip().lower()).strip(separator)
    slug = slug[:max_length].strip(separator)
    return slug or fallback


def random_suffix(length: int = 4) -> str:
    return "".join(secrets.choice(_SUFFIX_ALPHABET) for _ in range(length))


def dedupe_name(base: str, taken: set[str], *, separator: str = "_", limit: int = 50) -> str:
    """First free name in base, base_2, base_3, … — for internal names, where a
    human reads the result and a stable counter is friendlier than randomness."""
    if base not in taken:
        return base
    for n in range(2, limit + 1):
        candidate = f"{base}{separator}{n}"
        if candidate not in taken:
            return candidate
    return f"{base}{separator}{uuid4().hex[:8]}"


async def unique_slug(table: str, base: str, *, column: str = "slug", attempts: int = 6) -> str:
    """A slug no row of `table` holds yet.

    Racy by construction (probe-then-insert), which is why the DB keeps its own
    UNIQUE constraint. This makes the common case pretty; the constraint makes
    the rare case correct.
    """
    candidate = base
    for _ in range(attempts):
        taken = first(
            await db(
                lambda value=candidate: supabase.table(table)
                .select(column)
                .eq(column, value)
                .limit(1)
                .execute(),
                f"{table}_slug_probe",
            )
        )
        if not taken:
            return candidate
        candidate = f"{base}-{random_suffix()}"

    logger.warning("slugs: %s exhausted suffix attempts for base=%r", table, base)
    return f"{base}-{uuid4().hex[:8]}"
