"""The public program surface: published schedule + speaker gallery + embed.js.

Mounted on its own app (like test_demo.py) so the suite doesn't depend on
main.py wiring the router in. The interesting behaviour is the *shape*: only
accepted+scheduled sessions reach the schedule, speakers resolve by role with a
submitter fallback, nothing PII-shaped leaks, and grouping/ordering follows the
requested timezone.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.program_routes import router as program_router
from security.rate_limiting import limiter
from tests.conftest import TEST_EVENT_ID, TEST_ORG_ID

SLUG = "ai-builders-summit"

ROOM_A = "aaaaaaaa-0000-0000-0000-0000000000a1"
ROOM_B = "aaaaaaaa-0000-0000-0000-0000000000b2"
TRACK_ENG = "cccccccc-0000-0000-0000-0000000000e1"
TRACK_RES = "cccccccc-0000-0000-0000-0000000000r2"
FORMAT_KEYNOTE = "ffffffff-0000-0000-0000-0000000000f1"

# contacts — last names chosen so the alphabetical gallery order is unambiguous.
C_ALPHA = "dddddddd-0000-0000-0000-00000000a001"
C_BETA = "dddddddd-0000-0000-0000-00000000b002"
C_YOUNG = "dddddddd-0000-0000-0000-00000000y003"
C_ZETA = "dddddddd-0000-0000-0000-00000000z004"
C_NOPE = "dddddddd-0000-0000-0000-00000000n005"

S1 = "eeeeeeee-0000-0000-0000-0000000000s1"
S2 = "eeeeeeee-0000-0000-0000-0000000000s2"
S3 = "eeeeeeee-0000-0000-0000-0000000000s3"
S4 = "eeeeeeee-0000-0000-0000-0000000000s4"
S5 = "eeeeeeee-0000-0000-0000-0000000000s5"
S6 = "eeeeeeee-0000-0000-0000-0000000000s6"

ZETA_EMAIL = "zeta@example.com"
ZETA_PHONE = "+15551230000"


@pytest.fixture(scope="module")
def program_client() -> TestClient:
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(program_router)
    return TestClient(app)


def _contact(cid: str, first: str, last: str, **extra) -> dict:
    return {
        "id": cid,
        "org_id": TEST_ORG_ID,
        "event_id": TEST_EVENT_ID,
        "email": f"{first.lower()}@example.com",
        "phone": "+15550000000",
        "first_name": first,
        "last_name": last,
        "title": f"{first} Title",
        "company_name": f"{first} Corp",
        "photo_url": f"https://cdn.test/{first.lower()}.png",
        "about": f"{first} is a speaker.",
        "linkedin_url": f"https://linkedin.com/in/{first.lower()}",
        "twitter_url": f"https://twitter.com/{first.lower()}",
        **extra,
    }


def _session(sid: str, *, status: str, starts_at, ends_at, room, track, title, fmt=None) -> dict:
    return {
        "id": sid,
        "org_id": TEST_ORG_ID,
        "event_id": TEST_EVENT_ID,
        "friendly_id": f"SESS-{sid[-2:]}",
        "title": title,
        "description": f"<p>About {title}</p>",
        "status": status,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "room_id": room,
        "track_id": track,
        "format_id": fmt,
    }


def _participant(sid: str, cid: str, role: str, is_primary: bool = False) -> dict:
    return {
        "org_id": TEST_ORG_ID,
        "session_id": sid,
        "contact_id": cid,
        "role": role,
        "is_primary": is_primary,
    }


@pytest.fixture
def program_db(seeded_db):
    """The seeded event (slug ai-builders-summit) plus a small programme."""
    db = seeded_db
    db.seed("rooms", {"id": ROOM_A, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Room A"})
    db.seed("rooms", {"id": ROOM_B, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Room B"})
    db.seed(
        "tracks",
        {"id": TRACK_ENG, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Engineering", "color": "#123456"},
    )
    db.seed(
        "tracks",
        {"id": TRACK_RES, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Research", "color": "#654321"},
    )
    db.seed(
        "formats",
        {"id": FORMAT_KEYNOTE, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "name": "Keynote"},
    )

    db.seed("contacts", _contact(C_ALPHA, "Alice", "Alpha"))
    db.seed("contacts", _contact(C_BETA, "Bob", "Beta"))
    db.seed("contacts", _contact(C_YOUNG, "Yolanda", "Young"))
    db.seed("contacts", _contact(C_ZETA, "Zed", "Zeta", email=ZETA_EMAIL, phone=ZETA_PHONE))
    db.seed("contacts", _contact(C_NOPE, "Nina", "Nope"))

    # Day 1 (2026-10-12 UTC): S1 @16:00, then S3 & S2 both @17:00 (Room A before B).
    db.seed("sessions", _session(S1, status="accepted", starts_at="2026-10-12T16:00:00+00:00",
                                 ends_at="2026-10-12T16:45:00+00:00", room=ROOM_B, track=TRACK_ENG,
                                 title="Opening Keynote", fmt=FORMAT_KEYNOTE))
    db.seed("sessions", _session(S2, status="accepted", starts_at="2026-10-12T17:00:00+00:00",
                                 ends_at="2026-10-12T17:30:00+00:00", room=ROOM_B, track=TRACK_RES,
                                 title="RAG in Production"))
    db.seed("sessions", _session(S3, status="accepted", starts_at="2026-10-12T17:00:00+00:00",
                                 ends_at="2026-10-12T17:30:00+00:00", room=ROOM_A, track=TRACK_ENG,
                                 title="Vector Databases"))
    # Day 2.
    db.seed("sessions", _session(S6, status="accepted", starts_at="2026-10-13T16:00:00+00:00",
                                 ends_at="2026-10-13T16:30:00+00:00", room=ROOM_A, track=TRACK_ENG,
                                 title="Closing Notes"))
    # Accepted but unscheduled — in the gallery, never on the schedule.
    db.seed("sessions", _session(S4, status="accepted", starts_at=None, ends_at=None,
                                 room=None, track=TRACK_ENG, title="Unplaced Talk"))
    # Pending — excluded everywhere.
    db.seed("sessions", _session(S5, status="pending", starts_at="2026-10-12T18:00:00+00:00",
                                 ends_at="2026-10-12T18:30:00+00:00", room=ROOM_A, track=TRACK_ENG,
                                 title="Not Yet Accepted"))

    db.seed("session_participants", _participant(S1, C_ZETA, "speaker", True))
    db.seed("session_participants", _participant(S2, C_ALPHA, "speaker", True))
    # S3 has no speaker — only a submitter, who must be used as the fallback.
    db.seed("session_participants", _participant(S3, C_BETA, "submitter", True))
    db.seed("session_participants", _participant(S6, C_ALPHA, "speaker", True))
    db.seed("session_participants", _participant(S4, C_YOUNG, "speaker", True))
    db.seed("session_participants", _participant(S5, C_NOPE, "speaker", True))
    return db


# ── schedule ─────────────────────────────────────────────────────────────────


def test_schedule_groups_by_day_and_orders_by_time_then_room(program_client, program_db):
    res = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC")
    assert res.status_code == 200
    body = res.json()

    assert body["event"]["name"] == "AI Builders Summit"
    assert body["event"]["timezone"] == "UTC"

    days = body["days"]
    assert [d["date"] for d in days] == ["2026-10-12", "2026-10-13"]

    day1 = days[0]["sessions"]
    # 16:00 first, then the two 17:00 sessions ordered Room A before Room B.
    assert [s["title"] for s in day1] == ["Opening Keynote", "Vector Databases", "RAG in Production"]
    assert [s["room"] for s in day1] == ["Room B", "Room A", "Room B"]
    assert days[1]["sessions"][0]["title"] == "Closing Notes"


def test_schedule_excludes_pending_and_unscheduled(program_client, program_db):
    body = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    titles = [s["title"] for day in body["days"] for s in day["sessions"]]
    assert "Not Yet Accepted" not in titles  # pending
    assert "Unplaced Talk" not in titles  # accepted but starts_at null


def test_schedule_carries_track_and_resolved_speakers_with_submitter_fallback(program_client, program_db):
    body = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    by_title = {s["title"]: s for day in body["days"] for s in day["sessions"]}

    keynote = by_title["Opening Keynote"]
    assert keynote["track"] == {"name": "Engineering", "color": "#123456"}
    assert keynote["speakers"][0]["name"] == "Zed Zeta"
    assert keynote["speakers"][0]["company"] == "Zed Corp"
    assert keynote["speakers"][0]["photo_url"] == "https://cdn.test/zed.png"

    # S3 has no speaker participant — the submitter stands in.
    assert by_title["Vector Databases"]["speakers"][0]["name"] == "Bob Beta"


def test_schedule_carries_session_format(program_client, program_db):
    """Cards show a Format tag (EMB-01): the schedule resolves format_id to its
    name, and a session without a format reports null rather than 500ing."""
    body = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    by_title = {s["title"]: s for day in body["days"] for s in day["sessions"]}
    assert by_title["Opening Keynote"]["format"] == "Keynote"
    assert by_title["Vector Databases"]["format"] is None


def test_schedule_leaks_no_pii(program_client, program_db):
    raw = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").text
    assert ZETA_EMAIL not in raw
    assert ZETA_PHONE not in raw


def test_schedule_defaults_to_event_timezone_when_no_tz_given(program_client, program_db):
    """No ?tz — the public page must render in the EVENT's own zone (the one the
    organizer published against), never the visitor's browser clock."""
    body = program_client.get(f"/public/program/{SLUG}/schedule").json()
    assert body["event"]["timezone"] == "America/Los_Angeles"


