"""The agenda: conflict arithmetic, assembly, and the double-book 409.

Two halves, deliberately kept apart.

`detect_conflicts` is pure, and it is a *second* implementation of a rule the
browser also implements (web/src/lib/schedule.ts). So it is driven from
fixtures/schedule_conflicts.json, the same file web/tests/scheduleParity.test.ts
reads — a divergence between the two fails on both sides rather than shipping a
grid that disagrees with its own server.

The routes are exercised against the in-memory PostgREST stand-in, plus the one
piece of real Postgres behaviour that cannot be faked away: the EXCLUDE
constraint from migration 001 answering a room double-book with 23P01. That
path is the difference between an organizer seeing "Room double-booked" and
seeing a 500.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from postgrest.exceptions import APIError

from services.scheduling import (
    Conflict,
    ScheduledSession,
    conflicts_for_session,
    detect_conflicts,
    duration_minutes,
    format_minutes,
    minutes_from_timestamp,
    overlap_start,
    parse_timestamp,
    scheduled_session,
)
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID
from tests.fakes import FakeSupabase

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "schedule_conflicts.json").read_text()
)

DAY = "2026-10-12"


def ts(hhmm: str, day: str = DAY) -> str:
    """"09:30" -> the ISO text the DB hands back for that placement."""
    return f"{day}T{hhmm}:00+00:00"


# ── the shared fixture suite ───────────────────────────────────────────────


def _sessions(case: dict) -> list[ScheduledSession]:
    return [
        ScheduledSession(
            id=row["id"],
            room_id=row["room_id"],
            start_min=row["start_min"],
            duration_min=row["duration_min"],
            speaker_ids=tuple(row.get("speaker_ids") or ()),
        )
        for row in case["sessions"]
    ]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_detect_conflicts_matches_the_shared_fixture(case):
    labels = case["labels"] if "labels" in case else FIXTURE["labels"]
    found = [c.as_dict() for c in detect_conflicts(_sessions(case), labels)]
    assert found == case["expected"]


# ── the arithmetic underneath ──────────────────────────────────────────────


def test_overlap_is_half_open():
    # [9:00,9:30) vs [9:30,10:00) — touching, not overlapping.
    assert overlap_start(540, 570, 570, 600) is None
    assert overlap_start(540, 600, 570, 630) == 570


@pytest.mark.parametrize(
    "minutes,expected",
    [(0, "00:00"), (540, "09:00"), (570, "09:30"), (1439, "23:59"), (1980, "09:00")],
)
def test_format_minutes_reads_as_a_wall_clock(minutes, expected):
    assert format_minutes(minutes) == expected


def test_conflicts_for_session_is_the_drag_delta():
    """One candidate against everything else — never a full sweep."""
    placed = [
        ScheduledSession("a", "room-a", 540, 60, ("ada",)),
        ScheduledSession("b", "room-b", 540, 60, ("grace",)),
    ]
    candidate = ScheduledSession("c", "room-a", 570, 30, ("grace",))

    found = conflicts_for_session(candidate, placed)

    assert [c.type for c in found] == ["room_overlap", "speaker_overlap"]
    assert all(isinstance(c, Conflict) for c in found)


def test_a_session_never_conflicts_with_itself():
    session = ScheduledSession("a", "room-a", 540, 60, ("ada",))
    assert conflicts_for_session(session, [session]) == []


def test_naive_timestamps_are_read_as_utc():
    """The grid writes naive-as-UTC, so reading it back must agree."""
    assert parse_timestamp("2026-10-12T09:30:00") == datetime(
        2026, 10, 12, 9, 30, tzinfo=timezone.utc
    )
    assert minutes_from_timestamp("2026-10-12T09:30:00") == minutes_from_timestamp(
        "2026-10-12T09:30:00+00:00"
    )
    assert format_minutes(minutes_from_timestamp(ts("09:30"))) == "09:30"


def test_an_offset_timestamp_normalises_before_comparing():
    assert minutes_from_timestamp("2026-10-12T11:30:00+02:00") == minutes_from_timestamp(
        "2026-10-12T09:30:00+00:00"
    )


@pytest.mark.parametrize("value", [None, "", "not a timestamp"])
def test_unusable_timestamps_are_none_not_a_crash(value):
    assert minutes_from_timestamp(value) is None


def test_duration_needs_both_ends_and_a_positive_span():
    assert duration_minutes(ts("09:00"), ts("09:45")) == 45
    assert duration_minutes(ts("09:00"), None) is None
    assert duration_minutes(ts("09:45"), ts("09:00")) is None


def test_scheduled_session_ignores_a_row_without_a_room_or_a_start():
    assert scheduled_session({"id": "a", "room_id": None, "starts_at": ts("09:00")}, duration_min=30) is None
    assert scheduled_session({"id": "a", "room_id": "r", "starts_at": None}, duration_min=30) is None
    placed = scheduled_session(
        {"id": "a", "room_id": "r", "starts_at": ts("09:00")}, duration_min=30
    )
    assert placed is not None and placed.duration_min == 30


# ── routes ─────────────────────────────────────────────────────────────────


class ExclusionSupabase(FakeSupabase):
    """The fake, plus the EXCLUDE constraint from migration 001.

    Postgres — not the application — is what actually stops two accepted
    sessions sharing a room and a minute. Set `reject_room_id` to make the next
    write into that room answer the way the real constraint does.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reject_room_id: str | None = None
        self.raise_instead: APIError | None = None

    def table(self, name: str):
        query = super().table(name)
        if name != "sessions":
            return query
        inner = query.execute

        def execute():
            payload = query.payload if isinstance(query.payload, dict) else {}
            booked = self.reject_room_id
            # `is not None` matters: clearing a room writes room_id=None, and a
            # fake with nothing to reject must not read that as a collision.
            if query.op == "update" and booked is not None and payload.get("room_id") == booked:
                raise self.raise_instead or APIError(
                    {
                        "code": "23P01",
                        "message": (
                            "conflicting key value violates exclusion constraint "
                            '"sessions_room_id_tstzrange_excl"'
                        ),
                    }
                )
            return inner()

        query.execute = execute
        return query


