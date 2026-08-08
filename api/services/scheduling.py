"""Conflict detection for the agenda — the server half of one shared model.

This mirrors `web/src/lib/schedule.ts` function for function: half-open
intervals, the same pair ordering, the same wording in `detail`. The browser
runs the TypeScript copy while a card is being dragged (instant feedback, no
round trip); this one is the authority the grid reconciles against on load.

Two implementations of one rule are a liability unless they agree exactly, so
`tests/fixtures/schedule_conflicts.json` is fed to BOTH — `test_scheduling.py`
here and `web/tests/scheduleParity.test.ts` there. A change to either
implementation that the other does not follow fails a suite.

Time is integer minutes, never timestamps. The grid thinks in minutes, and
integer comparison has no timezone or DST edge cases; `minutes_from_timestamp`
is the single place a stored `timestamptz` becomes a minute count (epoch
minutes, UTC), which keeps ordering global while `format_minutes` still reads
back the wall clock the organizer placed the card at.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

ROOM_OVERLAP = "room_overlap"
SPEAKER_OVERLAP = "speaker_overlap"

MINUTES_PER_DAY = 1440


@dataclass(frozen=True)
class ScheduledSession:
    """A session with both a room and a start — the only kind that can collide."""

    id: str
    room_id: str
    start_min: int
    duration_min: int
    speaker_ids: tuple[str, ...] = ()

    @property
    def end_min(self) -> int:
        """Exclusive end of the half-open interval [start_min, end_min)."""
        return self.start_min + self.duration_min


@dataclass(frozen=True)
class Conflict:
    type: str
    #: Always ordered by (start_min, id) so the pair is stable across runs.
    session_ids: tuple[str, str]
    #: Operator-facing, e.g. "Ada Lovelace is in two rooms at 09:30".
    detail: str

    def as_dict(self) -> dict:
        return {
            "type": self.type,
            "session_ids": list(self.session_ids),
            "detail": self.detail,
        }


#: {"speakers": {contact_id: name}, "rooms": {room_id: name}}. Optional — the
#: detection is identical without it, the messages just fall back to raw ids.
Labels = dict[str, dict[str, str]]


def _label(labels: Labels | None, kind: str, key: str) -> str:
    return ((labels or {}).get(kind) or {}).get(key) or key


def format_minutes(minutes: int) -> str:
    """570 -> "09:30". Mods by a day, so epoch minutes read as a wall clock."""
    total = minutes % MINUTES_PER_DAY
    return f"{total // 60:02d}:{total % 60:02d}"


def overlap_start(a_start: int, a_end: int, b_start: int, b_end: int) -> int | None:
    """First shared minute of [a_start, a_end) and [b_start, b_end), or None.

    HALF-OPEN on purpose: a session ending at minute X does not collide with
    one starting at X. Back-to-back programming is the normal case, not a bug.
    """
    start = max(a_start, b_start)
    end = min(a_end, b_end)
    return start if start < end else None


def _order_pair(a: ScheduledSession, b: ScheduledSession) -> tuple[str, str]:
    """Stable pair ordering: earlier start first, id as the tiebreak."""
    if a.start_min < b.start_min:
        return (a.id, b.id)
    if b.start_min < a.start_min:
        return (b.id, a.id)
    return (a.id, b.id) if a.id <= b.id else (b.id, a.id)


def pair_conflicts(
    a: ScheduledSession,
    b: ScheduledSession,
    labels: Labels | None = None,
) -> list[Conflict]:
    """Every conflict between exactly two placed sessions.

    A pair can produce more than one: same room *and* a shared speaker are two
    distinct problems, and two shared speakers are two more — the operator has
    to resolve each by name.
    """
    at = overlap_start(a.start_min, a.end_min, b.start_min, b.end_min)
    if at is None:
        return []

    session_ids = _order_pair(a, b)
    when = format_minutes(at)
    same_room = a.room_id == b.room_id
    conflicts: list[Conflict] = []

    if same_room:
        conflicts.append(
            Conflict(
                type=ROOM_OVERLAP,
                session_ids=session_ids,
                detail=f"{_label(labels, 'rooms', a.room_id)} is double-booked at {when}",
            )
        )

    b_speakers = set(b.speaker_ids)
    for speaker_id in a.speaker_ids:
        if speaker_id not in b_speakers:
            continue
        name = _label(labels, "speakers", speaker_id)
        conflicts.append(
            Conflict(
                type=SPEAKER_OVERLAP,
                session_ids=session_ids,
                detail=(
                    f"{name} is booked twice at {when}"
                    if same_room
                    else f"{name} is in two rooms at {when}"
                ),
            )
        )

    return conflicts


def detect_conflicts(
    sessions: list[ScheduledSession],
    labels: Labels | None = None,
) -> list[Conflict]:
    """Full sweep over the schedule.

    Sorting by start lets the inner loop stop as soon as a candidate starts at
    or after the current session's end — everything later starts later still.
    """
    placed = sorted(sessions, key=lambda s: (s.start_min, s.id))

    conflicts: list[Conflict] = []
    for i, a in enumerate(placed):
        a_end = a.end_min
        for b in placed[i + 1 :]:
            if b.start_min >= a_end:
                break
            conflicts.extend(pair_conflicts(a, b, labels))
    return conflicts


def conflicts_for_session(
    candidate: ScheduledSession,
    others: list[ScheduledSession],
    labels: Labels | None = None,
) -> list[Conflict]:
    """The delta: conflicts one placement would introduce. O(n), not O(n²)."""
    conflicts: list[Conflict] = []
    for other in others:
        if other.id == candidate.id:
            continue
        conflicts.extend(pair_conflicts(candidate, other, labels))
    return conflicts


# ── timestamps -> minutes ──────────────────────────────────────────────────


def parse_timestamp(value: object) -> datetime | None:
    """A stored `timestamptz` (ISO text) or an already-parsed datetime -> UTC.

    A naive value is read as UTC, which is also how the scheduling routes write
    one back, so a placement round-trips to the same wall clock.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def minutes_from_timestamp(value: object) -> int | None:
    """Epoch minutes (UTC). Global ordering; `format_minutes` recovers the clock."""
    parsed = parse_timestamp(value)
    if parsed is None:
        return None
    return int(parsed.timestamp() // 60)


def duration_minutes(starts_at: object, ends_at: object) -> int | None:
    """Length of a placed session, or None when either end is missing/invalid."""
    start = minutes_from_timestamp(starts_at)
    end = minutes_from_timestamp(ends_at)
    if start is None or end is None:
        return None
    span = end - start
    return span if span > 0 else None


def scheduled_session(
    row: dict,
    *,
    duration_min: int,
    speaker_ids: tuple[str, ...] = (),
) -> ScheduledSession | None:
    """A `sessions` row -> the conflict model, or None when it isn't placed."""
    room_id = row.get("room_id")
    start_min = minutes_from_timestamp(row.get("starts_at"))
    if not room_id or start_min is None:
        return None
    return ScheduledSession(
        id=str(row.get("id")),
        room_id=str(room_id),
        start_min=start_min,
        duration_min=max(1, int(duration_min)),
        speaker_ids=speaker_ids,
    )