def test_schedule_groups_days_in_event_timezone_not_utc(program_client, program_db):
    """With no ?tz the grid follows the EVENT's calendar. A 05:00Z session is the
    12th in UTC but 22:00 on the 11th in LA — event-tz grouping lands it on the
    11th, a bucket a UTC render never produces."""
    program_db.seed(
        "sessions",
        _session(
            "eeeeeeee-0000-0000-0000-0000000000s7",
            status="accepted",
            starts_at="2026-10-12T05:00:00+00:00",
            ends_at="2026-10-12T05:30:00+00:00",
            room=ROOM_A,
            track=TRACK_ENG,
            title="Late Night Hack",
        ),
    )
    body = program_client.get(f"/public/program/{SLUG}/schedule").json()
    assert body["event"]["timezone"] == "America/Los_Angeles"
    assert "2026-10-11" in [d["date"] for d in body["days"]]
    utc = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    assert "2026-10-11" not in [d["date"] for d in utc["days"]]


def test_schedule_sessions_carry_id_for_detail_links(program_client, program_db):
    """Each card needs a stable id to open its detail modal against."""
    body = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    first = body["days"][0]["sessions"][0]
    assert first["title"] == "Opening Keynote"
    assert first["id"] == S1


def test_schedule_timezone_shifts_day_boundaries(program_client, program_db):
    """A session at 16:00 UTC is the 12th in UTC but still the 12th in LA (08:00);
    grouping in a far-eastern zone rolls it onto the 13th."""
    utc = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    tokyo = program_client.get(f"/public/program/{SLUG}/schedule?tz=Asia/Tokyo").json()
    # 2026-10-13T16:00Z is 2026-10-14 01:00 in Tokyo — a date UTC never produces.
    assert "2026-10-14" in [d["date"] for d in tokyo["days"]]
    assert "2026-10-14" not in [d["date"] for d in utc["days"]]


