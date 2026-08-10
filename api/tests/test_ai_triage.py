"""AI first-pass triage, subset assignment, and later-round eligibility.

Three things a program chair could not do before:

  ABS-14 — get a ranked first pass over the whole CFP (one model call, or a
           clearly-labelled score heuristic when no key is configured), and
           override a machine score so the correction sticks.
  ABS-06 — assign a CHOSEN SUBSET of submissions, and take several assignments
           back off in one stroke instead of one X at a time.
  ABS-05 — put accepted/declined work in front of a LATER round, without that
           ever leaking into round one.

The model is never called here: `_call_anthropic` is replaced in every test,
and the autouse fixture below makes a real network call fail loudly rather
than quietly bill somebody.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth import get_current_user_and_org
from deps.portal_deps import get_reviewer
from routes.evaluation_routes import router as evaluation_router
from routes.review_routes import router as review_router
from services import ai_triage
from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID
from tests.test_evaluations import OWNER_ID, PLAN_ID, _seed_pair, _seed_plan


@pytest.fixture
def evaluation_client(seeded_db, monkeypatch):
    """The organizer-authenticated evaluation surface over an in-memory store."""
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


@pytest.fixture(autouse=True)
def _never_call_the_real_model(monkeypatch):
    """No key, and a tripwire on the call path. Tests opt in explicitly."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")

    async def _explode(*_args, **_kwargs):
        raise AssertionError("a test reached the real Anthropic client")

    monkeypatch.setattr(ai_triage, "_call_anthropic", _explode)
    yield


