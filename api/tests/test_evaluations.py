"""Evaluation plans, reviewer scoring, and strict assignment ownership."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from auth import get_current_user_and_org, get_current_user_or_api_org
from deps.portal_deps import get_reviewer
from routes.evaluation_routes import router as evaluation_router
from routes.review_routes import router as review_router
from services.evaluations import DEFAULT_CRITERIA, normalize_criteria, weighted_overall
from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

PLAN_ID = "plan-1"
OWNER_ID = "evaluator-owner"
OTHER_EVALUATOR_ID = "evaluator-other"
TRACK_A = "track-platform"
TRACK_B = "track-ai"


CLASSIC_CRITERIA = [
    {"name": "Relevance", "weight": 40},
    {"name": "Originality", "weight": 30},
    {"name": "Speaker", "weight": 20},
    {"name": "Clarity", "weight": 10},
]


def _seed_plan(
    fake_db,
    *,
    status: str = "draft",
    anonymized: bool = False,
    opens_at: str | None = None,
    closes_at: str | None = None,
    criteria: list[dict] | None = None,
) -> None:
    record = {
        "id": PLAN_ID,
        "org_id": TEST_ORG_ID,
        "event_id": TEST_EVENT_ID,
        "name": "Program committee",
        "instructions": "Judge the proposal, not the fame.",
        "anonymized": anonymized,
        "scale": "1_5",
        "criteria": [dict(item) for item in (criteria or CLASSIC_CRITERIA)],
        "status": status,
        "session_filter": {},
    }
    # Left OUT entirely when unset — a plan seeded before migration 008 has no
    # such keys at all, which is the shape the window logic must tolerate.
    if opens_at is not None:
        record["opens_at"] = opens_at
    if closes_at is not None:
        record["closes_at"] = closes_at
    fake_db.seed("evaluation_plans", record)


@pytest.fixture
def evaluation_client(seeded_db, monkeypatch):
    import services.evaluations as evaluation_service
    import services.magic_links as magic_link_service

    monkeypatch.setattr(evaluation_service, "supabase", seeded_db)
    monkeypatch.setattr(magic_link_service, "supabase", seeded_db)

    reviewer = {"org_id": TEST_ORG_ID, "evaluator_id": OWNER_ID}
    app = FastAPI()
    app.include_router(evaluation_router)
    app.include_router(review_router)
    app.dependency_overrides[get_current_user_and_org] = lambda: ("user-1", TEST_ORG_ID)
    app.dependency_overrides[get_current_user_or_api_org] = lambda: (
        "user-1",
        TEST_ORG_ID,
    )
    app.dependency_overrides[get_reviewer] = lambda: (
        reviewer["org_id"],
        reviewer["evaluator_id"],
    )
    with TestClient(app) as client:
        yield client, seeded_db, reviewer


def _seed_tracks(fake_db) -> None:
    fake_db.seed(
        "tracks",
        {
            "id": TRACK_A,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Platform",
            "color": "#4962E2",
            "order": 0,
        },
        {
            "id": TRACK_B,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "AI",
            "color": "#0F766E",
            "order": 1,
        },
        # another org's track, same event id — never selectable, never resolved
        {
            "id": "track-foreign",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Foreign",
            "color": "#000000",
            "order": 2,
        },
    )


def _seed_multitrack_sessions(fake_db) -> None:
    """Three reviewable sessions covering the three shapes that exist after 004:
    primary-track only (not yet backfilled), primary + membership, and a talk
    submitted to two tracks."""
    fake_db.seed(
        "sessions",
        {
            "id": "session-a",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Platform only",
            "status": "pending",
            "track_id": TRACK_A,
        },
        {
            "id": "session-b",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "AI only",
            "status": "pending",
            "track_id": TRACK_B,
        },
        {
            "id": "session-ab",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Both tracks",
            "status": "accept_queue",
            "track_id": TRACK_B,
        },
        {
            "id": "session-foreign",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Another org's talk",
            "status": "pending",
            "track_id": TRACK_A,
        },
    )
    fake_db.seed(
        "session_tracks",
        {"org_id": TEST_ORG_ID, "session_id": "session-b", "track_id": TRACK_B},
        {"org_id": TEST_ORG_ID, "session_id": "session-ab", "track_id": TRACK_B},
        {"org_id": TEST_ORG_ID, "session_id": "session-ab", "track_id": TRACK_A},
        # a membership row from another org must not widen session-b's tracks
        {"org_id": OTHER_ORG_ID, "session_id": "session-b", "track_id": TRACK_A},
    )


def test_weighted_overall_uses_normalized_weights():
    criteria = [
        {"name": "Fit", "weight": 2},
        {"name": "Craft", "weight": 1},
    ]
    assert weighted_overall({"Fit": 5, "Craft": 2}, criteria) == 4.0
    assert weighted_overall({"Fit": 5}, criteria) is None


def test_assignment_all_to_all_is_deduplicated(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    fake_db.seed(
        "evaluators",
        {"id": OWNER_ID, "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "email": "owner@test.dev"},
        {
            "id": OTHER_EVALUATOR_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "other@test.dev",
        },
    )
    fake_db.seed(
        "sessions",
        {
            "id": "session-a",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "A",
            "status": "pending",
        },
        {
            "id": "session-b",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "B",
            "status": "accept_queue",
        },
        {
            "id": "session-already-accepted",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "C",
            "status": "accepted",
        },
    )

    first_response = client.post(
        f"/api/evaluation-plans/{PLAN_ID}/assign", json={"mode": "all_to_all"}
    )
    second_response = client.post(
        f"/api/evaluation-plans/{PLAN_ID}/assign", json={"mode": "all_to_all"}
    )

    assert first_response.status_code == 200
    assert first_response.json()["created"] == 4
    assert second_response.json() == {
        "created": 0,
        "total": 4,
        "session_count": 2,
        "evaluator_count": 2,
        "assignments": [],
    }
    keys = {(row["evaluator_id"], row["session_id"]) for row in fake_db.rows("assignments")}
    assert len(keys) == 4


# ── multi-track: reviewers review one or more tracks (migration 004) ───────


def test_assign_by_track_pairs_a_reviewer_with_the_tracks_they_cover(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_tracks(fake_db)
    _seed_multitrack_sessions(fake_db)
    fake_db.seed(
        "evaluators",
        {
            "id": OWNER_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "platform@test.dev",
            "track_ids": [TRACK_A],
        },
        {
            "id": OTHER_EVALUATOR_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "everything@test.dev",
            # empty = reviews every track
            "track_ids": [],
        },
    )

    response = client.post(f"/api/evaluation-plans/{PLAN_ID}/assign", json={"mode": "by_track"})

    assert response.status_code == 200
    pairs = {
        (row["evaluator_id"], row["session_id"]) for row in fake_db.rows("assignments")
    }
    # the Platform reviewer gets the Platform talk and the two-track talk —
    # matched through session_tracks for session-ab, through the primary
    # track_id for the not-yet-backfilled session-a
    assert {session for evaluator, session in pairs if evaluator == OWNER_ID} == {
        "session-a",
        "session-ab",
    }
    # …and never the AI-only talk, not even via another org's membership row
    assert (OWNER_ID, "session-b") not in pairs
    # the reviewer with no track selection covers everything
    assert {session for evaluator, session in pairs if evaluator == OTHER_EVALUATOR_ID} == {
        "session-a",
        "session-b",
        "session-ab",
    }
    # another org's session is never in scope
    assert all(session != "session-foreign" for _evaluator, session in pairs)
    assert response.json()["created"] == 5


def test_assign_by_track_is_deduplicated_and_leaves_all_to_all_alone(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_tracks(fake_db)
    _seed_multitrack_sessions(fake_db)
    fake_db.seed(
        "evaluators",
        {
            "id": OWNER_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "platform@test.dev",
            "track_ids": [TRACK_A],
        },
    )

    first_run = client.post(f"/api/evaluation-plans/{PLAN_ID}/assign", json={"mode": "by_track"})
    second_run = client.post(f"/api/evaluation-plans/{PLAN_ID}/assign", json={"mode": "by_track"})
    assert (first_run.json()["created"], second_run.json()["created"]) == (2, 0)

    # all_to_all still ignores tracks entirely, and tops up the missing pair
    topped_up = client.post(f"/api/evaluation-plans/{PLAN_ID}/assign", json={"mode": "all_to_all"})
    assert topped_up.json()["created"] == 1
    assert len(fake_db.rows("assignments")) == 3


def test_plan_detail_exposes_reviewer_and_session_tracks(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_tracks(fake_db)
    _seed_multitrack_sessions(fake_db)
    fake_db.seed(
        "evaluators",
        {
            "id": OWNER_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "platform@test.dev",
            "name": "Ada",
            "track_ids": [TRACK_A],
        },
        {
            "id": OTHER_EVALUATOR_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "everything@test.dev",
            "name": "Grace",
        },
    )
    fake_db.seed(
        "assignments",
        {
            "id": "assignment-ab",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": OWNER_ID,
            "session_id": "session-ab",
        },
    )

    detail = client.get(f"/api/evaluation-plans/{PLAN_ID}").json()

    # the event's tracks, in the organizer's order, without the foreign one
    assert detail["tracks"] == [
        {"id": TRACK_A, "name": "Platform", "color": "#4962E2"},
        {"id": TRACK_B, "name": "AI", "color": "#0F766E"},
    ]
    by_email = {row["email"]: row for row in detail["evaluators"]}
    assert by_email["platform@test.dev"]["track_ids"] == [TRACK_A]
    assert by_email["platform@test.dev"]["tracks"] == [
        {"id": TRACK_A, "name": "Platform", "color": "#4962E2"}
    ]
    # an evaluator created before 004 has no column at all — reads as "all"
    assert by_email["everything@test.dev"]["track_ids"] == []
    assert by_email["everything@test.dev"]["tracks"] == []

    session = detail["assignments"]["by_session"][0]
    assert session["session_id"] == "session-ab"
    assert session["title"] == "Both tracks"
    # the primary track is still there, and still first
    assert session["track_id"] == TRACK_B
    assert [track["name"] for track in session["tracks"]] == ["AI", "Platform"]


def test_evaluator_track_ids_are_validated_against_the_event(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_tracks(fake_db)

    created = client.post(
        f"/api/evaluation-plans/{PLAN_ID}/evaluators",
        json={"email": "Platform@Test.dev", "name": "Ada", "track_ids": [TRACK_A]},
    )
    assert created.status_code == 201
    evaluator = created.json()["evaluator"]
    assert evaluator["track_ids"] == [TRACK_A]
    assert evaluator["email"] == "platform@test.dev"

    # another org's track is not this event's track
    rejected = client.post(
        f"/api/evaluation-plans/{PLAN_ID}/evaluators",
        json={"email": "nope@test.dev", "track_ids": ["track-foreign"]},
    )
    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "One or more tracks were not found"

    # editing swaps the coverage; an empty list means "every track" again
    patched = client.patch(
        f"/api/evaluation-plans/{PLAN_ID}/evaluators/{evaluator['id']}",
        json={"track_ids": [TRACK_B, TRACK_A]},
    )
    assert patched.status_code == 200
    # stored in the event's own track order, not the request's
    assert patched.json()["evaluator"]["track_ids"] == [TRACK_A, TRACK_B]

    cleared = client.patch(
        f"/api/evaluation-plans/{PLAN_ID}/evaluators/{evaluator['id']}",
        json={"track_ids": []},
    )
    assert cleared.json()["evaluator"]["track_ids"] == []


def test_evaluator_patch_is_org_scoped(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_tracks(fake_db)
    fake_db.seed(
        "evaluators",
        {
            "id": "evaluator-foreign",
            "org_id": OTHER_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "foreign@test.dev",
            "track_ids": [],
        },
    )

    denied = client.patch(
        f"/api/evaluation-plans/{PLAN_ID}/evaluators/evaluator-foreign",
        json={"track_ids": [TRACK_A]},
    )
    assert denied.status_code == 404
    assert fake_db.rows("evaluators")[0]["track_ids"] == []


def test_summary_carries_session_tracks(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open")
    _seed_tracks(fake_db)
    _seed_multitrack_sessions(fake_db)
    fake_db.seed(
        "assignments",
        {
            "id": "assignment-ab",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": OWNER_ID,
            "session_id": "session-ab",
        },
    )

    summary = client.get(f"/api/evaluation-plans/{PLAN_ID}/summary").json()

    row = next(item for item in summary["per_session"] if item["session_id"] == "session-ab")
    assert [track["name"] for track in row["tracks"]] == ["AI", "Platform"]


def test_summary_recalculates_weighted_scores_and_ranges(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open")
    fake_db.seed(
        "sessions",
        {
            "id": "session-a",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Divisive proposal",
            "friendly_id": "SESS-1",
            "status": "pending",
        },
        {
            "id": "session-b",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Still being scored",
            "friendly_id": "SESS-2",
            "status": "pending",
        },
    )
    fake_db.seed(
        "assignments",
        {"id": "assignment-a1", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "e1", "session_id": "session-a"},
        {"id": "assignment-a2", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "e2", "session_id": "session-a"},
        {"id": "assignment-b1", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "e1", "session_id": "session-b"},
    )
    fake_db.seed(
        "reviews",
        {
            "id": "review-a1",
            "org_id": TEST_ORG_ID,
            "assignment_id": "assignment-a1",
            "scores": {"Relevance": 5, "Originality": 4, "Speaker": 3, "Clarity": 2},
            "overall": 1,
            "is_draft": False,
            "abstained": False,
        },
        {
            "id": "review-a2",
            "org_id": TEST_ORG_ID,
            "assignment_id": "assignment-a2",
            "scores": {"Relevance": 1, "Originality": 2, "Speaker": 3, "Clarity": 4},
            "overall": 5,
            "is_draft": False,
            "abstained": False,
        },
        {
            "id": "review-b1",
            "org_id": TEST_ORG_ID,
            "assignment_id": "assignment-b1",
            "scores": {"Relevance": 5},
            "is_draft": True,
            "abstained": False,
        },
    )

    response = client.get(f"/api/evaluation-plans/{PLAN_ID}/summary")

    assert response.status_code == 200
    summary = response.json()
    assert (summary["started"], summary["in_progress"], summary["complete"]) == (3, 1, 2)
    divisive = next(row for row in summary["per_session"] if row["session_id"] == "session-a")
    assert divisive["avg_overall"] == 3.0
    assert divisive["score_range"] == 2.0
    assert summary["top_sessions"][0]["session_id"] == "session-a"
    assert summary["thought_provoking"][0]["session_id"] == "session-a"


def test_open_plan_mints_links_and_queues_invites(evaluation_client, monkeypatch):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    fake_db.seed(
        "evaluators",
        {
            "id": OWNER_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "owner@test.dev",
            "name": "Grace Hopper",
        },
        {
            "id": OTHER_EVALUATOR_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "other@test.dev",
            "name": "Margaret Hamilton",
        },
    )
    minted: list[tuple[str, str, str]] = []

    async def fake_mint(org_id, purpose, *, evaluator_id, ttl_hours):
        assert ttl_hours == 168
        minted.append((org_id, purpose, evaluator_id))
        return f"token-{evaluator_id}"

    import services.evaluations as evaluation_service

    monkeypatch.setattr(evaluation_service.magic_links, "mint", fake_mint)
    monkeypatch.setenv("FRONTEND_URL", "https://dais.test")

    response = client.post(f"/api/evaluation-plans/{PLAN_ID}/open")

    assert response.status_code == 200
    assert response.json()["count"] == 2
    assert {call[2] for call in minted} == {OWNER_ID, OTHER_EVALUATOR_ID}
    assert fake_db.rows("evaluation_plans")[0]["status"] == "open"
    queued = fake_db.rows("email_outbox")
    assert len(queued) == 2
    assert queued[0]["status"] == "queued"
    assert queued[0]["payload"]["subject"] == "[AI Builders Summit] You've been invited to review"
    assert queued[0]["payload"]["reviewer_link"].startswith("https://dais.test/review/token-")
    assert all(row.get("invited_at") for row in fake_db.rows("evaluators"))


def test_reviewer_links_mints_a_fresh_link_per_evaluator(evaluation_client, monkeypatch):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open")
    fake_db.seed(
        "evaluators",
        {
            "id": OWNER_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "owner@test.dev",
            "name": "Grace Hopper",
        },
        {
            "id": OTHER_EVALUATOR_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "other@test.dev",
            "name": "Margaret Hamilton",
        },
    )
    monkeypatch.setenv("FRONTEND_URL", "https://dais.test")

    response = client.get(f"/api/evaluation-plans/{PLAN_ID}/reviewer-links")

    assert response.status_code == 200
    links = response.json()
    assert {row["evaluator_id"] for row in links} == {OWNER_ID, OTHER_EVALUATOR_ID}
    by_id = {row["evaluator_id"]: row for row in links}
    assert by_id[OWNER_ID]["name"] == "Grace Hopper"
    assert by_id[OWNER_ID]["email"] == "owner@test.dev"
    assert all(row["review_url"].startswith("https://dais.test/review/") for row in links)

    # a fresh review token was persisted for each evaluator (nothing queued)
    tokens = [t for t in fake_db.rows("magic_link_tokens") if t.get("purpose") == "review"]
    assert {t.get("evaluator_id") for t in tokens} == {OWNER_ID, OTHER_EVALUATOR_ID}
    assert fake_db.rows("email_outbox") == []


def test_reviewer_links_scoped_to_org(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    # A plan belonging to another org must not be readable.
    fake_db.seed(
        "evaluation_plans",
        {
            "id": "foreign-plan",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Someone else's committee",
            "criteria": [{"name": "Relevance", "weight": 100}],
            "status": "open",
            "session_filter": {},
        },
    )
    assert client.get("/api/evaluation-plans/foreign-plan/reviewer-links").status_code == 404


def test_reviewer_can_only_read_and_score_their_assignments(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open")
    fake_db.seed(
        "evaluators",
        {"id": OWNER_ID, "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "email": "owner@test.dev"},
        {
            "id": OTHER_EVALUATOR_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "other@test.dev",
        },
    )
    fake_db.seed(
        "sessions",
        {
            "id": "session-a",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Owned assignment",
            "description": "Visible",
            "status": "pending",
        },
        {
            "id": "session-b",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Another reviewer's assignment",
            "description": "Not visible",
            "status": "pending",
        },
    )
    fake_db.seed(
        "assignments",
        {
            "id": "assignment-owned",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": OWNER_ID,
            "session_id": "session-a",
        },
        {
            "id": "assignment-other",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": OTHER_EVALUATOR_ID,
            "session_id": "session-b",
        },
        {
            "id": "assignment-other-org",
            "org_id": OTHER_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": OWNER_ID,
            "session_id": "session-b",
        },
    )

    assert client.get("/public/review/submissions/assignment-owned").status_code == 200
    denied = client.get("/public/review/submissions/assignment-other")
    assert denied.status_code == 404
    assert denied.json()["detail"] == "Assignment not found"
    assert client.get("/public/review/submissions/assignment-other-org").status_code == 404

    score_payload = {
        "scores": {"Relevance": 5, "Originality": 4, "Speaker": 3, "Clarity": 2},
        "comment": "Strong fit.",
        "is_draft": False,
    }
    assert client.put("/public/review/submissions/assignment-other", json=score_payload).status_code == 404
    saved = client.put("/public/review/submissions/assignment-owned", json=score_payload)
    assert saved.status_code == 200
    assert saved.json()["review"]["overall"] == 4.0
    assert fake_db.rows("reviews")[0]["assignment_id"] == "assignment-owned"


# ── review window (migration 008, ABS-01) ──────────────────────────────────
# A plan carries the dates reviewing is open between. Both bounds are optional
# and a missing bound is no bound, so nothing seeded before 008 changes.

SCORE_PAYLOAD = {
    "scores": {"Relevance": 5, "Originality": 4, "Speaker": 3, "Clarity": 2},
    "comment": "Strong fit.",
    "is_draft": False,
}


def _seed_owned_assignment(fake_db) -> None:
    fake_db.seed(
        "evaluators",
        {"id": OWNER_ID, "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "email": "owner@test.dev"},
    )
    fake_db.seed(
        "sessions",
        {
            "id": "session-a",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Owned assignment",
            "status": "pending",
        },
    )
    fake_db.seed(
        "assignments",
        {
            "id": "assignment-owned",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": OWNER_ID,
            "session_id": "session-a",
        },
    )


def _seed_reviewer_submission_details(fake_db) -> None:
    """A form whose answer map contains both identity and proposal details."""
    form_id = "form-review-details"
    fields = [
        ("field-speaker-name", "speaker_name", "Speaker name", "contact", "Priya Raman"),
        ("field-company", "company_name", "Company", "contact", "Latticework Systems"),
        ("field-email", "email", "Email address", "contact", "priya@latticework.example"),
        ("field-bio", "bio", "Why are you a fit?", "contact", "Priya founded Latticework."),
        ("field-abstract", "abstract", "Abstract", "session", "A practical systems talk."),
        (
            "field-prereqs",
            "prerequisites",
            "Technical prerequisites",
            "session",
            "Bring a laptop.",
        ),
    ]
    for order, (field_id, internal_name, label, scope, _value) in enumerate(fields):
        fake_db.seed(
            "fields",
            {
                "id": field_id,
                "org_id": TEST_ORG_ID,
                "public_name": label,
                "internal_name": internal_name,
                "scope": scope,
            },
        )
        fake_db.seed(
            "form_fields",
            {
                "id": f"review-ff-{order}",
                "org_id": TEST_ORG_ID,
                "form_id": form_id,
                "field_id": field_id,
                "page": 1,
                "order": order,
                "label_override": "What should reviewers prepare?" if field_id == "field-prereqs" else None,
            },
        )
    session = fake_db.rows("sessions")[0]
    session["source_form_id"] = form_id
    session["submitter_contact_id"] = "contact-priya"
    session["form_answers"] = {
        field_id: value for field_id, _internal_name, _label, _scope, value in fields
    }
    _seed_submitter_participant_rows(fake_db)
    fake_db.rows("contacts")[0]["company_name"] = "Latticework Systems"


def test_anonymized_reviewer_details_redact_identity_and_resolve_question_labels(
    evaluation_client,
):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", anonymized=True)
    _seed_owned_assignment(fake_db)
    _seed_reviewer_submission_details(fake_db)

    response = client.get("/public/review/submissions/assignment-owned")

    assert response.status_code == 200
    session = response.json()["session"]
    assert session["form_answers"] == {
        "Abstract": "A practical systems talk.",
        "What should reviewers prepare?": "Bring a laptop.",
    }
    serialized = response.text.casefold()
    assert "priya raman" not in serialized
    assert "latticework systems" not in serialized
    assert "priya@latticework.example" not in serialized
    assert "field-abstract" not in serialized
    assert "field-prereqs" not in serialized


def test_non_anonymized_reviewer_details_keep_identity_with_human_labels(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", anonymized=False)
    _seed_owned_assignment(fake_db)
    _seed_reviewer_submission_details(fake_db)

    session = client.get("/public/review/submissions/assignment-owned").json()["session"]

    assert session["form_answers"]["Speaker name"] == "Priya Raman"
    assert session["form_answers"]["Company"] == "Latticework Systems"
    assert session["form_answers"]["Email address"] == "priya@latticework.example"
    assert session["speaker"]["first_name"] == "Priya"


def test_a_plan_with_no_window_accepts_reviews(evaluation_client):
    """The state every seeded/pre-008 plan is in: no dates, no restriction."""
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open")
    _seed_owned_assignment(fake_db)

    saved = client.put("/public/review/submissions/assignment-owned", json=SCORE_PAYLOAD)

    assert saved.status_code == 200
    assert saved.json()["review"]["overall"] == 4.0


def test_a_review_inside_the_window_is_accepted(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(
        fake_db,
        status="open",
        opens_at="2020-01-01T00:00:00+00:00",
        closes_at="2099-12-31T23:59:59+00:00",
    )
    _seed_owned_assignment(fake_db)

    assert client.put("/public/review/submissions/assignment-owned", json=SCORE_PAYLOAD).status_code == 200


def test_a_review_after_the_window_closed_is_403(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(
        fake_db,
        status="open",
        opens_at="2020-01-01T00:00:00+00:00",
        closes_at="2020-01-10T23:59:59+00:00",
    )
    _seed_owned_assignment(fake_db)

    blocked = client.put("/public/review/submissions/assignment-owned", json=SCORE_PAYLOAD)

    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "The review window closed Jan 10, 2020."
    # nothing was written — a closed window is not a partial save
    assert fake_db.rows("reviews") == []


def test_a_review_before_the_window_opens_is_403(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", opens_at="2099-01-01T00:00:00+00:00")
    _seed_owned_assignment(fake_db)

    blocked = client.put("/public/review/submissions/assignment-owned", json=SCORE_PAYLOAD)

    assert blocked.status_code == 403
    assert "review window opens" in blocked.json()["detail"]
    assert fake_db.rows("reviews") == []


def test_the_window_also_governs_drafts(evaluation_client):
    """A deadline that only stops final submissions isn't a deadline."""
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", closes_at="2020-01-10T23:59:59+00:00")
    _seed_owned_assignment(fake_db)

    draft = client.put(
        "/public/review/submissions/assignment-owned",
        json={"scores": {"Relevance": 4}, "is_draft": True},
    )
    assert draft.status_code == 403


