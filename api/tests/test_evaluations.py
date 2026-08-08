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
