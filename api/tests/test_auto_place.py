"""Auto-placement: the one-action fill of the unscheduled tray.

Two things are worth proving and they are different in kind.

The *planner* (services/auto_place.py) is pure, so it is tested directly on
hand-built boards: does it walk days/slots/rooms in the order it promises, does
it refuse an opening the shared rule engine dislikes, does it say why when a
session cannot go anywhere. The important negative is speaker double-booking —
Postgres' EXCLUDE constraint has nothing to say about it, so if the planner did
not consult `services.scheduling` it would happily put one human in two rooms.

The *route* is tested against the in-memory PostgREST stand-in, because the
half that matters there is the org predicate on every write and the fact that
placements actually land on the rows (the button is worthless if the board is
the same after a refresh).

The seeding helpers (`seed_session`, `seed_speaker`, the exclusion-aware fake)
are borrowed from test_schedule.py so a session row means the same thing in both
files; the two fixtures below are local because pytest fixtures do not travel
across modules the way plain functions do.
"""

from __future__ import annotations

import pytest

from services.auto_place import (
    NO_OPENING,
    NO_ROOMS,
    STATUS_ORDER,
    event_days,
    grid_geometry,
    plan_auto_placements,
    resolve_zone,
)
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID
from tests.test_schedule import DAY, ExclusionSupabase, seed_session, seed_speaker, ts

AUTO_PLACE = f"/api/events/{TEST_EVENT_ID}/schedule/auto-place"

# The seeded event: 09:00–17:00 in America/Los_Angeles, 15-minute slots, two
# rooms ordered Main Hall then Workshop Room.
EVENT = {
    "timezone": "America/Los_Angeles",
    "starts_at": f"{DAY}T16:00:00+00:00",
    "day_start": "09:00:00",
    "day_end": "17:00:00",
    "slot_minutes": 15,
}
ROOMS = [{"id": "room-a", "name": "Main Hall"}, {"id": "room-b", "name": "Workshop Room"}]

#: 09:00 event-local on the seeded day, as the instant it is stored as.
NINE_AM = "2026-10-12T16:00:00+00:00"


def board(*sessions: dict, event: dict | None = None, rooms: list[dict] | None = None) -> dict:
    return {
        "event": {**EVENT, **(event or {})},
        "rooms": ROOMS if rooms is None else rooms,
        "tracks": [],
        "sessions": list(sessions),
    }