def test_schedule_bad_timezone_falls_back_not_500(program_client, program_db):
    res = program_client.get(f"/public/program/{SLUG}/schedule?tz=Not/AZone")
    assert res.status_code == 200
    # Falls through to the event's own timezone.
    assert res.json()["event"]["timezone"] == "America/Los_Angeles"


def test_unknown_slug_404s(program_client, program_db):
    assert program_client.get("/public/program/nope/schedule").status_code == 404
    assert program_client.get("/public/program/nope/speakers").status_code == 404


# ── calendar feed ───────────────────────────────────────────────────────────


def test_calendar_feed_contains_one_escaped_event_per_published_session(
    program_client, program_db
):
    event = program_db.rows("events")[0]
    event["location"] = "San Francisco, CA"
    keynote = next(row for row in program_db.rows("sessions") if row["id"] == S1)
    keynote["title"] = "Opening; Keynote, Live"
    keynote["description"] = "<p>Models \\ systems; safely, now</p>"

    response = program_client.get(f"/public/program/{SLUG}/calendar.ics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/calendar")
    assert response.headers["cache-control"] == "public, max-age=300"
    body = response.text
    assert body.startswith("BEGIN:VCALENDAR\r\n")
    assert body.rstrip().endswith("END:VCALENDAR")
    assert body.count("BEGIN:VEVENT") == 4
    assert "UID:SESS-s1@dais" in body
    assert "DTSTART:20261012T160000Z" in body
    assert "DTEND:20261012T164500Z" in body
    assert "SUMMARY:Opening\\; Keynote\\, Live" in body
    assert "DESCRIPTION:Models \\\\ systems\\; safely\\, now" in body
    assert "LOCATION:Room B\\, San Francisco\\, CA" in body
    assert "Unplaced Talk" not in body
    assert "Not Yet Accepted" not in body


def test_calendar_feed_404s_for_unknown_slug(program_client, program_db):
    assert program_client.get("/public/program/nope/calendar.ics").status_code == 404


# ── the event-dates clamp ────────────────────────────────────────────────────


