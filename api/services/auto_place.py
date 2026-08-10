"""One-action auto-placement: fill the grid's holes without making a mess.

The organizer's last mile on the agenda is mechanical — a dozen accepted talks
still in the tray, each needing a room and a time that collides with nothing.
This is that mile as a single button: take everything unscheduled, walk the
event's real days/rooms/slots in order, and drop each session into the FIRST
opening where it introduces no conflict at all.

Three commitments shape the code:

  * **The rule engine is not re-implemented.** Every candidate placement is
    validated by `services.scheduling.conflicts_for_session` — the same sweep
    the conflicts endpoint and (via its TypeScript twin) the drag preview use.
    Auto-placement can therefore never invent a placement the grid would then
    flag red. If a candidate produces even one conflict, it is not used.
  * **Deterministic.** Sessions are ordered (status, title, id) and openings are
    walked (day, slot, room) — no dictionary iteration order, no clock. The same
    board auto-places to the same schedule every time, which is what makes the
    action safe to press twice.
  * **Never forced.** A session with nowhere to go is *skipped with a reason*,
    not crammed into a slot that breaks the programme. Skipping is a result, not
    a failure.

Geometry mirrors the builder exactly (`web/src/lib/scheduleApi.ts`): the event's
own `day_start`/`day_end`/`slot_minutes`, the same fallbacks, and slots resolved
in the EVENT's timezone — so an auto-placed card lands on precisely the grid line
a hand-dropped one would, and the public schedule reads back the same clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from services.scheduling import (
    ScheduledSession,
    conflicts_for_session,
    format_minutes,
    parse_timestamp,
    scheduled_session,
)

#: Mirrors `SCHEDULABLE_STATUSES` in routes/schedule_routes.py — the order the
#: tray is worked through, most-decided first. A pending talk is placed only
#: after every accepted one has a home. (Kept here rather than imported so a
#: service never depends on a route; `test_auto_place.py` pins the two together.)
STATUS_ORDER = ("accepted", "accept_queue", "pending")

#: The builder's own fallbacks (web/src/lib/scheduleApi.ts). The columns are NOT
#: NULL in Postgres, so these only matter for a hand-made payload — but they have
#: to agree with the browser's or an auto-placed card would sit off the lattice.
DEFAULT_DAY_START_MIN = 9 * 60
DEFAULT_DAY_END_MIN = 17 * 60
DEFAULT_SLOT_MINUTES = 15

#: Same last-resort card length the agenda payload derives with.
DEFAULT_DURATION_MIN = 30

#: A conference is days, not centuries — bounds the day walk on bad data.
MAX_DAYS = 366

NO_ROOMS = "No rooms on this event yet — add one and try again."
NO_OPENING = "No conflict-free slot left on the grid."


# ── result shapes ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Placement:
    """A session and the (room, instant) the planner chose for it."""

    session_id: str
    title: str
    room_id: str
    #: Explicit-UTC ISO text, the same form the drag path writes.
    starts_at: str
    ends_at: str

    def as_dict(self) -> dict:
        return {
            "id": self.session_id,
            "title": self.title,
            "room_id": self.room_id,
            "starts_at": self.starts_at,
            "ends_at": self.ends_at,
        }


@dataclass(frozen=True)
class Skipped:
    """A session that stayed in the tray, and why — never a silent drop."""

    session_id: str
    title: str
    reason: str

    def as_dict(self) -> dict:
        return {"id": self.session_id, "title": self.title, "reason": self.reason}


@dataclass(frozen=True)
class AutoPlacePlan:
    """What one press of the button would do. Pure: nothing is written here."""

    placed: tuple[Placement, ...] = ()
    skipped: tuple[Skipped, ...] = ()

    def as_dict(self) -> dict:
        return {
            "placed": [p.as_dict() for p in self.placed],
            "skipped": [s.as_dict() for s in self.skipped],
        }


@dataclass(frozen=True)
class Grid:
    """The lattice openings are counted on — the builder's, to the minute."""

    day_start_min: int
    day_end_min: int
    slot_minutes: int
    slot_count: int

    def slot_start(self, slot: int) -> int:
        return self.day_start_min + slot * self.slot_minutes


# ── geometry (a mirror of web/src/lib/scheduleApi.ts) ──────────────────────


