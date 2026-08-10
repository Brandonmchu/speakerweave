"""Provider-neutral semantic events and Server-Sent Event serialization."""

from __future__ import annotations

import json
from typing import Any

PUBLIC_EVENT_TYPES = frozenset(
    {
        "thread_started",
        "message_delta",
        "message_complete",
        "progress",
        "reasoning",
        "permission_request",
        "permission_resolved",
        "navigate",
        "entity_update",
        "thread_update",
        "complete",
        "error",
        "cancelled",
        "keepalive",
    }
)

INTERNAL_EVENT_TYPES = frozenset({"runtime_complete", "runtime_cancelled", "stream_done"})


def semantic_event(event_type: str, **payload: Any) -> dict[str, Any]:
    """Create one semantic event and fail loudly on vocabulary drift."""
    if event_type not in PUBLIC_EVENT_TYPES | INTERNAL_EVENT_TYPES:
        raise ValueError(f"Unknown agent event type: {event_type}")
    return {"type": event_type, **payload}


def format_sse_event(event_type: str, data: dict[str, Any] | None = None) -> str:
    """Serialize the frozen wire format: one JSON object in an SSE data frame."""
    if event_type not in PUBLIC_EVENT_TYPES:
        raise ValueError(f"Internal event cannot be sent over SSE: {event_type}")
    return f"data: {json.dumps({'type': event_type, **(data or {})}, default=str)}\n\n"