def _run_the_event_on(program_db, starts_at: str, ends_at: str) -> None:
    """Give the seeded event a real span. Without one there is nothing to clamp
    to, which is why every test above is unaffected by this behaviour."""
    event = program_db.rows("events")[0]
    event["starts_at"] = starts_at
    event["ends_at"] = ends_at


def test_schedule_omits_sessions_placed_outside_the_event_dates(program_client, program_db):
    """A session stranded on a date the conference does not run is not on a
    conference day, so it must not appear on the public programme — the same
    clamp the builder puts on its day tabs. Publishing it would announce a day
    the event does not have."""
    _run_the_event_on(program_db, "2026-10-12T15:00:00+00:00", "2026-10-14T01:00:00+00:00")
    program_db.seed(
        "sessions",
        _session(
            "eeeeeeee-0000-0000-0000-0000000000s8",
            status="accepted",
            # Five weeks after the conference ends — a date change left it here.
            starts_at="2026-11-20T17:00:00+00:00",
            ends_at="2026-11-20T17:30:00+00:00",
            room=ROOM_A,
            track=TRACK_ENG,
            title="Left Behind By A Date Change",
        ),
    )

    body = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    titles = [s["title"] for day in body["days"] for s in day["sessions"]]
    assert "Left Behind By A Date Change" not in titles
    assert "2026-11-20" not in [d["date"] for d in body["days"]]
    # The real programme is untouched.
    assert [d["date"] for d in body["days"]] == ["2026-10-12", "2026-10-13"]
    assert "Opening Keynote" in titles


def test_schedule_keeps_the_last_day_when_the_event_ends_at_local_midnight(
    program_client, program_db
):
    """The end is EXCLUSIVE. An event ending at 00:00 on the 14th runs through
    the 13th, so the 13th's sessions must survive the clamp."""
    _run_the_event_on(program_db, "2026-10-12T15:00:00+00:00", "2026-10-14T07:00:00+00:00")
    body = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    assert [d["date"] for d in body["days"]] == ["2026-10-12", "2026-10-13"]


def test_the_clamp_uses_the_event_zone_not_the_callers_tz(program_client, program_db):
    """A ?tz parameter regroups the DISPLAY; it must not change which sessions
    are part of the conference. Otherwise a link with ?tz=Asia/Tokyo would
    publish a different programme from the same event."""
    _run_the_event_on(program_db, "2026-10-12T15:00:00+00:00", "2026-10-14T01:00:00+00:00")
    utc = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    tokyo = program_client.get(f"/public/program/{SLUG}/schedule?tz=Asia/Tokyo").json()

    titles = {s["title"] for day in utc["days"] for s in day["sessions"]}
    assert titles == {s["title"] for day in tokyo["days"] for s in day["sessions"]}


def test_an_event_with_no_configured_span_clamps_nothing(program_client, program_db):
    """No span, nothing to clamp to. The seeded event has no dates, so this is
    also what keeps every other test in this module honest."""
    program_db.seed(
        "sessions",
        _session(
            "eeeeeeee-0000-0000-0000-0000000000s9",
            status="accepted",
            starts_at="2027-03-01T17:00:00+00:00",
            ends_at="2027-03-01T17:30:00+00:00",
            room=ROOM_A,
            track=TRACK_ENG,
            title="Far Future Talk",
        ),
    )
    body = program_client.get(f"/public/program/{SLUG}/schedule?tz=UTC").json()
    titles = [s["title"] for day in body["days"] for s in day["sessions"]]
    assert "Far Future Talk" in titles


# ── speakers ─────────────────────────────────────────────────────────────────


def test_speakers_are_distinct_and_alphabetical_by_last_name(program_client, program_db):
    body = program_client.get(f"/public/program/{SLUG}/speakers").json()
    names = [s["name"] for s in body["speakers"]]
    # Alpha, Beta, Young, Zeta — Nope (pending only) is absent.
    assert names == ["Alice Alpha", "Bob Beta", "Yolanda Young", "Zed Zeta"]
    assert "Nina Nope" not in names


def test_speakers_include_bio_socials_and_their_sessions(program_client, program_db):
    body = program_client.get(f"/public/program/{SLUG}/speakers").json()
    by_name = {s["name"]: s for s in body["speakers"]}

    alice = by_name["Alice Alpha"]
    assert alice["bio"] == "Alice is a speaker."
    assert alice["linkedin_url"] == "https://linkedin.com/in/alice"
    assert alice["twitter_url"] == "https://twitter.com/alice"
    # Speaks on two accepted sessions, earliest first.
    assert [s["title"] for s in alice["sessions"]] == ["RAG in Production", "Closing Notes"]

    # Yolanda speaks only on the accepted-but-unscheduled talk: present here,
    # with a null start, even though she never appears on the schedule.
    yolanda = by_name["Yolanda Young"]
    assert [s["title"] for s in yolanda["sessions"]] == ["Unplaced Talk"]
    assert yolanda["sessions"][0]["starts_at"] is None


