"""Evaluation plans, reviewer scoring, and strict assignment ownership."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth import get_current_user_and_org
from deps.portal_deps import get_reviewer
from routes.evaluation_routes import router as evaluation_router
from routes.review_routes import router as review_router
from services.evaluations import weighted_overall
from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

PLAN_ID = "plan-1"
OWNER_ID = "evaluator-owner"
OTHER_EVALUATOR_ID = "evaluator-other"
TRACK_A = "track-platform"
TRACK_B = "track-ai"


def _seed_plan(fake_db, *, status: str = "draft", anonymized: bool = False) -> None:
    fake_db.seed(
        "evaluation_plans",
        {
            "id": PLAN_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Program committee",
            "instructions": "Judge the proposal, not the fame.",
            "anonymized": anonymized,
            "scale": "1_5",
            "criteria": [
                {"name": "Relevance", "weight": 40},
                {"name": "Originality", "weight": 30},
                {"name": "Speaker", "weight": 20},
                {"name": "Clarity", "weight": 10},
            ],
            "status": status,
            "session_filter": {},
        },
    )


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