@pytest.fixture
def agenda_client():
    """A TestClient over just this router.

    main.py does not include it yet (that line is the handoff), and a route
    test should not depend on which app happens to have been wired.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from routes.schedule_routes import router

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def agenda_db(monkeypatch):
    """One org, one event, two rooms, one track — the minimum grid."""
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
            "timezone": "America/Los_Angeles",
            "starts_at": f"{DAY}T16:00:00+00:00",
            "day_start": "09:00:00",
            "day_end": "17:00:00",
            "slot_minutes": 15,
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
        "tracks",
        {
            "id": "track-1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Platform",
            "color": "#4F46E5",
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


def seed_session(db, session_id: str, **overrides) -> dict:
    record = {
        "id": session_id,
        "org_id": TEST_ORG_ID,
        "event_id": TEST_EVENT_ID,
        "friendly_id": f"SESS-{session_id}",
        "title": f"Session {session_id}",
        "status": "accepted",
        "starts_at": None,
        "ends_at": None,
        "room_id": None,
        "track_id": None,
        "format_id": None,
        **overrides,
    }
    db.seed("sessions", record)
    return record


def seed_speaker(db, session_id: str, contact_id: str, *, role="speaker", **contact):
    db.seed(
        "session_participants",
        {
            "id": f"{session_id}-{contact_id}-{role}",
            "org_id": TEST_ORG_ID,
            "session_id": session_id,
            "contact_id": contact_id,
            "role": role,
            "is_primary": contact.pop("is_primary", False),
        },
    )
    if not any(row["id"] == contact_id for row in db.rows("contacts")):
        db.seed(
            "contacts",
            {
                "id": contact_id,
                "org_id": TEST_ORG_ID,
                "event_id": TEST_EVENT_ID,
                "email": f"{contact_id}@example.com",
                "first_name": contact.get("first_name", "Ada"),
                "last_name": contact.get("last_name", "Lovelace"),
            },
        )


def agenda(client, headers, event_id: str = TEST_EVENT_ID):
    return client.get(f"/api/events/{event_id}/agenda", headers=headers)


# -- auth + org scoping ----------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", f"/api/events/{TEST_EVENT_ID}/agenda"),
        ("GET", f"/api/events/{TEST_EVENT_ID}/agenda/conflicts"),
        ("PATCH", "/api/sessions/s1/schedule"),
    ],
)
def test_every_route_requires_auth(agenda_client, method, path):
    assert agenda_client.request(method, path, json={}).status_code == 401


def test_agenda_on_a_foreign_event_404s(agenda_client, auth_headers, agenda_db):
    assert agenda(agenda_client, auth_headers, OTHER_EVENT_ID).status_code == 404


def test_conflicts_on_a_foreign_event_404s(agenda_client, auth_headers, agenda_db):
    response = agenda_client.get(
        f"/api/events/{OTHER_EVENT_ID}/agenda/conflicts", headers=auth_headers
    )
    assert response.status_code == 404


def test_the_agenda_never_shows_another_orgs_rows(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "mine")
    seed_session(agenda_db, "theirs", org_id=OTHER_ORG_ID, event_id=OTHER_EVENT_ID)

    body = agenda(agenda_client, auth_headers).json()

    assert [s["id"] for s in body["sessions"]] == ["mine"]
    assert [r["id"] for r in body["rooms"]] == ["room-a", "room-b"]


# -- shape -----------------------------------------------------------------


def test_agenda_returns_the_grid_geometry(agenda_client, auth_headers, agenda_db):
    body = agenda(agenda_client, auth_headers).json()

    assert body["event"]["day_start"] == "09:00:00"
    assert body["event"]["day_end"] == "17:00:00"
    assert body["event"]["slot_minutes"] == 15
    assert body["event"]["timezone"] == "America/Los_Angeles"


def test_rooms_come_back_ordered_with_their_capacity(agenda_client, auth_headers, agenda_db):
    rooms = agenda(agenda_client, auth_headers).json()["rooms"]

    assert [room["name"] for room in rooms] == ["Main Hall", "Workshop Room"]
    assert rooms[0]["capacity"] == 400


def test_tracks_come_back_with_their_colour(agenda_client, auth_headers, agenda_db):
    tracks = agenda(agenda_client, auth_headers).json()["tracks"]
    assert tracks == [{"id": "track-1", "name": "Platform", "color": "#4F46E5"}]


def test_only_schedulable_statuses_appear(agenda_client, auth_headers, agenda_db):
    for status in ("accepted", "accept_queue", "pending", "draft", "declined", "withdrawn"):
        seed_session(agenda_db, status, status=status)

    ids = {s["id"] for s in agenda(agenda_client, auth_headers).json()["sessions"]}

    assert ids == {"accepted", "accept_queue", "pending"}


def test_a_placed_session_carries_its_derived_duration(agenda_client, auth_headers, agenda_db):
    seed_session(
        agenda_db,
        "placed",
        starts_at=ts("09:00"),
        ends_at=ts("09:45"),
        room_id="room-a",
        track_id="track-1",
    )

    session = agenda(agenda_client, auth_headers).json()["sessions"][0]

    assert session["duration_min"] == 45
    assert session["room_id"] == "room-a"
    assert session["track_id"] == "track-1"
    assert session["friendly_id"] == "SESS-placed"


def test_an_unscheduled_session_falls_back_to_its_format(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "tray", format_id="format-1")

    session = agenda(agenda_client, auth_headers).json()["sessions"][0]

    assert session["starts_at"] is None
    assert session["duration_min"] == 90


def test_a_session_with_neither_end_nor_format_gets_the_default(
    agenda_client, auth_headers, agenda_db
):
    seed_session(agenda_db, "bare")
    assert agenda(agenda_client, auth_headers).json()["sessions"][0]["duration_min"] == 30


def test_scheduled_sessions_sort_before_the_tray(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "tray", title="Zebra")
    seed_session(agenda_db, "late", starts_at=ts("11:00"), ends_at=ts("11:30"), room_id="room-a")
    seed_session(agenda_db, "early", starts_at=ts("09:00"), ends_at=ts("09:30"), room_id="room-a")

    ids = [s["id"] for s in agenda(agenda_client, auth_headers).json()["sessions"]]

    assert ids == ["early", "late", "tray"]


# -- speakers --------------------------------------------------------------


def test_speakers_resolve_through_session_participants(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1")
    seed_speaker(agenda_db, "s1", "c-ada", first_name="Ada", last_name="Lovelace")

    speakers = agenda(agenda_client, auth_headers).json()["sessions"][0]["speakers"]

    assert speakers == [{"contact_id": "c-ada", "first_name": "Ada", "last_name": "Lovelace"}]


def test_the_submitter_stands_in_when_no_speaker_is_assigned(
    agenda_client, auth_headers, agenda_db
):
    seed_session(agenda_db, "s1")
    seed_speaker(agenda_db, "s1", "c-grace", role="submitter", first_name="Grace", last_name="Hopper")

    speakers = agenda(agenda_client, auth_headers).json()["sessions"][0]["speakers"]

    assert [s["first_name"] for s in speakers] == ["Grace"]


def test_an_assigned_speaker_wins_over_the_submitter(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1")
    seed_speaker(agenda_db, "s1", "c-ada", first_name="Ada", last_name="Lovelace")
    seed_speaker(agenda_db, "s1", "c-grace", role="submitter", first_name="Grace", last_name="Hopper")

    speakers = agenda(agenda_client, auth_headers).json()["sessions"][0]["speakers"]

    assert [s["contact_id"] for s in speakers] == ["c-ada"]


def test_speakers_do_not_leak_across_sessions(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1", title="A")
    seed_session(agenda_db, "s2", title="B")
    seed_speaker(agenda_db, "s1", "c-ada", first_name="Ada", last_name="Lovelace")

    sessions = {s["id"]: s for s in agenda(agenda_client, auth_headers).json()["sessions"]}

    assert len(sessions["s1"]["speakers"]) == 1
    assert sessions["s2"]["speakers"] == []


# -- conflicts endpoint ----------------------------------------------------


def test_conflicts_reports_a_room_double_book(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "a", starts_at=ts("09:00"), ends_at=ts("10:00"), room_id="room-a")
    seed_session(agenda_db, "b", starts_at=ts("09:30"), ends_at=ts("10:00"), room_id="room-a")

    body = agenda_client.get(
        f"/api/events/{TEST_EVENT_ID}/agenda/conflicts", headers=auth_headers
    ).json()

    assert body["conflicts"] == [
        {
            "type": "room_overlap",
            "session_ids": ["a", "b"],
            "detail": "Main Hall is double-booked at 09:30",
        }
    ]


def test_conflicts_reports_a_speaker_in_two_rooms(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "a", starts_at=ts("09:00"), ends_at=ts("10:00"), room_id="room-a")
    seed_session(agenda_db, "b", starts_at=ts("09:30"), ends_at=ts("10:00"), room_id="room-b")
    seed_speaker(agenda_db, "a", "c-ada", first_name="Ada", last_name="Lovelace")
    seed_speaker(agenda_db, "b", "c-ada", first_name="Ada", last_name="Lovelace")

    body = agenda_client.get(
        f"/api/events/{TEST_EVENT_ID}/agenda/conflicts", headers=auth_headers
    ).json()

    assert body["conflicts"] == [
        {
            "type": "speaker_overlap",
            "session_ids": ["a", "b"],
            "detail": "Ada Lovelace is in two rooms at 09:30",
        }
    ]


def test_conflicts_reports_three_room_pairs_and_one_speaker_pair(
    agenda_client, auth_headers, agenda_db
):
    agenda_db.seed(
        "rooms",
        {
            "id": "room-c",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Workshop B",
            "capacity": 60,
            "order": 2,
        },
    )
    placements = [
        ("main-early", "room-a", "09:00", "10:00", "accepted"),
        ("main-late", "room-a", "09:30", "10:00", "accepted"),
        ("workshop-a-early", "room-b", "10:00", "11:00", "pending"),
        ("workshop-a-late", "room-b", "10:15", "10:45", "pending"),
        ("workshop-b-early", "room-c", "11:00", "12:00", "accept_queue"),
        ("workshop-b-late", "room-c", "11:15", "11:45", "accept_queue"),
        ("speaker-a", "room-a", "12:00", "12:30", "accepted"),
        ("speaker-b", "room-b", "12:00", "12:30", "pending"),
    ]
    for session_id, room_id, starts, ends, status in placements:
        seed_session(
            agenda_db,
            session_id,
            room_id=room_id,
            starts_at=ts(starts),
            ends_at=ts(ends),
            status=status,
        )
    seed_speaker(agenda_db, "speaker-a", "c-ada", first_name="Ada", last_name="Lovelace")
    seed_speaker(agenda_db, "speaker-b", "c-ada", first_name="Ada", last_name="Lovelace")

    body = agenda_client.get(
        f"/api/events/{TEST_EVENT_ID}/agenda/conflicts", headers=auth_headers
    ).json()

    assert body["conflicts"] == [
        {
            "type": "room_overlap",
            "session_ids": ["main-early", "main-late"],
            "detail": "Main Hall is double-booked at 09:30",
        },
        {
            "type": "room_overlap",
            "session_ids": ["workshop-a-early", "workshop-a-late"],
            "detail": "Workshop Room is double-booked at 10:15",
        },
        {
            "type": "room_overlap",
            "session_ids": ["workshop-b-early", "workshop-b-late"],
            "detail": "Workshop B is double-booked at 11:15",
        },
        {
            "type": "speaker_overlap",
            "session_ids": ["speaker-a", "speaker-b"],
            "detail": "Ada Lovelace is in two rooms at 12:00",
        },
    ]


def test_back_to_back_sessions_are_not_a_conflict(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "a", starts_at=ts("09:00"), ends_at=ts("09:30"), room_id="room-a")
    seed_session(agenda_db, "b", starts_at=ts("09:30"), ends_at=ts("10:00"), room_id="room-a")

    body = agenda_client.get(
        f"/api/events/{TEST_EVENT_ID}/agenda/conflicts", headers=auth_headers
    ).json()

    assert body["conflicts"] == []


def test_unscheduled_sessions_cannot_conflict(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "a", starts_at=ts("09:00"), ends_at=ts("10:00"), room_id="room-a")
    seed_session(agenda_db, "b")

    body = agenda_client.get(
        f"/api/events/{TEST_EVENT_ID}/agenda/conflicts", headers=auth_headers
    ).json()

    assert body["conflicts"] == []


# -- PATCH /sessions/{id}/schedule -----------------------------------------


def test_patch_places_a_session(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1")

    response = agenda_client.patch(
        "/api/sessions/s1/schedule",
        headers=auth_headers,
        json={"starts_at": f"{DAY}T09:30:00", "ends_at": f"{DAY}T10:15:00", "room_id": "room-a"},
    )

    assert response.status_code == 200
    row = agenda_db.rows("sessions")[0]
    assert row["room_id"] == "room-a"
    # Naive in, UTC out — the grid reads back the clock it dropped the card at.
    assert row["starts_at"] == "2026-10-12T09:30:00+00:00"
    assert row["ends_at"] == "2026-10-12T10:15:00+00:00"
    assert response.json()["session"]["room_id"] == "room-a"


def test_patch_unschedules_with_explicit_nulls(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1", starts_at=ts("09:00"), ends_at=ts("09:30"), room_id="room-a")

    response = agenda_client.patch(
        "/api/sessions/s1/schedule",
        headers=auth_headers,
        json={"starts_at": None, "ends_at": None, "room_id": None},
    )

    assert response.status_code == 200
    row = agenda_db.rows("sessions")[0]
    assert (row["starts_at"], row["ends_at"], row["room_id"]) == (None, None, None)


def test_patch_leaves_omitted_keys_alone(agenda_client, auth_headers, agenda_db):
    """Omitted is not null — moving a card between rooms must not clear its time."""
    seed_session(agenda_db, "s1", starts_at=ts("09:00"), ends_at=ts("09:30"), room_id="room-a")

    agenda_client.patch(
        "/api/sessions/s1/schedule", headers=auth_headers, json={"room_id": "room-b"}
    )

    row = agenda_db.rows("sessions")[0]
    assert row["room_id"] == "room-b"
    assert row["starts_at"] == ts("09:00")


def test_patch_never_touches_status(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1", status="pending")

    agenda_client.patch(
        "/api/sessions/s1/schedule",
        headers=auth_headers,
        json={"starts_at": f"{DAY}T09:00:00", "ends_at": f"{DAY}T09:30:00", "room_id": "room-a"},
    )

    assert agenda_db.rows("sessions")[0]["status"] == "pending"


def test_patch_on_another_orgs_session_404s(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1", org_id=OTHER_ORG_ID, event_id=OTHER_EVENT_ID)

    response = agenda_client.patch(
        "/api/sessions/s1/schedule", headers=auth_headers, json={"room_id": "room-a"}
    )

    assert response.status_code == 404
    assert agenda_db.rows("sessions")[0]["room_id"] is None


def test_patch_with_an_empty_body_400s(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1")
    response = agenda_client.patch("/api/sessions/s1/schedule", headers=auth_headers, json={})
    assert response.status_code == 400


def test_patch_rejects_an_end_before_its_start(agenda_client, auth_headers, agenda_db):
    seed_session(agenda_db, "s1")

    response = agenda_client.patch(
        "/api/sessions/s1/schedule",
        headers=auth_headers,
        json={"starts_at": f"{DAY}T10:00:00", "ends_at": f"{DAY}T09:00:00"},
    )

    assert response.status_code == 400
    assert "end after it starts" in response.json()["detail"]


def test_patch_checks_the_merged_range_not_just_the_half_it_was_given(
    agenda_client, auth_headers, agenda_db
):
    seed_session(agenda_db, "s1", starts_at=ts("10:00"), ends_at=ts("10:30"), room_id="room-a")

    response = agenda_client.patch(
        "/api/sessions/s1/schedule", headers=auth_headers, json={"ends_at": f"{DAY}T09:00:00"}
    )

    assert response.status_code == 400
    assert agenda_db.rows("sessions")[0]["ends_at"] == ts("10:30")


def test_a_room_double_book_is_a_409_not_a_500(agenda_client, auth_headers, agenda_db):
    """Postgres' EXCLUDE constraint, translated into something the grid can undo."""
    seed_session(agenda_db, "s1")
    agenda_db.reject_room_id = "room-a"

    response = agenda_client.patch(
        "/api/sessions/s1/schedule",
        headers=auth_headers,
        json={"starts_at": f"{DAY}T09:00:00", "ends_at": f"{DAY}T09:30:00", "room_id": "room-a"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Room double-booked at that time."


def test_an_unrelated_db_error_is_not_disguised_as_a_conflict(
    agenda_client, auth_headers, agenda_db
):
    seed_session(agenda_db, "s1")
    agenda_db.reject_room_id = "room-a"
    agenda_db.raise_instead = APIError({"code": "42703", "message": "column does not exist"})

    with pytest.raises(APIError):
        agenda_client.patch(
            "/api/sessions/s1/schedule",
            headers=auth_headers,
            json={"room_id": "room-a"},
        )


# -- POST /events/{id}/schedule/publish ------------------------------------


def test_publish_stamps_the_event_and_returns_the_public_url(
    agenda_client, auth_headers, agenda_db
):
    response = agenda_client.post(
        f"/api/events/{TEST_EVENT_ID}/schedule/publish", headers=auth_headers
    )

    assert response.status_code == 200
    body = response.json()
    # The event now carries a publish timestamp...
    stamped = agenda_db.rows("events")
    event_row = next(row for row in stamped if row["id"] == TEST_EVENT_ID)
    assert event_row["program_published_at"] is not None
    assert body["event"]["program_published_at"] == event_row["program_published_at"]
    # ...and the response hands back the shareable public schedule link.
    assert body["public_url"] == "/e/ai-builders-summit/schedule"
    assert body["event"]["slug"] == "ai-builders-summit"


def test_publish_requires_auth(agenda_client):
    assert (
        agenda_client.post(f"/api/events/{TEST_EVENT_ID}/schedule/publish").status_code
        == 401
    )


def test_publish_on_a_foreign_event_404s_and_stamps_nothing(
    agenda_client, auth_headers, agenda_db
):
    response = agenda_client.post(
        f"/api/events/{OTHER_EVENT_ID}/schedule/publish", headers=auth_headers
    )

    assert response.status_code == 404
    # The other org's event is untouched — no cross-org publish.
    other = next(row for row in agenda_db.rows("events") if row["id"] == OTHER_EVENT_ID)
    assert other.get("program_published_at") is None


def test_publish_does_not_change_what_the_public_schedule_returns(
    agenda_client, auth_headers, agenda_db
):
    """The safety invariant: publish is an affirmation, not a visibility gate.

    The public schedule serves accepted+scheduled sessions by exactly the same
    criteria before and after publishing — the `program_published_at` stamp is
    never consulted when deciding what the public sees.
    """
    seed_session(
        agenda_db, "shown", status="accepted", starts_at=ts("09:00"), ends_at=ts("09:45"), room_id="room-a"
    )

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from routes import program_routes
    from security.rate_limiting import limiter

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(program_routes, "supabase", agenda_db)
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(program_routes.router)
    program_client = TestClient(app)

    def public_ids() -> list[str]:
        body = program_client.get("/public/program/ai-builders-summit/schedule").json()
        return [s["id"] for day in body["days"] for s in day["sessions"]]

    before = public_ids()
    assert before == ["shown"]

    publish = agenda_client.post(
        f"/api/events/{TEST_EVENT_ID}/schedule/publish", headers=auth_headers
    )
    assert publish.status_code == 200

    # Same rows, same criteria — publishing changed nothing the public can see.
    assert public_ids() == before
    monkeypatch.undo()