@pytest.fixture
def agenda_client():
    """A TestClient over just the schedule router."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from routes.schedule_routes import router

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def agenda_db(monkeypatch):
    """The same minimum grid the agenda suite uses: one event, two rooms.

    Rooms are seeded out of order on purpose — the payload sorts them by
    `order`, and the planner's "first room" must be the first COLUMN, not
    whichever row the store happened to hold first.
    """
    from routes import schedule_routes

    fake = ExclusionSupabase()
    monkeypatch.setattr(schedule_routes, "supabase", fake)

    fake.seed("orgs", {"org_id": TEST_ORG_ID, "name": "Dais Dev Org"})
    fake.seed(
        "events",
        {
            "id": TEST_EVENT_ID,
            "org_id": TEST_ORG_ID,
            "name": "AI Builders Summit",
            "slug": "ai-builders-summit",
            **EVENT,
        },
        {
            "id": OTHER_EVENT_ID,
            "org_id": OTHER_ORG_ID,
            "name": "Someone Else's Conf",
            "slug": "someone-else",
        },
    )
    fake.seed(
        "rooms",
        {
            "id": "room-b",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Workshop Room",
            "capacity": 60,
            "order": 1,
        },
        {
            "id": "room-a",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Main Hall",
            "capacity": 400,
            "order": 0,
        },
        {
            "id": "room-theirs",
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "name": "Not Yours",
            "capacity": 10,
            "order": 0,
        },
    )
    fake.seed(
        "formats",
        {
            "id": "format-1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Workshop",
            "default_duration_min": 90,
        },
    )
    return fake


def session(
    session_id: str,
    *,
    status: str = "accepted",
    duration_min: int = 30,
    starts_at: str | None = None,
    ends_at: str | None = None,
    room_id: str | None = None,
    speakers: list[str] | None = None,
    title: str | None = None,
) -> dict:
    return {
        "id": session_id,
        "title": title or f"Session {session_id}",
        "status": status,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "room_id": room_id,
        "track_id": None,
        "duration_min": duration_min,
        "speakers": [{"contact_id": c, "first_name": c, "last_name": ""} for c in (speakers or [])],
    }


# ── the planner ────────────────────────────────────────────────────────────


def test_the_status_order_matches_the_routes_schedulable_set():
    """The tray is worked accepted-first, and "schedulable" is defined once."""
    from routes.schedule_routes import SCHEDULABLE_STATUSES

    assert STATUS_ORDER == SCHEDULABLE_STATUSES


def test_geometry_mirrors_the_builders_lattice():
    grid = grid_geometry(EVENT)
    assert (grid.day_start_min, grid.day_end_min, grid.slot_minutes) == (540, 1020, 15)
    assert grid.slot_count == 32
    # A day that ends before it starts cannot produce a grid with no rows.
    broken = grid_geometry({"day_start": "17:00:00", "day_end": "09:00:00", "slot_minutes": 0})
    assert broken.day_end_min > broken.day_start_min and broken.slot_count > 0


def test_an_empty_board_places_the_first_session_at_the_first_slot():
    plan = plan_auto_placements(board(session("a")))

    assert [p.session_id for p in plan.placed] == ["a"]
    placement = plan.placed[0]
    # First room, first slot of the first day — 09:00 event-local, stored as the
    # instant that IS 09:00 in Los Angeles.
    assert placement.room_id == "room-a"
    assert placement.starts_at == NINE_AM
    assert placement.ends_at == "2026-10-12T16:30:00+00:00"
    assert plan.skipped == ()


def test_it_fills_across_rooms_before_moving_the_clock():
    """Two sessions with nothing in common: same slot, different rooms."""
    plan = plan_auto_placements(board(session("a"), session("b")))

    assert [(p.session_id, p.room_id, p.starts_at) for p in plan.placed] == [
        ("a", "room-a", NINE_AM),
        ("b", "room-b", NINE_AM),
    ]


def test_it_never_double_books_a_room_already_taken():
    """An existing placement is part of the board, not an obstacle to ignore."""
    plan = plan_auto_placements(
        board(
            session(
                "held",
                starts_at=NINE_AM,
                ends_at="2026-10-12T17:00:00+00:00",
                room_id="room-a",
                duration_min=60,
            ),
            session("new"),
        )
    )

    placement = plan.placed[0]
    assert placement.session_id == "new"
    # 09:00 in Main Hall is taken, so the next opening is 09:00 in the other room.
    assert (placement.room_id, placement.starts_at) == ("room-b", NINE_AM)


def test_a_shared_speaker_is_never_put_in_two_rooms_at_once():
    """The conflict the DB cannot see, and the reason the shared engine is used.

    Postgres' EXCLUDE constraint only knows about rooms. A planner that checked
    rooms alone would put Ada in Workshop Room at exactly the moment she is on
    the Main Hall stage; the rule engine is what stops it.
    """
    plan = plan_auto_placements(
        board(
            session(
                "keynote",
                starts_at=NINE_AM,
                ends_at="2026-10-12T17:00:00+00:00",
                room_id="room-a",
                duration_min=60,
                speakers=["ada"],
            ),
            session("workshop", duration_min=30, speakers=["ada"]),
        )
    )

    placement = plan.placed[0]
    assert placement.session_id == "workshop"
    # 09:00–10:00 is out in BOTH rooms (Ada is busy), so the first legal opening
    # is 10:00 back in the first room.
    assert (placement.room_id, placement.starts_at) == ("room-a", "2026-10-12T17:00:00+00:00")
    assert plan.skipped == ()


def test_the_plan_it_produces_has_no_conflicts_at_all():
    """The invariant, checked with the engine the conflicts endpoint uses."""
    from services.scheduling import (
        ScheduledSession,
        detect_conflicts,
        minutes_from_timestamp,
    )

    tray = [session(f"s{i}", duration_min=45, speakers=["ada"] if i % 3 == 0 else []) for i in range(9)]
    plan = plan_auto_placements(board(*tray))

    assert len(plan.placed) == 9
    by_id = {s["id"]: s for s in tray}
    swept = detect_conflicts(
        [
            ScheduledSession(
                id=p.session_id,
                room_id=p.room_id,
                start_min=minutes_from_timestamp(p.starts_at),
                duration_min=45,
                speaker_ids=tuple(
                    s["contact_id"] for s in by_id[p.session_id]["speakers"]
                ),
            )
            for p in plan.placed
        ]
    )
    assert swept == []


def test_accepted_sessions_are_placed_before_pending_ones():
    plan = plan_auto_placements(
        board(
            session("late", status="pending", title="AAA pending"),
            session("queued", status="accept_queue", title="BBB queued"),
            session("first", status="accepted", title="ZZZ accepted"),
        )
    )

    assert [p.session_id for p in plan.placed] == ["first", "queued", "late"]
    # …and the accepted one got the first opening despite sorting last by title.
    assert plan.placed[0].starts_at == NINE_AM
    assert plan.placed[0].room_id == "room-a"


def test_repeating_the_plan_on_the_same_board_gives_the_same_answer():
    tray = [session(f"s{i}", duration_min=30) for i in range(6)]
    first = plan_auto_placements(board(*tray))
    # Same board, sessions handed over in a different order.
    second = plan_auto_placements(board(*reversed(tray)))

    assert [p.as_dict() for p in first.placed] == [p.as_dict() for p in second.placed]


def test_a_session_that_cannot_fit_is_skipped_with_a_reason_not_forced():
    """One room, one hour of day, three hour-long talks: two must wait."""
    small_day = {"day_start": "09:00:00", "day_end": "10:00:00"}
    plan = plan_auto_placements(
        board(
            session("a", duration_min=60),
            session("b", duration_min=60),
            session("c", duration_min=60),
            event=small_day,
            rooms=[ROOMS[0]],
        )
    )

    assert [p.session_id for p in plan.placed] == ["a"]
    assert [(s.session_id, s.reason) for s in plan.skipped] == [
        ("b", NO_OPENING),
        ("c", NO_OPENING),
    ]


def test_a_session_longer_than_the_day_says_so():
    plan = plan_auto_placements(board(session("marathon", duration_min=600)))

    assert plan.placed == ()
    assert plan.skipped[0].session_id == "marathon"
    assert "longer than the 09:00–17:00 day" in plan.skipped[0].reason


def test_no_rooms_is_a_reason_not_a_crash():
    plan = plan_auto_placements(board(session("a"), rooms=[]))
    assert [s.reason for s in plan.skipped] == [NO_ROOMS]


def test_placements_land_on_a_grid_slot_in_the_event_zone():
    """Every start is a whole slot past the day's start, event-local."""
    from services.scheduling import parse_timestamp

    zone = resolve_zone(EVENT["timezone"])
    plan = plan_auto_placements(board(*[session(f"s{i}", duration_min=20) for i in range(5)]))

    for placement in plan.placed:
        local = parse_timestamp(placement.starts_at).astimezone(zone)
        minutes = local.hour * 60 + local.minute
        assert minutes >= 540
        assert (minutes - 540) % 15 == 0


