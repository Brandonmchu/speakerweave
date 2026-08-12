"""Validated, event-scoped public branding documents.

The JSONB column is intentionally opaque to the rest of the application.  All
callers validate patches here and resolve stored documents here so pre-021 rows
and partially configured events expose the same complete contract.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException

FONT_TOKENS = (
    "instrument-sans",
    "instrument-serif",
    "inter",
    "space-grotesk",
    "dm-sans",
    "ibm-plex-sans",
    "figtree",
    "playfair-display",
    "source-serif",
    "lora",
    "jetbrains-mono",
    "ibm-plex-mono",
)
RADIUS_VALUES = ("none", "small", "medium", "large")
SCHEDULE_LAYOUT_VALUES = ("list", "tracks", "grid")
SPEAKER_LAYOUT_VALUES = ("grid", "list")
DENSITY_VALUES = ("comfortable", "compact")
HEADER_STYLE_VALUES = ("minimal", "banner")

DEFAULT_BRANDING: dict[str, Any] = {
    "accent": None,
    "background": None,
    "surface": None,
    "ink": None,
    "heading_font": "instrument-serif",
    "body_font": "instrument-sans",
    "radius": "medium",
    "schedule_layout": "list",
    "speaker_layout": "grid",
    "density": "comfortable",
    "header_style": "minimal",
    "logo_url": None,
    "logo_path": None,
    "favicon_url": None,
    "favicon_path": None,
    "show_powered_by": True,
}

COLOR_KEYS = frozenset({"accent", "background", "surface", "ink"})
SERVER_MANAGED_KEYS = frozenset(
    {"logo_url", "logo_path", "favicon_url", "favicon_path"}
)
CLIENT_SETTABLE_KEYS = tuple(
    key for key in DEFAULT_BRANDING if key not in SERVER_MANAGED_KEYS
)
ENUM_VALUES: dict[str, tuple[str, ...]] = {
    "heading_font": FONT_TOKENS,
    "body_font": FONT_TOKENS,
    "radius": RADIUS_VALUES,
    "schedule_layout": SCHEDULE_LAYOUT_VALUES,
    "speaker_layout": SPEAKER_LAYOUT_VALUES,
    "density": DENSITY_VALUES,
    "header_style": HEADER_STYLE_VALUES,
}
_HEX_RE = re.compile(r"^[0-9a-fA-F]{6}$")


def _invalid(key: str, message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=f"branding.{key} {message}")


def validate_branding_patch(patch: dict) -> dict:
    """Validate and normalize a client-authored merge patch.

    Errors are deliberately corrective: each names the exact key and tells an
    agent or UI which values are accepted.
    """
    if not isinstance(patch, dict):
        raise HTTPException(
            status_code=400,
            detail="branding must be an object; valid keys: "
            + ", ".join(CLIENT_SETTABLE_KEYS),
        )

    normalized: dict[str, Any] = {}
    for key, value in patch.items():
        if key not in DEFAULT_BRANDING:
            raise _invalid(
                str(key),
                "is unknown; valid keys: " + ", ".join(CLIENT_SETTABLE_KEYS),
            )
        if key in SERVER_MANAGED_KEYS:
            raise _invalid(
                key,
                "is server-managed; valid client-settable keys: "
                + ", ".join(CLIENT_SETTABLE_KEYS),
            )
        # null means "reset to the default" for EVERY client-settable key, not
        # just the nullable colors. `merge_branding` already reads it that way;
        # accepting it here uniformly is what lets one caller clear a font or a
        # layout without having to know which product default it is restoring.
        if value is None:
            normalized[key] = None
            continue
        if key in COLOR_KEYS:
            if not isinstance(value, str):
                raise _invalid(
                    key,
                    "must be null or 6 hexadecimal digits; valid format: RRGGBB",
                )
            candidate = value.strip().removeprefix("#")
            if not _HEX_RE.fullmatch(candidate):
                raise _invalid(
                    key,
                    "must be null or 6 hexadecimal digits; valid format: RRGGBB",
                )
            normalized[key] = candidate.lower()
            continue
        if key in ENUM_VALUES:
            valid = ENUM_VALUES[key]
            if not isinstance(value, str) or value not in valid:
                raise _invalid(key, "must be one of these valid values: " + ", ".join(valid))
            normalized[key] = value
            continue
        if key == "show_powered_by":
            if not isinstance(value, bool):
                raise _invalid(key, "must be one of these valid values: true, false")
            normalized[key] = value
            continue
        raise _invalid(key, "is not client-settable")  # pragma: no cover
    return normalized


def merge_branding(existing: dict, patch: dict) -> dict:
    """Apply merge-patch semantics while retaining omitted keys."""
    merged = {
        key: value
        for key, value in (existing.items() if isinstance(existing, dict) else ())
        if key in DEFAULT_BRANDING
    }
    for key, value in patch.items():
        if key not in DEFAULT_BRANDING:
            continue
        merged[key] = DEFAULT_BRANDING[key] if value is None else value
    return merged


def resolve_branding(row: dict) -> dict:
    """Return a complete branding document from an event or stored blob."""
    stored = row.get("branding") if isinstance(row, dict) and "branding" in row else row
    resolved = dict(DEFAULT_BRANDING)
    if isinstance(stored, dict):
        for key in DEFAULT_BRANDING:
            if key in stored:
                resolved[key] = stored[key]
    return resolved