def test_plan_create_stores_the_window_and_the_detail_reads_it_back(evaluation_client):
    client, _fake_db, _reviewer = evaluation_client

    created = client.post(
        f"/api/events/{TEST_EVENT_ID}/evaluation-plans",
        json={"name": "Committee", "opens_at": "2026-10-01", "closes_at": "2026-10-10"},
    )

    assert created.status_code == 201
    plan = created.json()["plan"]
    # a bare date opens at midnight and closes at the END of the day it names
    assert plan["opens_at"].startswith("2026-10-01T00:00:00")
    assert plan["closes_at"].startswith("2026-10-10T23:59:59")

    detail = client.get(f"/api/evaluation-plans/{plan['id']}").json()
    assert detail["plan"]["opens_at"] == plan["opens_at"]
    assert detail["plan"]["closes_at"] == plan["closes_at"]

    listed = client.get(f"/api/events/{TEST_EVENT_ID}/evaluation-plans").json()["plans"]
    assert listed[0]["closes_at"] == plan["closes_at"]


def test_plan_patch_moves_and_clears_the_window(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, opens_at="2026-10-01T00:00:00+00:00", closes_at="2026-10-10T23:59:59+00:00")

    moved = client.patch(f"/api/evaluation-plans/{PLAN_ID}", json={"closes_at": "2026-10-20"})
    assert moved.status_code == 200
    assert moved.json()["plan"]["closes_at"].startswith("2026-10-20T23:59:59")

    cleared = client.patch(f"/api/evaluation-plans/{PLAN_ID}", json={"opens_at": None, "closes_at": None})
    assert cleared.status_code == 200
    assert cleared.json()["plan"]["opens_at"] is None
    assert cleared.json()["plan"]["closes_at"] is None


