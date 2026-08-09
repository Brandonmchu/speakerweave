"""Organizer-authenticated evaluation plan and summary endpoints."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from auth import get_current_user_and_org
from services import evaluations

router = APIRouter(prefix="/api", tags=["evaluation"])


class CriterionInput(BaseModel):
    """One row of a scorecard.

    `kind` omitted means 'scale' — the weighted 1–N rating that is the only
    thing a criterion could be before ABS-03 — so every existing client and
    every stored plan keeps working untouched. 'select' collects one of
    `options`; 'text' collects a paragraph. Only scale criteria are weighted,
    which is why `weight` is optional here: a missing weight on a scale
    criterion is still rejected (400) by `normalize_criteria`.
    """

    name: str = Field(..., min_length=1, max_length=100)
    weight: float | None = Field(default=None, ge=0, le=100)
    kind: Literal["scale", "select", "text"] | None = None
    options: list[str] | None = Field(default=None, max_length=50)


class PlanCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    instructions: str | None = Field(default=None, max_length=20_000)
    scale: Literal["1_5", "1_10"] = "1_5"
    anonymized: bool = False
    criteria: list[CriterionInput] | None = None
    # Review window (migration 008). A bare date ("2026-10-01") or a full
    # instant; null/omitted = no bound.
    opens_at: str | None = Field(default=None, max_length=64)
    closes_at: str | None = Field(default=None, max_length=64)

    @field_validator("name")
    @classmethod
    def name_cannot_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Name cannot be blank")
        return value


class PlanPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    instructions: str | None = Field(default=None, max_length=20_000)
    criteria: list[CriterionInput] | None = None
    anonymized: bool | None = None
    status: Literal["draft", "open", "closed"] | None = None
    # Sent explicitly as null to clear a bound; omitted to leave it alone.
    opens_at: str | None = Field(default=None, max_length=64)
    closes_at: str | None = Field(default=None, max_length=64)

    @field_validator("name")
    @classmethod
    def name_cannot_be_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Name cannot be blank")
        return value


class EvaluatorCreateRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    name: str = Field(default="", max_length=200)
    # Tracks this reviewer covers. Omitted/empty = every track.
    track_ids: list[str] | None = Field(default=None, max_length=100)

    @field_validator("email")
    @classmethod
    def looks_like_email(cls, value: str) -> str:
        value = value.strip()
        if "@" not in value or value.startswith("@") or value.endswith("@"):
            raise ValueError("Enter a valid email address")
        return value


class EvaluatorPatchRequest(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    track_ids: list[str] | None = Field(default=None, max_length=100)


class AssignRequest(BaseModel):
    session_ids: list[str] | None = None
    evaluator_ids: list[str] | None = None
    # by_track pairs each reviewer with the sessions whose tracks they cover.
    mode: Literal["all_to_all", "by_track"] = "all_to_all"


class SingleAssignmentRequest(BaseModel):
    """One reviewer, one submission — the deliberate pairing the bulk modes
    can't express."""

    evaluator_id: str = Field(..., min_length=1, max_length=64)
    session_id: str = Field(..., min_length=1, max_length=64)