def test_a_multi_day_event_fills_day_one_before_day_two():
    two_days = {"starts_at": f"{DAY}T16:00:00+00:00", "ends_at": "2026-10-14T01:00:00+00:00"}
    assert event_days(board(event=two_days), resolve_zone("America/Los_Angeles")) == [
        "2026-10-12",
        "2026-10-13",
    ]

    plan = plan_auto_placements(
        board(
            session("a", duration_min=60),
            session("b", duration_min=60),
            session("c", duration_min=60),
            event={**two_days, "day_start": "09:00:00", "day_end": "10:00:00"},
            rooms=[ROOMS[0]],
        )
    )

    assert [(p.session_id, p.starts_at[:10]) for p in plan.placed][:2] == [
        ("a", "2026-10-12"),
        ("b", "2026-10-13"),
    ]
    # Only two conference days exist, so the third talk has nowhere left.
    assert [s.session_id for s in plan.skipped] == ["c"]


def test_event_days_is_the_configured_span_only_never_a_stale_placement():
    """A conference day is a fact about the EVENT.

    `event_days` used to union in whichever days sessions happened to sit on, so
    one placement stranded outside the span (a date change moved the event out
    from under it) became a day the auto-placer would happily pack MORE talks
    onto — quietly growing a conference that does not exist. Mirrors `agendaDays`
    in web/src/lib/scheduleApi.ts, which the builder's tabs come from.
    """
    zone = resolve_zone("America/Los_Angeles")
    one_day = {"starts_at": f"{DAY}T16:00:00+00:00"}
    stranded = session("stale", room_id="room-a", starts_at="2026-11-20T17:00:00+00:00")

    assert event_days(board(stranded, event=one_day), zone) == [DAY]

    # And nothing is auto-placed onto that stray day either.
    plan = plan_auto_placements(board(stranded, session("a"), event=one_day))
    assert [p.starts_at[:10] for p in plan.placed] == [DAY]