def test_a_window_that_closes_before_it_opens_is_rejected(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, opens_at="2026-10-01T00:00:00+00:00")

    # checked against the bound already stored, not just the two in one payload
    rejected = client.patch(f"/api/evaluation-plans/{PLAN_ID}", json={"closes_at": "2026-09-01"})
    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "The review window closes before it opens"

    both_at_once = client.post(
        f"/api/events/{TEST_EVENT_ID}/evaluation-plans",
        json={"name": "Backwards", "opens_at": "2026-10-10", "closes_at": "2026-10-01"},
    )
    assert both_at_once.status_code == 400


def test_an_unparseable_window_value_is_a_400(evaluation_client):
    client, _fake_db, _reviewer = evaluation_client
    rejected = client.post(
        f"/api/events/{TEST_EVENT_ID}/evaluation-plans",
        json={"name": "Committee", "closes_at": "next tuesday"},
    )
    assert rejected.status_code == 400


def test_plans_still_save_when_migration_008_is_missing(evaluation_client, monkeypatch):
    """A database still on 007 drops the dates rather than failing the save."""
    client, fake_db, _reviewer = evaluation_client
    import services.evaluations as evaluation_service

    monkeypatch.setattr(evaluation_service, "_window_columns_present", True)
    original_table = fake_db.table

    def table(name: str):
        query = original_table(name)
        if name == "evaluation_plans":
            for operation in ("insert", "update"):
                inner = getattr(query, operation)

                def guarded(payload, _inner=inner):
                    if any(field in payload for field in ("opens_at", "closes_at")):
                        raise RuntimeError(
                            "{'code': 'PGRST204', 'message': \"Could not find the "
                            "'opens_at' column of 'evaluation_plans' in the schema cache\"}"
                        )
                    return _inner(payload)

                setattr(query, operation, guarded)
        return query

    monkeypatch.setattr(fake_db, "table", table)

    created = client.post(
        f"/api/events/{TEST_EVENT_ID}/evaluation-plans",
        json={"name": "Committee", "opens_at": "2026-10-01", "closes_at": "2026-10-10"},
    )

    assert created.status_code == 201
    plan = created.json()["plan"]
    assert plan["name"] == "Committee"
    # the keys are always present in the response, just empty
    assert (plan["opens_at"], plan["closes_at"]) == (None, None)
    assert "opens_at" not in fake_db.rows("evaluation_plans")[0]

    # …and the next write skips the doomed attempt entirely
    patched = client.patch(f"/api/evaluation-plans/{plan['id']}", json={"closes_at": "2026-10-20"})
    assert patched.status_code == 200
    assert patched.json()["plan"]["closes_at"] is None