def parse_clock_minutes(value: object) -> int | None:
    """`"09:00:00"` -> 540. Anything unparseable is None, never a crash."""
    if not value or not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if len(parts) < 2:
        return None
    try:
        hours, minutes = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hours <= 23 and 0 <= minutes <= 59):
        return None
    return hours * 60 + minutes


def grid_geometry(event: dict | None) -> Grid:
    """The event's own day window and slot width, with the builder's fallbacks.

    A day that ends before it starts, or a zero-width slot, would leave the grid
    with no rows at all — so both fall back rather than propagate a schedule
    nothing can be placed on.
    """
    event = event or {}
    day_start_min = parse_clock_minutes(event.get("day_start"))
    if day_start_min is None:
        day_start_min = DEFAULT_DAY_START_MIN

    raw_slot = event.get("slot_minutes")
    slot_minutes = int(raw_slot) if isinstance(raw_slot, int) and raw_slot > 0 else DEFAULT_SLOT_MINUTES

    parsed_end = parse_clock_minutes(event.get("day_end"))
    if parsed_end is None:
        parsed_end = DEFAULT_DAY_END_MIN
    day_end_min = (
        parsed_end
        if parsed_end > day_start_min
        else day_start_min + (DEFAULT_DAY_END_MIN - DEFAULT_DAY_START_MIN)
    )

    span = day_end_min - day_start_min
    slot_count = max(1, -(-span // slot_minutes))  # ceil, integer-only
    return Grid(day_start_min, day_end_min, slot_minutes, slot_count)


def resolve_zone(name: object) -> ZoneInfo | timezone:
    """The event's IANA zone, or UTC. An unknown name is a label, not an error."""
    if isinstance(name, str) and name.strip():
        try:
            return ZoneInfo(name.strip())
        except Exception:  # noqa: BLE001 — a bad tz on a row must not 500 the button
            return timezone.utc
    return timezone.utc


def local_day(value: object, zone: ZoneInfo | timezone) -> str | None:
    """The "YYYY-MM-DD" an instant falls on in the event zone — which day tab."""
    parsed = parse_timestamp(value)
    return parsed.astimezone(zone).date().isoformat() if parsed else None


def event_days(agenda: dict, zone: ZoneInfo | timezone) -> list[str]:
    """Every conference day the builder shows, in the event zone, sorted.

    The event's own start→end span and NOTHING else — the same set as
    `agendaDays` in the browser, so auto-placement can only ever use days that
    have a tab. It deliberately no longer unions in the days sessions happen to
    sit on: a stale placement in a month the conference does not run is a defect
    to fix, not a day to schedule more talks onto.

    An event with NO configured span has no span to clamp to, and falls back to
    the union of days something is already placed on (else today, in the event's
    own clock) — a board always has at least one day to fill.
    """
    event = agenda.get("event") or {}
    days: set[str] = set()

    start = local_day(event.get("starts_at"), zone)
    if start:
        days.add(start)
        # The event's end is exclusive: an event ending exactly at local midnight
        # belongs to the previous day, so read the day of the minute before it.
        end_instant = parse_timestamp(event.get("ends_at"))
        end = (
            (end_instant - timedelta(minutes=1)).astimezone(zone).date().isoformat()
            if end_instant
            else None
        )
        if end and end > start:
            cursor = date.fromisoformat(start)
            last = date.fromisoformat(end)
            guard = 0
            while cursor < last and guard < MAX_DAYS:
                cursor += timedelta(days=1)
                days.add(cursor.isoformat())
                guard += 1
        return sorted(days)

    for session in agenda.get("sessions") or []:
        placed_day = local_day(session.get("starts_at"), zone)
        if placed_day:
            days.add(placed_day)
    if not days:
        days.add(datetime.now(timezone.utc).astimezone(zone).date().isoformat())
    return sorted(days)


def _instants(day: str, start_min: int, duration_min: int, zone: ZoneInfo | timezone) -> tuple[str, str]:
    """(local day, local minute) -> the (starts_at, ends_at) pair to store.

    The START is a wall clock resolved in the event zone — exactly what
    `buildZonedTimestamp` does — and the END is derived by adding minutes to that
    *instant*, like `addMinutesToIso`, so a session spanning a DST change keeps
    its real length instead of stretching an hour.
    """
    parts = date.fromisoformat(day)
    local_start = datetime(parts.year, parts.month, parts.day, tzinfo=zone) + timedelta(
        minutes=start_min
    )
    start_utc = local_start.astimezone(timezone.utc)
    end_utc = start_utc + timedelta(minutes=duration_min)
    return (
        start_utc.replace(microsecond=0).isoformat(),
        end_utc.replace(microsecond=0).isoformat(),
    )


# ── the plan ───────────────────────────────────────────────────────────────


def _duration_of(session: dict) -> int:
    raw = session.get("duration_min")
    return int(raw) if isinstance(raw, int) and raw > 0 else DEFAULT_DURATION_MIN


def _speaker_ids(session: dict) -> tuple[str, ...]:
    return tuple(
        str(speaker.get("contact_id"))
        for speaker in session.get("speakers") or []
        if speaker.get("contact_id")
    )


def _is_placed(session: dict) -> bool:
    return bool(session.get("room_id")) and bool(session.get("starts_at"))


def _tray_order(session: dict) -> tuple[int, str, str]:
    """Accepted before accept_queue before pending; then title, then id.

    Stable on purpose: the button must be idempotent in the sense that matters —
    the same board always produces the same schedule, so pressing it twice is
    never a surprise.
    """
    status = str(session.get("status") or "")
    rank = STATUS_ORDER.index(status) if status in STATUS_ORDER else len(STATUS_ORDER)
    return (rank, str(session.get("title") or "").casefold(), str(session.get("id")))


def plan_auto_placements(agenda: dict) -> AutoPlacePlan:
    """Greedily fit every unscheduled session into the earliest clean opening.

    Pure — it decides, the route writes. `agenda` is the payload
    `routes/schedule_routes._assemble_agenda` builds (event geometry, ordered
    rooms, sessions carrying `duration_min` and their speakers).

    For each session, in tray order, the first (day, slot, room) whose placement
    adds ZERO conflicts against everything already on the board *and* everything
    this run has already placed wins. Conflicts are not guessed at here: the
    candidate is handed to the shared rule engine, which answers for room
    double-booking and speaker double-booking alike.
    """
    event = agenda.get("event") or {}
    zone = resolve_zone(event.get("timezone"))
    grid = grid_geometry(event)
    days = event_days(agenda, zone)
    rooms = [str(room["id"]) for room in agenda.get("rooms") or [] if room.get("id")]

    sessions = list(agenda.get("sessions") or [])
    # The board as it stands. New placements join this list as they are decided,
    # so the run never double-books itself.
    board: list[ScheduledSession] = []
    for session in sessions:
        existing = scheduled_session(
            session,
            duration_min=_duration_of(session),
            speaker_ids=_speaker_ids(session),
        )
        if existing:
            board.append(existing)

    tray = sorted((s for s in sessions if not _is_placed(s)), key=_tray_order)

    placed: list[Placement] = []
    skipped: list[Skipped] = []

    day_window = f"{format_minutes(grid.day_start_min)}–{format_minutes(grid.day_end_min)}"

    for session in tray:
        session_id = str(session.get("id"))
        title = str(session.get("title") or "Untitled session")
        duration = _duration_of(session)
        speakers = _speaker_ids(session)

        if not rooms:
            skipped.append(Skipped(session_id, title, NO_ROOMS))
            continue
        if duration > grid.day_end_min - grid.day_start_min:
            skipped.append(
                Skipped(session_id, title, f"{duration} min is longer than the {day_window} day.")
            )
            continue

        chosen: Placement | None = None
        for day in days:
            for slot in range(grid.slot_count):
                start_min = grid.slot_start(slot)
                # A session may not spill past the end of the conference day.
                if start_min + duration > grid.day_end_min:
                    break
                starts_at, ends_at = _instants(day, start_min, duration, zone)
                for room_id in rooms:
                    candidate = scheduled_session(
                        {"id": session_id, "room_id": room_id, "starts_at": starts_at},
                        duration_min=duration,
                        speaker_ids=speakers,
                    )
                    # The shared engine, not a second opinion: zero conflicts or
                    # this opening is not an opening.
                    if candidate and not conflicts_for_session(candidate, board):
                        chosen = Placement(session_id, title, room_id, starts_at, ends_at)
                        board.append(candidate)
                        break
                if chosen:
                    break
            if chosen:
                break

        if chosen:
            placed.append(chosen)
        else:
            skipped.append(Skipped(session_id, title, NO_OPENING))

    return AutoPlacePlan(tuple(placed), tuple(skipped))