def test_event_days_clamps_nothing_when_the_event_has_no_span():
    """No window, no clamp — the same rule the public schedule applies.

    Declaring every placement "outside the event dates" for an event that has no
    dates would be a lie about the data, so the fallback is the union of days
    something is already placed on.
    """
    zone = resolve_zone("America/Los_Angeles")
    assert event_days(
        board(
            session("a", room_id="room-a", starts_at=f"{DAY}T16:00:00+00:00"),
            session("b", room_id="room-a", starts_at="2026-11-20T17:00:00+00:00"),
            event={"starts_at": None},
        ),
        zone,
    ) == [DAY, "2026-11-20"]


def test_an_unknown_timezone_falls_back_to_utc_instead_of_failing():
    plan = plan_auto_placements(board(session("a"), event={"timezone": "Mars/Olympus"}))
    assert plan.placed[0].starts_at == f"{DAY}T09:00:00+00:00"


# ── the route ──────────────────────────────────────────────────────────────


def test_auto_place_requires_auth(agenda_client):
    assert agenda_client.post(AUTO_PLACE).status_code == 401


def test_auto_place_on_a_foreign_event_404s(agenda_client, auth_headers, agenda_db):
    response = agenda_client.post(
        f"/api/events/{OTHER_EVENT_ID}/schedule/auto-place", headers=auth_headers
    )
    assert response.status_code == 404