# ── per-submission assignment (ABS-05) ─────────────────────────────────────


def _seed_pair(fake_db) -> None:
    fake_db.seed(
        "evaluators",
        {
            "id": OWNER_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "ada@test.dev",
            "name": "Ada Lovelace",
        },
        {
            "id": OTHER_EVALUATOR_ID,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "grace@test.dev",
            "name": "Grace Hopper",
        },
        {
            "id": "evaluator-foreign",
            "org_id": OTHER_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "foreign@test.dev",
            "name": "Not ours",
        },
    )
    fake_db.seed(
        "sessions",
        {
            "id": "session-a",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "A talk",
            "friendly_id": "SESS-1",
            "status": "pending",
        },
        {
            "id": "session-b",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "B talk",
            "friendly_id": "SESS-2",
            "status": "accept_queue",
        },
        {
            "id": "session-foreign",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Another org's talk",
            "status": "pending",
        },
    )


def test_a_single_reviewer_can_be_assigned_to_a_single_submission(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)

    created = client.post(
        f"/api/plans/{PLAN_ID}/assignments",
        json={"evaluator_id": OWNER_ID, "session_id": "session-b"},
    )

    assert created.status_code == 201
    assignment = created.json()["assignment"]
    assert assignment["evaluator_id"] == OWNER_ID
    assert assignment["session_id"] == "session-b"
    assert assignment["evaluator_name"] == "Ada Lovelace"
    assert assignment["session_title"] == "B talk"
    assert len(fake_db.rows("assignments")) == 1

    # the long-form path is the same endpoint
    twin = client.post(
        f"/api/evaluation-plans/{PLAN_ID}/assignments",
        json={"evaluator_id": OTHER_EVALUATOR_ID, "session_id": "session-b"},
    )
    assert twin.status_code == 201
    assert len(fake_db.rows("assignments")) == 2