def _use_model(monkeypatch, handler):
    """Point triage at a stub model and give it a key to find."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-real-key")
    monkeypatch.setattr(ai_triage, "_call_anthropic", handler)


def _seed_scored_review(fake_db, *, session_id: str, evaluator_id: str, score: float) -> None:
    assignment_id = f"assignment-{session_id}-{evaluator_id}"
    fake_db.seed(
        "assignments",
        {
            "id": assignment_id,
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": evaluator_id,
            "session_id": session_id,
        },
    )
    fake_db.seed(
        "reviews",
        {
            "id": f"review-{assignment_id}",
            "org_id": TEST_ORG_ID,
            "assignment_id": assignment_id,
            "scores": {"Relevance": score, "Originality": score, "Speaker": score,
                       "Clarity": score},
            "is_draft": False,
            "abstained": False,
        },
    )


def _seed_abstracts(fake_db) -> None:
    for session_id, description in (
        ("session-a", "Incremental builds at monorepo scale, and why CI takes 40 minutes."),
        ("session-b", "Verification patterns for AI pair programmers."),
    ):
        for row in fake_db.rows("sessions"):
            if row["id"] == session_id:
                row["description"] = description


# ── ABS-14: the triage run ─────────────────────────────────────────────────


def test_triage_degrades_to_a_labelled_heuristic_without_a_key(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    _seed_abstracts(fake_db)
    _seed_scored_review(fake_db, session_id="session-a", evaluator_id=OWNER_ID, score=5)
    _seed_scored_review(fake_db, session_id="session-b", evaluator_id=OWNER_ID, score=2)

    response = client.post(f"/api/plans/{PLAN_ID}/ai-triage")

    assert response.status_code == 200
    triage = response.json()["triage"]
    # The button answers even with nothing configured — and says what it is.
    assert triage["source"] == "heuristic"
    assert triage["model"] is None
    ordered = [(item["title"], item["suggestion"], item["score"]) for item in triage["items"]]
    assert ordered == [("A talk", "advance", 5.0), ("B talk", "decline", 2.0)]
    assert "committee's own numbers" in triage["items"][0]["rationale"]


def test_triage_sends_every_submission_in_one_call_and_stores_the_result(
    evaluation_client, monkeypatch
):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    _seed_abstracts(fake_db)
    calls: list[dict] = []

    async def _stub(system, prompt, *, key):
        calls.append({"system": system, "prompt": prompt, "key": key})
        return {
            "items": [
                {
                    "session_id": "session-b",
                    "summary": "Verification patterns for AI-written code.",
                    "score": 4.5,
                    "suggestion": "advance",
                    "rationale": "Concrete verification patterns; strong AI Engineering fit.",
                },
                {
                    "session_id": "session-a",
                    "summary": "Cutting a 40-minute monorepo CI pipeline.",
                    "score": 3,
                    "suggestion": "discuss",
                    "rationale": "Useful build-tooling material, but a crowded topic.",
                },
            ]
        }

    _use_model(monkeypatch, _stub)
    response = client.post(f"/api/plans/{PLAN_ID}/ai-triage")

    assert response.status_code == 200
    # ONE call for the whole CFP — the cost of a click must not scale per talk.
    assert len(calls) == 1
    assert "session-a" in calls[0]["prompt"] and "session-b" in calls[0]["prompt"]
    assert "monorepo scale" in calls[0]["prompt"]

    triage = response.json()["triage"]
    assert triage["source"] == "anthropic"
    assert triage["model"] == ai_triage.MODEL
    # Ranked best-first regardless of the order the model answered in.
    assert [item["session_id"] for item in triage["items"]] == ["session-b", "session-a"]
    assert triage["items"][0]["rationale"].startswith("Concrete verification")
    # Titles come from our rows, never from the model.
    assert triage["items"][0]["title"] == "B talk"

    plan = next(row for row in fake_db.rows("evaluation_plans") if row["id"] == PLAN_ID)
    assert plan["ai_triage"]["items"][0]["session_id"] == "session-b"


def test_triage_falls_back_when_the_model_call_fails(evaluation_client, monkeypatch):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("upstream is having a day")

    _use_model(monkeypatch, _boom)
    response = client.post(f"/api/plans/{PLAN_ID}/ai-triage")

    # A triage button that 500s is worse than one that admits it fell back.
    assert response.status_code == 200
    triage = response.json()["triage"]
    assert triage["source"] == "heuristic"
    assert triage["degraded"] is True


def test_triage_clamps_scores_and_repairs_a_bad_suggestion(evaluation_client, monkeypatch):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)

    async def _stub(_system, _prompt, *, key):
        return {
            "items": [
                {
                    "session_id": "session-a",
                    "summary": "s",
                    "score": 97,
                    "suggestion": "ACCEPT NOW",
                    "rationale": "r",
                },
                # session-b omitted entirely by the model
            ]
        }

    _use_model(monkeypatch, _stub)
    items = client.post(f"/api/plans/{PLAN_ID}/ai-triage").json()["triage"]["items"]

    by_id = {item["session_id"]: item for item in items}
    # 97 on a 1–5 plan is nonsense; clamp rather than surface it.
    assert by_id["session-a"]["score"] == 5.0
    assert by_id["session-a"]["suggestion"] == "advance"
    # A submission the model skipped still gets a row, not a silent gap.
    assert "session-b" in by_id
    assert by_id["session-b"]["session_id"] == "session-b"


def test_triage_with_no_submissions_is_a_readable_400(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)

    response = client.post(f"/api/plans/{PLAN_ID}/ai-triage")

    assert response.status_code == 400
    assert "no submissions" in response.json()["detail"]


def test_triage_is_org_scoped(evaluation_client):
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

    assert client.post("/api/plans/foreign-plan/ai-triage").status_code == 404
    assert client.get("/api/plans/foreign-plan/ai-triage").status_code == 404


def test_reading_triage_never_calls_the_model(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    client.post(f"/api/plans/{PLAN_ID}/ai-triage")

    # The autouse tripwire would fire if this reached the model path.
    stored = client.get(f"/api/plans/{PLAN_ID}/ai-triage")

    assert stored.status_code == 200
    assert stored.json()["triage"]["source"] == "heuristic"
    assert len(stored.json()["triage"]["items"]) == 2


def test_a_human_override_persists_and_survives_a_rerun(evaluation_client, monkeypatch):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    client.post(f"/api/plans/{PLAN_ID}/ai-triage")

    overridden = client.patch(
        f"/api/plans/{PLAN_ID}/ai-triage/session-a", json={"score": 4.5}
    )
    assert overridden.status_code == 200
    by_id = {item["session_id"]: item for item in overridden.json()["triage"]["items"]}
    assert by_id["session-a"]["override_score"] == 4.5
    assert by_id["session-b"]["override_score"] is None

    # Re-running the whole triage must not discard the chair's correction.
    async def _stub(_system, _prompt, *, key):
        return {
            "items": [
                {"session_id": "session-a", "summary": "s", "score": 2,
                 "suggestion": "decline", "rationale": "r"},
                {"session_id": "session-b", "summary": "s", "score": 2,
                 "suggestion": "decline", "rationale": "r"},
            ]
        }

    _use_model(monkeypatch, _stub)
    rerun = {
        item["session_id"]: item
        for item in client.post(f"/api/plans/{PLAN_ID}/ai-triage").json()["triage"]["items"]
    }
    assert rerun["session-a"]["score"] == 2.0
    assert rerun["session-a"]["override_score"] == 4.5

    # And it is still there on a plain read (i.e. it round-tripped through storage).
    stored = client.get(f"/api/plans/{PLAN_ID}/ai-triage").json()["triage"]
    assert {
        item["session_id"]: item["override_score"] for item in stored["items"]
    } == {"session-a": 4.5, "session-b": None}


def test_an_override_outside_the_plans_scale_is_rejected(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    client.post(f"/api/plans/{PLAN_ID}/ai-triage")

    too_high = client.patch(f"/api/plans/{PLAN_ID}/ai-triage/session-a", json={"score": 9})
    assert too_high.status_code == 400
    assert "between 1 and 5" in too_high.json()["detail"]

    unknown = client.patch(f"/api/plans/{PLAN_ID}/ai-triage/session-zzz", json={"score": 3})
    assert unknown.status_code == 404


# ── ABS-05: decided submissions can join a later round ─────────────────────


def _seed_decided(fake_db) -> None:
    fake_db.seed(
        "sessions",
        {
            "id": "session-accepted",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Already accepted",
            "friendly_id": "SESS-9",
            "status": "accepted",
        },
        {
            "id": "session-declined",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Already declined",
            "friendly_id": "SESS-10",
            "status": "declined",
        },
    )


def test_the_board_hides_decided_work_by_default_and_shows_it_on_request(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    _seed_decided(fake_db)

    default = client.get(f"/api/plans/{PLAN_ID}/assignments").json()
    assert [row["title"] for row in default["sessions"]] == ["A talk", "B talk"]
    assert default["include_decided"] is False

    widened = client.get(f"/api/plans/{PLAN_ID}/assignments?include_decided=true").json()
    assert [row["title"] for row in widened["sessions"]] == [
        "A talk",
        "Already accepted",
        "Already declined",
        "B talk",
    ]
    assert widened["include_decided"] is True


def test_bulk_assign_reaches_decided_work_only_when_asked(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    _seed_decided(fake_db)

    narrow = client.post(
        f"/api/evaluation-plans/{PLAN_ID}/assign",
        json={"mode": "all_to_all", "evaluator_ids": [OWNER_ID]},
    ).json()
    assert narrow["session_count"] == 2

    fake_db.store["assignments"] = []
    wide = client.post(
        f"/api/evaluation-plans/{PLAN_ID}/assign",
        json={"mode": "all_to_all", "evaluator_ids": [OWNER_ID], "include_decided": True},
    ).json()
    assert wide["session_count"] == 4
    assigned = {row["session_id"] for row in fake_db.rows("assignments")}
    assert "session-accepted" in assigned and "session-declined" in assigned


def test_triage_covers_decided_work_only_when_asked(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    _seed_decided(fake_db)

    narrow = client.post(f"/api/plans/{PLAN_ID}/ai-triage").json()["triage"]
    assert len(narrow["items"]) == 2

    wide = client.post(
        f"/api/plans/{PLAN_ID}/ai-triage", json={"include_decided": True}
    ).json()["triage"]
    assert len(wide["items"]) == 4


# ── ABS-06: assign a subset, and take assignments back in bulk ─────────────


def test_assigning_a_chosen_subset_leaves_the_rest_alone(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)

    result = client.post(
        f"/api/evaluation-plans/{PLAN_ID}/assign",
        json={
            "mode": "all_to_all",
            "evaluator_ids": [OWNER_ID],
            "session_ids": ["session-a"],
        },
    ).json()

    assert result["created"] == 1
    assert [row["session_id"] for row in fake_db.rows("assignments")] == ["session-a"]


def test_bulk_unassign_removes_several_pairings_at_once(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    client.post(
        f"/api/evaluation-plans/{PLAN_ID}/assign", json={"mode": "all_to_all"}
    )
    assignments = fake_db.rows("assignments")
    assert len(assignments) == 4
    doomed = [row["id"] for row in assignments[:3]]

    removed = client.post(
        f"/api/plans/{PLAN_ID}/unassign", json={"assignment_ids": doomed}
    )

    assert removed.status_code == 200
    assert removed.json()["removed"] == 3
    assert len(fake_db.rows("assignments")) == 1


def test_bulk_unassign_refuses_a_foreign_id_without_deleting_anything(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)
    _seed_pair(fake_db)
    fake_db.seed(
        "assignments",
        {
            "id": "assignment-mine",
            "org_id": TEST_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": OWNER_ID,
            "session_id": "session-a",
        },
        {
            "id": "assignment-theirs",
            "org_id": OTHER_ORG_ID,
            "plan_id": PLAN_ID,
            "evaluator_id": "evaluator-foreign",
            "session_id": "session-foreign",
        },
    )

    response = client.post(
        f"/api/plans/{PLAN_ID}/unassign",
        json={"assignment_ids": ["assignment-mine", "assignment-theirs"]},
    )

    assert response.status_code == 404
    # All-or-nothing: the caller's own row survives a request naming a foreign one.
    assert {row["id"] for row in fake_db.rows("assignments")} == {
        "assignment-mine",
        "assignment-theirs",
    }


def test_bulk_unassign_needs_at_least_one_id(evaluation_client):
    client, fake_db, _reviewer = evaluation_client
    _seed_plan(fake_db)

    assert (
        client.post(f"/api/plans/{PLAN_ID}/unassign", json={"assignment_ids": []}).status_code
        == 422
    )


# ── the prompt itself ──────────────────────────────────────────────────────


def test_the_prompt_carries_scores_and_clips_a_runaway_abstract():
    prompt = ai_triage.build_user_prompt(
        [
            {
                "session_id": "s1",
                "title": "Taming 40-Minute CI",
                "abstract": "x" * 5_000,
                "avg_score": 3.33,
                "review_count": 2,
                "track": "Platform & Infra",
            }
        ],
        top=5,
        criteria=["Originality", "Relevance"],
    )

    assert "Rate every submission on a 1-5 scale" in prompt
    assert "Originality, Relevance" in prompt
    assert "3.33 average from 2 completed review(s)" in prompt
    # One runaway abstract must not blow up the cost of the whole run.
    assert len(prompt) < 3_000
    assert prompt.rstrip().endswith("…")


def test_the_prompt_says_plainly_when_nobody_has_reviewed_yet():
    prompt = ai_triage.build_user_prompt(
        [{"session_id": "s1", "title": "T", "abstract": "a", "avg_score": None,
          "review_count": 0}],
        top=10,
        criteria=[],
    )

    assert "reviewer scores so far: none yet" in prompt
    assert "1-10 scale" in prompt
