"""Cookie-authenticated reviewer portal endpoints (no organizer JWT)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from deps.portal_deps import get_reviewer
from services import evaluations

router = APIRouter(prefix="/public/review", tags=["review"])


class ReviewPutRequest(BaseModel):
    """A reviewer's scorecard.

    `scores` is keyed by criterion name; the value is a number for a scale
    criterion (as it always was) and a string for a choice or free-text one.
    The plan's own criteria decide which is which — see `_validate_scores`.
    """

    scores: dict[str, Any] = Field(default_factory=dict)
    comment: str | None = Field(default=None, max_length=20_000)
    abstained: bool = False
    abstain_reason: str | None = Field(default=None, max_length=2_000)
    is_draft: bool = True


@router.get("/me")
async def reviewer_me(reviewer: tuple = Depends(get_reviewer)):
    org_id, evaluator_id = reviewer
    return await evaluations.reviewer_home(org_id, evaluator_id)


@router.get("/submissions/{assignment_id}")
async def get_reviewer_submission(
    assignment_id: str,
    reviewer: tuple = Depends(get_reviewer),
):
    org_id, evaluator_id = reviewer
    return await evaluations.reviewer_submission(org_id, evaluator_id, assignment_id)


@router.put("/submissions/{assignment_id}")
async def put_reviewer_submission(
    assignment_id: str,
    payload: ReviewPutRequest,
    reviewer: tuple = Depends(get_reviewer),
):
    org_id, evaluator_id = reviewer
    review = await evaluations.save_review(
        org_id,
        evaluator_id,
        assignment_id,
        payload.model_dump(),
    )
    return {"review": review}