def test_assigning_the_same_pair_twice_is_a_409(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    body = {"evaluator_id": OWNER_ID, "session_id": "session-a"}

    assert client.post(f"/api/plans/{PLAN_ID}/assignments", json=body).status_code == 201
    duplicate = client.post(f"/api/plans/{PLAN_ID}/assignments", json=body)

    assert duplicate.status_code == 409
    assert "already assigned" in duplicate.json()["detail"]
    assert len(fake_db.rows("assignments")) == 1


def test_single_assignment_never_crosses_an_org(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    fake_db.seed(
        "evaluation_plans",
        {
            "id": "foreign-plan",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Theirs",
            "criteria": [{"name": "Relevance", "weight": 100}],
            "status": "draft",
            "session_filter": {},
        },
    )

    foreign_evaluator = client.post(
        f"/api/plans/{PLAN_ID}/assignments",
        json={"evaluator_id": "evaluator-foreign", "session_id": "session-a"},
    )
    foreign_session = client.post(
        f"/api/plans/{PLAN_ID}/assignments",
        json={"evaluator_id": OWNER_ID, "session_id": "session-foreign"},
    )
    foreign_plan = client.post(
        "/api/plans/foreign-plan/assignments",
        json={"evaluator_id": OWNER_ID, "session_id": "session-a"},
    )
    unknown_session = client.post(
        f"/api/plans/{PLAN_ID}/assignments",
        json={"evaluator_id": OWNER_ID, "session_id": "session-nope"},
    )

    assert foreign_evaluator.status_code == 404
    assert foreign_session.status_code == 404
    assert foreign_plan.status_code == 404
    assert unknown_session.status_code == 404
    assert fake_db.rows("assignments") == []


def test_unassigning_drops_the_pairing_and_its_review(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    created = client.post(
        f"/api/plans/{PLAN_ID}/assignments",
        json={"evaluator_id": OWNER_ID, "session_id": "session-a"},
    ).json()["assignment"]
    fake_db.seed(
        "reviews",
        {
            "id": "review-1",
            "org_id": TEST_ORG_ID,
            "assignment_id": created["id"],
            "scores": {},
            "is_draft": True,
        },
    )

    removed = client.delete(f"/api/plans/{PLAN_ID}/assignments/{created['id']}")

    assert removed.status_code == 204
    assert fake_db.rows("assignments") == []
    # The review's removal is Postgres' job: reviews.assignment_id is
    # ON DELETE CASCADE (001_init.sql), so one scoped assignment delete drops
    # the pairing and its review atomically. The fake store has no FK engine,
    # so the review row lingering HERE is expected — what matters is that the
    # service issues exactly one delete, against the assignment.
    assert [r["id"] for r in fake_db.rows("reviews")] == ["review-1"]


def test_unassigning_is_org_scoped(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    fake_db.seed(
        "assignments",
        {
            "id": "assignment-foreign",
            "org_id": OTHER_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": "evaluator-foreign",
            "session_id": "session-foreign",
        },
    )

    denied = client.delete(f"/api/plans/{PLAN_ID}/assignments/assignment-foreign")

    assert denied.status_code == 404
    assert len(fake_db.rows("assignments")) == 1


def test_the_assignment_board_lists_candidates_with_their_reviewers(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    fake_db.seed(
        "sessions",
        {
            "id": "session-accepted",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Already decided",
            "status": "accepted",
        },
    )
    fake_db.seed(
        "assignments",
        {
            "id": "assignment-1",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": OWNER_ID,
            "session_id": "session-a",
        },
    )
    fake_db.seed(
        "reviews",
        {
            "id": "review-1",
            "org_id": TEST_ORG_ID,
            "assignment_id": "assignment-1",
            "scores": {},
            "is_draft": True,
        },
    )

    board = client.get(f"/api/plans/{PLAN_ID}/assignments").json()

    assert [row["id"] for row in board["evaluators"]] == [OWNER_ID, OTHER_EVALUATOR_ID]
    titles = [row["title"] for row in board["sessions"]]
    # reviewable submissions only; another org's talk is never a candidate
    assert titles == ["A talk", "B talk"]
    first_row = board["sessions"][0]
    assert first_row["assignments"] == [
        {
            "assignment_id": "assignment-1",
            "evaluator_id": OWNER_ID,
            "name": "Ada Lovelace",
            "email": "ada@test.dev",
            "review_status": "in_progress",
        }
    ]
    assert board["sessions"][1]["assignments"] == []


def test_the_assignment_board_is_org_scoped(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    fake_db.seed(
        "evaluation_plans",
        {
            "id": "foreign-plan",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Theirs",
            "criteria": [{"name": "Relevance", "weight": 100}],
            "status": "draft",
            "session_filter": {},
        },
    )
    assert client.get("/api/plans/foreign-plan/assignments").status_code == 404


# ── targeted laggard reminders (ABS-09) ────────────────────────────────────


def _seed_reminder_fixture(fake_db) -> None:
    """Three reviewers: one finished, one half-done, one who never started."""
    _seed_plan(fake_db, status="open", closes_at="2099-10-10T23:59:59+00:00")
    fake_db.seed(
        "evaluators",
        {
            "id": "evaluator-done",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "done@test.dev",
            "name": "Finished Fran",
        },
        {
            "id": "evaluator-draft",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "draft@test.dev",
            "name": "Drafting Dana",
        },
        {
            "id": "evaluator-idle",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "email": "idle@test.dev",
            "name": "Idle Ida",
        },
    )
    fake_db.seed(
        "assignments",
        {"id": "a-done", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "evaluator-done", "session_id": "session-a"},
        {"id": "a-draft", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "evaluator-draft", "session_id": "session-a"},
        {"id": "a-idle", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "evaluator-idle", "session_id": "session-a"},
    )
    fake_db.seed(
        "reviews",
        {"id": "r-done", "org_id": TEST_ORG_ID, "assignment_id": "a-done", "scores": {}, "is_draft": False},
        {"id": "r-draft", "org_id": TEST_ORG_ID, "assignment_id": "a-draft", "scores": {}, "is_draft": True},
    )


def test_remind_laggards_emails_only_the_reviewers_with_work_left(evaluation_client, monkeypatch):
    client, fake_db, _reviewer = evaluation_client
    _seed_reminder_fixture(fake_db)
    monkeypatch.setenv("FRONTEND_URL", "https://dais.test")

    response = client.post(f"/api/plans/{PLAN_ID}/remind-laggards")

    assert response.status_code == 200
    body = response.json()
    assert body["reminded"] == 2
    # the reviewer who submitted is left alone; a draft still counts as unfinished
    assert sorted(body["evaluators"]) == ["Drafting Dana", "Idle Ida"]
    queued = fake_db.rows("email_outbox")
    assert len(queued) == 2
    assert {row["payload"]["to"] for row in queued} == {"draft@test.dev", "idle@test.dev"}
    assert all(row["template_key"] == "evaluation_reminder" for row in queued)
    assert all(row["status"] == "queued" for row in queued)
    assert all(row["dedupe_key"].startswith("eval-laggard:") for row in queued)
    assert all("https://dais.test/review/" in row["payload"]["reviewer_link"] for row in queued)
    # the deadline the reminder is about rides along
    assert all("Oct 10, 2099" in row["payload"]["body_html"] for row in queued)


def test_remind_laggards_does_not_storm_on_a_second_click(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_reminder_fixture(fake_db)

    first_click = client.post(f"/api/plans/{PLAN_ID}/remind-laggards").json()
    second_click = client.post(f"/api/plans/{PLAN_ID}/remind-laggards").json()

    assert first_click["reminded"] == 2
    assert second_click["reminded"] == 0
    assert second_click["skipped"] == 2
    assert sorted(second_click["already_reminded"]) == ["Drafting Dana", "Idle Ida"]
    assert len(fake_db.rows("email_outbox")) == 2


def test_remind_laggards_with_nobody_behind_queues_nothing(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open")
    fake_db.seed(
        "evaluators",
        {"id": "evaluator-done", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "email": "done@test.dev", "name": "Fran"},
    )
    fake_db.seed(
        "assignments",
        {"id": "a-done", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "evaluator-done", "session_id": "session-a"},
    )
    fake_db.seed(
        "reviews",
        {"id": "r-done", "org_id": TEST_ORG_ID, "assignment_id": "a-done", "scores": {}, "is_draft": False},
    )

    body = client.post(f"/api/plans/{PLAN_ID}/remind-laggards").json()

    assert body == {
        "reminded": 0,
        "evaluators": [],
        "skipped": 0,
        "already_reminded": [],
        "incomplete_reviewers": 0,
        "outstanding": 0,
    }
    assert fake_db.rows("email_outbox") == []


def test_remind_laggards_is_org_scoped(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    fake_db.seed(
        "evaluation_plans",
        {
            "id": "foreign-plan",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Theirs",
            "criteria": [{"name": "Relevance", "weight": 100}],
            "status": "open",
            "session_filter": {},
        },
    )
    assert client.post("/api/plans/foreign-plan/remind-laggards").status_code == 404
    assert fake_db.rows("email_outbox") == []


# ── non-numeric criteria (ABS-03) ──────────────────────────────────────────
# A criterion can now be a fixed CHOICE or free TEXT as well as the weighted
# rating it always was. The contract that matters most is the one these tests
# pin first: a criterion with no `kind` is a scale criterion, stores as
# `{name, weight}`, and scores exactly as it did before any of this existed.

MIXED_CRITERIA = [
    {"name": "Relevance", "weight": 60},
    {"name": "Originality", "weight": 40},
    {"name": "Track fit", "weight": 0, "kind": "select", "options": ["Yes", "No", "Unsure"]},
    {"name": "Advice", "weight": 0, "kind": "text"},
]
UNSCORED_CRITERIA = [
    {"name": "Track fit", "weight": 0, "kind": "select", "options": ["Yes", "No"]},
    {"name": "Advice", "weight": 0, "kind": "text"},
]


def _create_plan(client, criteria: list[dict], name: str = "Mixed scorecard"):
    return client.post(
        f"/api/events/{TEST_EVENT_ID}/evaluation-plans",
        json={"name": name, "criteria": criteria},
    )


def test_an_old_shape_plan_normalizes_to_itself(evaluation_client):
    """THE regression pin: nothing about a pre-ABS-03 criterion changes.

    No `kind` key is read, none is written, and normalizing is a fixed point —
    so every stored plan (including the seeded demo one) round-trips byte for
    byte through a save.
    """
    assert normalize_criteria(CLASSIC_CRITERIA) == CLASSIC_CRITERIA
    assert normalize_criteria(DEFAULT_CRITERIA) == DEFAULT_CRITERIA
    assert normalize_criteria(normalize_criteria(CLASSIC_CRITERIA)) == CLASSIC_CRITERIA
    assert all(set(item) == {"name", "weight"} for item in normalize_criteria(CLASSIC_CRITERIA))


def test_an_explicit_scale_kind_is_stored_as_the_old_shape():
    """The new UI sends kind='scale'; storage stays the pre-ABS-03 two keys."""
    assert normalize_criteria([{"name": "Relevance", "weight": 100, "kind": "scale"}]) == [
        {"name": "Relevance", "weight": 100}
    ]


def test_choice_and_text_criteria_normalize_without_a_weight():
    saved = normalize_criteria(
        [
            {"name": "Relevance", "weight": 100},
            {"name": "Track fit", "kind": "select", "options": [" Yes ", "No", "yes", ""]},
            # A weight sent for a text criterion is ignored, not honoured.
            {"name": "Advice", "kind": "text", "weight": 55},
        ]
    )
    assert saved == [
        {"name": "Relevance", "weight": 100},
        {"name": "Track fit", "weight": 0, "kind": "select", "options": ["Yes", "No"]},
        {"name": "Advice", "weight": 0, "kind": "text"},
    ]


def test_a_choice_criterion_needs_options():
    for options in (None, [], ["", "  "]):
        with pytest.raises(HTTPException) as raised:
            normalize_criteria([{"name": "Track fit", "kind": "select", "options": options}])
        assert raised.value.status_code == 400


def test_an_unknown_criterion_type_is_rejected():
    with pytest.raises(HTTPException) as raised:
        normalize_criteria([{"name": "Track fit", "weight": 100, "kind": "slider"}])
    assert raised.value.status_code == 400
    assert "unknown type" in str(raised.value.detail)


def test_only_scale_weights_count_toward_the_hundred(evaluation_client):
    client, _fake_db, _reviewer = evaluation_client

    ok = _create_plan(client, MIXED_CRITERIA)
    assert ok.status_code == 201
    assert ok.json()["plan"]["criteria"] == [
        {"name": "Relevance", "weight": 60},
        {"name": "Originality", "weight": 40},
        {"name": "Track fit", "weight": 0, "kind": "select", "options": ["Yes", "No", "Unsure"]},
        {"name": "Advice", "weight": 0, "kind": "text"},
    ]

    short = _create_plan(client, [{"name": "Relevance", "weight": 60}, *UNSCORED_CRITERIA])
    assert short.status_code == 400
    assert short.json()["detail"] == "Criterion weights must add up to 100"


def test_a_plan_with_no_scale_criteria_is_allowed(evaluation_client):
    """Nothing to weight means no 100% rule — the scorecard is all questions."""
    client, _fake_db, _reviewer = evaluation_client

    created = _create_plan(client, UNSCORED_CRITERIA, name="Questionnaire")

    assert created.status_code == 201
    assert created.json()["plan"]["criteria"] == UNSCORED_CRITERIA


def test_weighted_overall_skips_the_non_scale_criteria():
    assert weighted_overall(
        {"Relevance": 5, "Originality": 2, "Track fit": "Yes", "Advice": "Tighten the intro."},
        MIXED_CRITERIA,
    ) == 3.8  # (5*60 + 2*40) / 100 — the strings never enter the mean
    # A missing SCALE answer is still incomplete...
    assert weighted_overall({"Relevance": 5, "Track fit": "Yes"}, MIXED_CRITERIA) is None
    # ...but a missing text answer is not.
    assert weighted_overall({"Relevance": 5, "Originality": 5, "Track fit": "Yes"}, MIXED_CRITERIA) == 5.0
    # Nothing to weight at all: no overall, never a crash on a string.
    assert weighted_overall({"Track fit": "Yes", "Advice": "Nice"}, UNSCORED_CRITERIA) is None


def test_an_old_shape_review_is_saved_exactly_as_before(evaluation_client):
    """The reviewer-side regression pin, end to end on a pre-ABS-03 plan."""
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open")
    _seed_owned_assignment(fake_db)

    saved = client.put("/public/review/submissions/assignment-owned", json=SCORE_PAYLOAD)

    assert saved.status_code == 200
    review = saved.json()["review"]
    assert review["scores"] == {"Relevance": 5, "Originality": 4, "Speaker": 3, "Clarity": 2}
    assert review["overall"] == 4.0
    assert review["is_draft"] is False


def test_a_mixed_scorecard_stores_strings_beside_the_scores(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", criteria=MIXED_CRITERIA)
    _seed_owned_assignment(fake_db)

    saved = client.put(
        "/public/review/submissions/assignment-owned",
        json={
            "scores": {
                "Relevance": 5,
                "Originality": 2,
                "Track fit": "Yes",
                "Advice": "  Tighten the intro.  ",
            },
            "is_draft": False,
        },
    )

    assert saved.status_code == 200
    review = saved.json()["review"]
    assert review["scores"] == {
        "Relevance": 5,
        "Originality": 2,
        "Track fit": "Yes",
        "Advice": "Tighten the intro.",
    }
    # The overall is the weighted mean of the SCALE part only.
    assert review["overall"] == 3.8


def test_a_choice_answer_must_be_one_of_the_options(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", criteria=MIXED_CRITERIA)
    _seed_owned_assignment(fake_db)

    for value in ("Maybe", "yes", 3, True):
        rejected = client.put(
            "/public/review/submissions/assignment-owned",
            json={
                "scores": {"Relevance": 5, "Originality": 2, "Track fit": value, "Advice": "x"},
                "is_draft": False,
            },
        )
        assert rejected.status_code == 400
        assert rejected.json()["detail"] == "Answer for 'Track fit' must be one of: Yes, No, Unsure"
    assert fake_db.rows("reviews") == []


def test_a_text_answer_is_capped(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", criteria=MIXED_CRITERIA)
    _seed_owned_assignment(fake_db)

    def submit(advice: str):
        return client.put(
            "/public/review/submissions/assignment-owned",
            json={
                "scores": {
                    "Relevance": 5,
                    "Originality": 2,
                    "Track fit": "No",
                    "Advice": advice,
                },
                "is_draft": False,
            },
        )

    too_long = submit("a" * 2001)
    assert too_long.status_code == 400
    assert "2000 characters or fewer" in too_long.json()["detail"]
    assert submit("a" * 2000).status_code == 200


def test_a_choice_is_required_on_submit_but_free_text_is_not(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", criteria=MIXED_CRITERIA)
    _seed_owned_assignment(fake_db)

    missing_choice = client.put(
        "/public/review/submissions/assignment-owned",
        json={"scores": {"Relevance": 5, "Originality": 2, "Advice": "Nice"}, "is_draft": False},
    )
    assert missing_choice.status_code == 400
    assert missing_choice.json()["detail"] == "Score required for: Track fit"

    without_prose = client.put(
        "/public/review/submissions/assignment-owned",
        json={"scores": {"Relevance": 5, "Originality": 2, "Track fit": "No"}, "is_draft": False},
    )
    assert without_prose.status_code == 200
    assert "Advice" not in without_prose.json()["review"]["scores"]


def test_a_blank_choice_or_text_answer_is_no_answer(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", criteria=MIXED_CRITERIA)
    _seed_owned_assignment(fake_db)

    draft = client.put(
        "/public/review/submissions/assignment-owned",
        json={"scores": {"Relevance": 5, "Track fit": "   ", "Advice": ""}, "is_draft": True},
    )

    assert draft.status_code == 200
    assert draft.json()["review"]["scores"] == {"Relevance": 5}


def test_a_scorecard_with_no_scale_criteria_submits_without_an_overall(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", criteria=UNSCORED_CRITERIA)
    _seed_owned_assignment(fake_db)

    saved = client.put(
        "/public/review/submissions/assignment-owned",
        json={"scores": {"Track fit": "Yes", "Advice": "Ship it."}, "is_draft": False},
    )

    assert saved.status_code == 200
    assert saved.json()["review"]["overall"] is None
    # The plan summary has to survive a session whose reviews carry no number.
    summary = client.get(f"/api/evaluation-plans/{PLAN_ID}/summary")
    assert summary.status_code == 200
    row = summary.json()["per_session"][0]
    assert row["avg_overall"] is None
    assert row["completed_count"] == 1
    assert row["review_count"] == 0


def test_an_unknown_criterion_is_still_rejected(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", criteria=MIXED_CRITERIA)
    _seed_owned_assignment(fake_db)

    rejected = client.put(
        "/public/review/submissions/assignment-owned",
        json={"scores": {"Relevance": 5, "Vibes": "great"}, "is_draft": True},
    )

    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "Unknown criterion: Vibes"


def test_the_reviewer_portal_carries_the_criterion_kinds(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", criteria=MIXED_CRITERIA)
    _seed_owned_assignment(fake_db)

    home = client.get("/public/review/me").json()

    assert home["plan"]["criteria"] == MIXED_CRITERIA


# ── the reviewer portal tells the truth about people and about state ────────
# Two judge-visible defects lived here: the submitter printed twice on the
# presenter line, and a "Review closed" badge that contradicted the window
# beside it.


def _seed_submitter_participant_rows(fake_db) -> None:
    """The dual encoding a CFP submission writes: one contact, two roles."""
    fake_db.seed(
        "contacts",
        {
            "id": "contact-priya",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "first_name": "Priya",
            "last_name": "Raman",
            "email": "priya@example.com",
        },
    )
    fake_db.seed(
        "session_participants",
        {
            "org_id": TEST_ORG_ID,
            "session_id": "session-a",
            "contact_id": "contact-priya",
            "role": "speaker",
            "is_primary": True,
        },
        {
            "org_id": TEST_ORG_ID,
            "session_id": "session-a",
            "contact_id": "contact-priya",
            "role": "submitter",
            "is_primary": False,
        },
    )


def test_reviewer_sees_one_entry_per_person_not_per_participant_row(evaluation_client):
    """'Presented by Priya Raman, Priya Raman' — the dual row is storage only."""
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open")
    _seed_owned_assignment(fake_db)
    _seed_submitter_participant_rows(fake_db)

    home = client.get("/public/review/me").json()
    speakers = home["assignments"][0]["session"]["speakers"]

    assert [s["id"] for s in speakers] == ["contact-priya"]
    # both roles survive on the single entry
    assert sorted(speakers[0]["roles"]) == ["speaker", "submitter"]
    assert speakers[0]["is_primary"] is True

    detail = client.get("/public/review/submissions/assignment-owned").json()
    assert [s["id"] for s in detail["session"]["speakers"]] == ["contact-priya"]


def test_reviewer_home_reports_an_open_plan_as_open(evaluation_client):
    """An open plan inside a valid window is OPEN — the judge's contradiction."""
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(
        fake_db,
        status="open",
        opens_at="2026-08-01T00:00:00+00:00",
        closes_at="2026-12-31T23:59:59+00:00",
    )
    _seed_owned_assignment(fake_db)

    plan = client.get("/public/review/me").json()["plan"]

    assert plan["review_open"] is True
    assert plan["closed_reason"] is None
    assert plan["opens_at"] == "2026-08-01T00:00:00+00:00"


def test_reviewer_home_says_why_a_draft_round_is_closed(evaluation_client):
    """A link from a plan the organizer hasn't opened explains itself."""
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="draft")
    _seed_owned_assignment(fake_db)

    plan = client.get("/public/review/me").json()["plan"]

    assert plan["review_open"] is False
    assert "hasn't opened yet" in plan["closed_reason"]


def test_reviewer_home_closed_state_matches_what_saving_enforces(evaluation_client):
    """An open plan past its window reads closed instead of 403-ing on save."""
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db, status="open", closes_at="2020-01-01T00:00:00+00:00")
    _seed_owned_assignment(fake_db)

    plan = client.get("/public/review/me").json()["plan"]

    assert plan["review_open"] is False
    assert "closed" in plan["closed_reason"]
    # ...and the write agrees, which is the whole point of one verdict.
    assert client.put(
        "/public/review/submissions/assignment-owned", json=SCORE_PAYLOAD
    ).status_code == 403