@router.post("/events/{event_id}/evaluation-plans", status_code=201)
async def create_evaluation_plan(
    event_id: str,
    payload: PlanCreateRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    values = payload.model_dump()
    if values.get("criteria") is not None:
        values["criteria"] = [criterion.model_dump() for criterion in payload.criteria or []]
    return {"plan": await evaluations.create_plan(org_id, event_id, values)}


@router.get("/events/{event_id}/evaluation-plans")
async def list_evaluation_plans(
    event_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    return {"plans": await evaluations.list_plans(org_id, event_id)}


@router.get("/evaluation-plans/{plan_id}")
async def get_evaluation_plan(
    plan_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    return await evaluations.get_plan_detail(org_id, plan_id)


@router.patch("/evaluation-plans/{plan_id}")
async def patch_evaluation_plan(
    plan_id: str,
    payload: PlanPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    patch = payload.model_dump(exclude_unset=True)
    if "criteria" in patch:
        if payload.criteria is None:
            raise HTTPException(status_code=400, detail="Criteria cannot be null")
        patch["criteria"] = [criterion.model_dump() for criterion in payload.criteria]
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    return {"plan": await evaluations.update_plan(org_id, plan_id, patch)}


@router.post("/evaluation-plans/{plan_id}/evaluators", status_code=201)
async def create_evaluator(
    plan_id: str,
    payload: EvaluatorCreateRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    evaluator = await evaluations.add_evaluator(
        org_id, plan_id, payload.email, payload.name, payload.track_ids
    )
    return {"evaluator": evaluator}


@router.patch("/evaluation-plans/{plan_id}/evaluators/{evaluator_id}")
async def patch_evaluator(
    plan_id: str,
    evaluator_id: str,
    payload: EvaluatorPatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Rename a reviewer, or change which tracks they review."""
    _user_id, org_id = auth
    patch = payload.model_dump(exclude_unset=True)
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if patch.get("track_ids") is None and "track_ids" in patch:
        patch["track_ids"] = []
    evaluator = await evaluations.update_evaluator(org_id, plan_id, evaluator_id, patch)
    return {"evaluator": evaluator}


@router.delete("/evaluation-plans/{plan_id}/evaluators/{evaluator_id}", status_code=204)
async def remove_evaluator(
    plan_id: str,
    evaluator_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    await evaluations.delete_evaluator(org_id, plan_id, evaluator_id)
    return Response(status_code=204)


@router.post("/evaluation-plans/{plan_id}/assign")
async def assign_sessions(
    plan_id: str,
    payload: AssignRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    return await evaluations.assign_sessions(
        org_id,
        plan_id,
        mode=payload.mode,
        session_ids=payload.session_ids,
        evaluator_ids=payload.evaluator_ids,
    )


# ── per-submission assignment ──────────────────────────────────────────────
# Registered under both /plans and /evaluation-plans: the rest of this router
# uses the long form, and the short form is the documented public path.


@router.get("/plans/{plan_id}/assignments")
@router.get("/evaluation-plans/{plan_id}/assignments")
async def list_plan_assignments(
    plan_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Every reviewable submission with the reviewers currently on it."""
    _user_id, org_id = auth
    return await evaluations.assignment_board(org_id, plan_id)


@router.post("/plans/{plan_id}/assignments", status_code=201)
@router.post("/evaluation-plans/{plan_id}/assignments", status_code=201)
async def create_plan_assignment(
    plan_id: str,
    payload: SingleAssignmentRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Assign one reviewer to one submission. 409 when the pair already exists."""
    _user_id, org_id = auth
    assignment = await evaluations.create_assignment(
        org_id, plan_id, payload.evaluator_id, payload.session_id
    )
    return {"assignment": assignment}


@router.delete("/plans/{plan_id}/assignments/{assignment_id}", status_code=204)
@router.delete("/evaluation-plans/{plan_id}/assignments/{assignment_id}", status_code=204)
async def delete_plan_assignment(
    plan_id: str,
    assignment_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    await evaluations.delete_assignment(org_id, plan_id, assignment_id)
    return Response(status_code=204)


@router.post("/plans/{plan_id}/remind-laggards")
@router.post("/evaluation-plans/{plan_id}/remind-laggards")
async def remind_lagging_reviewers(
    plan_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Queue a reminder for the reviewers with unfinished work — only them.

    Deduped per reviewer per day, so a second click is a no-op rather than a
    second inbox hit.
    """
    _user_id, org_id = auth
    return await evaluations.remind_laggards(org_id, plan_id)


@router.post("/evaluation-plans/{plan_id}/open")
async def open_evaluation_plan(
    plan_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    return await evaluations.open_plan(org_id, plan_id)


@router.get("/evaluation-plans/{plan_id}/reviewer-links")
async def evaluation_reviewer_links(
    plan_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Fresh review magic links per evaluator, for the admin to copy and share
    directly while reviewer-invite email delivery is still pending."""
    _user_id, org_id = auth
    return await evaluations.reviewer_links(org_id, plan_id)


@router.get("/evaluation-plans/{plan_id}/summary")
async def evaluation_summary(
    plan_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    return await evaluations.get_summary(org_id, plan_id)


@router.get("/sessions/{session_id}/reviews")
async def session_reviews(
    session_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    """Organizer read of every reviewer verdict on one session.

    The same aggregate GET /api/sessions/{id} embeds, exposed on its own so a
    caller that only wants the scores doesn't refetch the whole submission.
    Reviewer identity honours each review's plan `anonymized` flag.
    """
    _user_id, org_id = auth
    return await evaluations.get_session_reviews(org_id, session_id)
