"""The organizer's read of reviewer scores — closing the review roundtrip.

Reviewers score a submission on a plan's weighted scorecard; these tests cover
the aggregate that finally surfaces those scores and comments back to the
organizer on GET /api/sessions/{id} (and its dedicated /reviews endpoint),
including that the plan's `anonymized` flag hides reviewer identity and that
one org can never read another's verdicts.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

PLAN_ID = "plan-1"
SESSION_ID = "99999999-9999-9999-9999-9999999999a1"
FOREIGN_SESSION_ID = "99999999-9999-9999-9999-9999999999ff"


@pytest.fixture
def reviews_db(seeded_db):
    seeded_db.seed(
        "evaluation_plans",
        {
            "id": PLAN_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "name": "Program committee",
            "anonymized": False,
            "scale": "1_5",
            "criteria": [
                {"name": "Relevance", "weight": 40},
                {"name": "Originality", "weight": 30},
                {"name": "Speaker", "weight": 20},
                {"name": "Clarity", "weight": 10},
            ],
            "status": "open",
            "session_filter": {},
        },
    )
    seeded_db.seed(
        "sessions",
        {
            "id": SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Analytical Engines",
            "status": "pending",
        },
        {
            "id": FOREIGN_SESSION_ID,
            "org_id": OTHER_ORG_ID,
            "event_id": OTHER_EVENT_ID,
            "title": "A private proposal",
            "status": "pending",
        },
    )
    seeded_db.seed(
        "evaluators",
        {"id": "eval-ada", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "email": "ada@test.dev", "name": "Ada Lovelace"},
        {"id": "eval-grace", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "email": "grace@test.dev", "name": "Grace Hopper"},
        {"id": "eval-kat", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "email": "kat@test.dev", "name": "Katherine J"},
    )
    seeded_db.seed(
        "assignments",
        {"id": "asg-ada", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "eval-ada", "session_id": SESSION_ID},
        {"id": "asg-grace", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "eval-grace", "session_id": SESSION_ID},
        {"id": "asg-kat", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "eval-kat", "session_id": SESSION_ID},
    )
    seeded_db.seed(
        "reviews",
        {
            "id": "rev-ada",
            "org_id": TEST_ORG_ID,
            "assignment_id": "asg-ada",
            "scores": {"Relevance": 5, "Originality": 4, "Speaker": 3, "Clarity": 2},
            "overall": 4.0,
            "comment": "Strong and timely.",
            "abstained": False,
            "is_draft": False,
            "submitted_at": "2026-01-01T00:00:00+00:00",
        },
        {
            "id": "rev-grace",
            "org_id": TEST_ORG_ID,
            "assignment_id": "asg-grace",
            "scores": {"Relevance": 3, "Originality": 2, "Speaker": 3, "Clarity": 4},
            "overall": 3.0,
            "comment": "Solid but derivative.",
            "abstained": False,
            "is_draft": False,
            "submitted_at": "2026-01-02T00:00:00+00:00",
        },
        # A draft is a reviewer's private scratch pad — never surfaced.
        {
            "id": "rev-kat-draft",
            "org_id": TEST_ORG_ID,
            "assignment_id": "asg-kat",
            "scores": {"Relevance": 1},
            "overall": None,
            "comment": "still thinking",
            "abstained": False,
            "is_draft": True,
        },
    )
    return seeded_db


def test_detail_carries_the_review_aggregate(client, auth_headers, reviews_db):
    body = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()

    aggregate = body["reviews"]
    # Two completed reviews (the draft does not count), averaged.
    assert aggregate["review_count"] == 2
    assert aggregate["avg_overall"] == 3.5
    assert aggregate["any_abstained"] is False
    assert aggregate["abstained_count"] == 0
    assert aggregate["scale"] == "1_5"

    by_name = {item["name"]: item for item in aggregate["criteria"]}
    assert by_name["Relevance"]["average"] == 4.0  # (5 + 3) / 2
    assert by_name["Clarity"]["average"] == 3.0  # (2 + 4) / 2

    verdicts = {row["reviewer"]: row for row in aggregate["reviews"]}
    assert set(verdicts) == {"Ada Lovelace", "Grace Hopper"}
    assert verdicts["Ada Lovelace"]["overall"] == 4.0
    assert verdicts["Ada Lovelace"]["comment"] == "Strong and timely."
    assert all(row["anonymized"] is False for row in aggregate["reviews"])
    # The draft reviewer never appears.
    assert "Katherine J" not in verdicts


def test_dedicated_reviews_endpoint_matches(client, auth_headers, reviews_db):
    detail = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()["reviews"]
    dedicated = client.get(f"/api/sessions/{SESSION_ID}/reviews", headers=auth_headers)

    assert dedicated.status_code == 200
    assert dedicated.json() == detail


def test_anonymized_plan_hides_reviewer_identity(client, auth_headers, reviews_db):
    reviews_db.rows("evaluation_plans")[0]["anonymized"] = True

    aggregate = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()["reviews"]

    labels = {row["reviewer"] for row in aggregate["reviews"]}
    assert labels == {"Reviewer 1", "Reviewer 2"}
    # The scores still come through — only the identity is withheld.
    assert aggregate["avg_overall"] == 3.5
    blob = str(aggregate)
    assert "Ada Lovelace" not in blob
    assert "ada@test.dev" not in blob


def test_abstention_is_reported_but_excluded_from_the_average(client, auth_headers, reviews_db):
    reviews_db.seed(
        "assignments",
        {"id": "asg-abs", "org_id": TEST_ORG_ID, "plan_id": PLAN_ID, "evaluator_id": "eval-kat", "session_id": SESSION_ID},
    )
    reviews_db.seed(
        "reviews",
        {
            "id": "rev-abs",
            "org_id": TEST_ORG_ID,
            "assignment_id": "asg-abs",
            "scores": {},
            "overall": None,
            "comment": None,
            "abstained": True,
            "abstain_reason": "Conflict of interest",
            "is_draft": False,
            "submitted_at": "2026-01-03T00:00:00+00:00",
        },
    )

    aggregate = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()["reviews"]

    assert aggregate["any_abstained"] is True
    assert aggregate["abstained_count"] == 1
    # Three completed reviews, but the abstention leaves the average on the two scores.
    assert aggregate["review_count"] == 3
    assert aggregate["avg_overall"] == 3.5
    abstained = next(row for row in aggregate["reviews"] if row["abstained"])
    assert abstained["overall"] is None
    assert abstained["abstain_reason"] == "Conflict of interest"


def test_reviews_are_org_scoped(client, auth_headers, reviews_db):
    # A foreign session 404s outright (fetch_scoped guards the detail route).
    denied = client.get(f"/api/sessions/{FOREIGN_SESSION_ID}", headers=auth_headers)
    assert denied.status_code == 404
    assert client.get(f"/api/sessions/{FOREIGN_SESSION_ID}/reviews", headers=auth_headers).status_code == 404


def test_a_session_with_no_reviews_reports_an_empty_aggregate(client, auth_headers, seeded_db):
    seeded_db.seed(
        "sessions",
        {
            "id": "session-lonely",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Nobody reviewed me",
            "status": "pending",
        },
    )

    aggregate = client.get("/api/sessions/session-lonely", headers=auth_headers).json()["reviews"]

    assert aggregate["review_count"] == 0
    assert aggregate["avg_overall"] is None
    assert aggregate["reviews"] == []


def test_list_submissions_carries_the_average_review_score(client, auth_headers, reviews_db):
    body = client.get(f"/api/events/{TEST_EVENT_ID}/submissions", headers=auth_headers).json()

    row = next(item for item in body["submissions"] if item["id"] == SESSION_ID)
    assert row["review_score"] == 3.5
    assert row["review_count"] == 2