def test_speaker_sessions_carry_id_and_format(program_client, program_db):
    """A speaker's session refs carry the id (so the dialog can open the shared
    detail modal) and the format name."""
    body = program_client.get(f"/public/program/{SLUG}/speakers").json()
    by_name = {s["name"]: s for s in body["speakers"]}
    ref = by_name["Zed Zeta"]["sessions"][0]
    assert ref["id"] == S1
    assert ref["title"] == "Opening Keynote"
    assert ref["track"] == {"name": "Engineering", "color": "#123456"}
    assert ref["format"] == "Keynote"


def test_speakers_carry_their_contact_id(program_client, program_db):
    """One stable identity per speaker, so the gallery can key and de-duplicate
    cards by contact rather than by display name — two different people who
    share a name must stay two cards, and one contact must never render twice."""
    body = program_client.get(f"/public/program/{SLUG}/speakers").json()
    by_name = {s["name"]: s for s in body["speakers"]}
    assert by_name["Alice Alpha"]["id"] == C_ALPHA
    assert by_name["Zed Zeta"]["id"] == C_ZETA
    ids = [s["id"] for s in body["speakers"]]
    assert all(ids) and len(set(ids)) == len(ids)


def test_speakers_leak_no_pii(program_client, program_db):
    raw = program_client.get(f"/public/program/{SLUG}/speakers").text
    payload = json.loads(raw)
    assert ZETA_EMAIL not in raw
    assert ZETA_PHONE not in raw
    for speaker in payload["speakers"]:
        assert "email" not in speaker
        assert "phone" not in speaker


# ── session detail ───────────────────────────────────────────────────────────


def test_session_detail_returns_full_description_and_speaker_bio(program_client, program_db):
    """The card clamps its blurb and omits bios; the detail view returns the full
    description plus each speaker's bio and social links (EMB-08)."""
    detail = program_client.get(f"/public/program/{SLUG}/session/{S1}").json()
    sess = detail["session"]
    assert sess["id"] == S1
    assert sess["title"] == "Opening Keynote"
    assert sess["description"] == "<p>About Opening Keynote</p>"  # full, unclamped
    assert sess["room"] == "Room B"
    assert sess["track"] == {"name": "Engineering", "color": "#123456"}
    assert detail["event"]["timezone"] == "America/Los_Angeles"

    speaker = sess["speakers"][0]
    assert speaker["name"] == "Zed Zeta"
    assert speaker["bio"] == "Zed is a speaker."
    assert speaker["linkedin_url"] == "https://linkedin.com/in/zed"
    assert speaker["twitter_url"] == "https://twitter.com/zed"


def test_session_detail_carries_format(program_client, program_db):
    detail = program_client.get(f"/public/program/{SLUG}/session/{S1}").json()
    assert detail["session"]["format"] == "Keynote"


def test_session_detail_resolves_submitter_fallback_speaker(program_client, program_db):
    # S3 has only a submitter — who stands in as the speaker, as on the schedule.
    detail = program_client.get(f"/public/program/{SLUG}/session/{S3}").json()
    assert detail["session"]["speakers"][0]["name"] == "Bob Beta"


def test_session_detail_leaks_no_pii(program_client, program_db):
    raw = program_client.get(f"/public/program/{SLUG}/session/{S1}").text
    assert ZETA_EMAIL not in raw
    assert ZETA_PHONE not in raw


def test_session_detail_404s_for_pending_unknown_or_bad_slug(program_client, program_db):
    assert program_client.get(f"/public/program/{SLUG}/session/{S5}").status_code == 404  # pending
    assert program_client.get(f"/public/program/{SLUG}/session/nope").status_code == 404
    assert program_client.get(f"/public/program/nope/session/{S1}").status_code == 404


# ── embed.js ─────────────────────────────────────────────────────────────────


def test_embed_js_is_javascript_and_self_contained(program_client, program_db):
    res = program_client.get(f"/public/program/{SLUG}/embed.js")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/javascript")

    body = res.text
    assert "data-dais-event" in body
    assert "data-dais-widget" in body
    assert "data-dais-track" in body
    assert "data-dais-accent" in body
    assert "data-dais-compact" in body
    assert "?embed=1" in body
    assert "dais-embed-height" in body
    assert "createElement('iframe')" in body
    # No untrusted data injected server-side: the slug is read at runtime.
    assert SLUG not in body