def test_auto_place_persists_the_placements(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1", title="Alpha")
    seed_session(agenda_db, "s2", title="Beta")

    body = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert [p["id"] for p in body["placed"]] == ["s1", "s2"]
    assert body["skipped"] == []
    rows = {row["id"]: row for row in agenda_db.rows("sessions")}
    # The tray is empty afterwards, on the rows themselves — not just in the
    # response — and both cards sit at 09:00 event-local in different rooms.
    assert rows["s1"]["starts_at"] == NINE_AM and rows["s1"]["room_id"] == "room-a"
    assert rows["s2"]["starts_at"] == NINE_AM and rows["s2"]["room_id"] == "room-b"
    assert rows["s1"]["ends_at"] == "2026-10-12T16:30:00+00:00"


def test_auto_place_leaves_already_scheduled_sessions_where_they_are(
    agenda_client, auth_headers, agenda_db
):
    seed_session(agenda_db, "held", starts_at=ts("09:00"), ends_at=ts("10:00"), room_id="room-a")
    seed_session(agenda_db, "tray")

    body = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert [p["id"] for p in body["placed"]] == ["tray"]
    held = next(row for row in agenda_db.rows("sessions") if row["id"] == "held")
    assert (held["starts_at"], held["room_id"]) == (ts("09:00"), "room-a")


def test_auto_place_never_creates_a_conflict_on_a_conflict_prone_board(
    agenda_client, auth_headers, agenda_db
):
    """Two sessions share a speaker; both get placed, and nothing collides.

    The board is then re-swept by the conflicts endpoint — the authority the
    grid reconciles against — so this asserts the *system's* answer, not the
    planner's own opinion of its work.
    """
    seed_session(agenda_db, "talk-a", title="Ada A")
    seed_session(agenda_db, "talk-b", title="Ada B")
    seed_speaker(agenda_db, "talk-a", "c-ada", first_name="Ada", last_name="Lovelace")
    seed_speaker(agenda_db, "talk-b", "c-ada", first_name="Ada", last_name="Lovelace")

    body = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()
    assert len(body["placed"]) == 2

    conflicts = agenda_client.get(
        f"/api/events/{TEST_EVENT_ID}/agenda/conflicts", headers=auth_headers
    ).json()["conflicts"]
    assert conflicts == []

    # Ada's two talks are back to back, not side by side: same room is fine, the
    # same minute is not.
    starts = sorted(p["starts_at"] for p in body["placed"])
    assert starts == [NINE_AM, "2026-10-12T16:30:00+00:00"]


def test_auto_place_is_deterministic_across_calls(agenda_client, auth_headers, agenda_db):
    for i in range(4):
        seed_session(agenda_db, f"s{i}", title=f"Talk {i}")

    first = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()
    # Send everything back to the tray and run it again: same schedule.
    for row in agenda_db.rows("sessions"):
        row.update({"starts_at": None, "ends_at": None, "room_id": None})
    second = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert first["placed"] == second["placed"]


def test_a_second_press_with_nothing_left_is_a_no_op(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1")

    assert len(agenda_client.post(AUTO_PLACE, headers=auth_headers).json()["placed"]) == 1
    again = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert again == {"placed": [], "skipped": []}


def test_auto_place_skips_what_cannot_fit_with_a_reason(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "huge", title="All-day intensive", format_id="format-1")
    # A 90-minute format default is fine; make the day too small for it instead.
    event_row = next(row for row in agenda_db.rows("events") if row["id"] == TEST_EVENT_ID)
    event_row.update({"day_start": "09:00:00", "day_end": "10:00:00"})

    body = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert body["placed"] == []
    assert body["skipped"][0]["id"] == "huge"
    assert body["skipped"][0]["title"] == "All-day intensive"
    assert "longer than" in body["skipped"][0]["reason"]
    # Nothing was written — a skip is not a half-placement.
    assert agenda_db.rows("sessions")[0]["starts_at"] is None


def test_auto_place_only_touches_this_orgs_sessions(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "mine")
    seed_session(agenda_db, "theirs", org_id=OTHER_ORG_ID, event_id=OTHER_EVENT_ID)

    body = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert [p["id"] for p in body["placed"]] == ["mine"]
    theirs = next(row for row in agenda_db.rows("sessions") if row["id"] == "theirs")
    assert theirs["starts_at"] is None and theirs["room_id"] is None
    # Every write carried the org predicate.
    updates = [entry for entry in agenda_db.log if entry["op"] == "update"]
    assert updates and all(
        ("eq", "org_id", TEST_ORG_ID) in entry["filters"] for entry in updates
    )


def test_a_room_double_book_race_becomes_a_skip_not_a_500(
    agenda_client, auth_headers, agenda_db
):
    """Postgres refusing a row mid-run costs that one session, not the plan."""
    seed_session(agenda_db, "s1", title="Alpha")
    seed_session(agenda_db, "s2", title="Beta")
    agenda_db.reject_room_id = "room-a"  # the first room the planner reaches for

    body = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert [p["id"] for p in body["placed"]] == ["s2"]
    assert body["skipped"] == [
        {"id": "s1", "title": "Alpha", "reason": "Room double-booked at that time."}
    ]


def test_pending_sessions_are_placed_after_accepted_ones(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "pending-one", status="pending", title="AAA")
    seed_session(agenda_db, "accepted-one", status="accepted", title="ZZZ")

    body = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert [p["id"] for p in body["placed"]] == ["accepted-one", "pending-one"]
    assert body["placed"][0]["room_id"] == "room-a"


@pytest.mark.parametrize("status", ["draft", "declined", "withdrawn"])
def test_unschedulable_statuses_are_never_placed(agenda_client, auth_headers, agenda_db, status):
    seed_session(agenda_db, "nope", status=status)

    body = agenda_client.post(AUTO_PLACE, headers=auth_headers).json()

    assert body == {"placed": [], "skipped": []}
    assert agenda_db.rows("sessions")[0]["starts_at"] is None
