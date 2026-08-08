"""Public exchange endpoints for speaker and reviewer magic links."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from security.rate_limiting import RATE_PUBLIC_WRITE, limiter
from services.magic_links import (
    InvalidMagicLinkError,
    issue_session,
    read_session,
    redeem,
)

router = APIRouter(prefix="/public/session", tags=["public-session"])

COOKIE_NAME = "dais_portal"
SESSION_TTL_HOURS = 72
SESSION_MAX_AGE = SESSION_TTL_HOURS * 60 * 60
INVALID_LINK_DETAIL = (
    "This sign-in link is invalid, expired, or already used. Please request a new link."
)
INVALID_SESSION_DETAIL = "Your portal session is invalid or has expired."


class RedeemRequest(BaseModel):
    token: str


def _portal_context(values: dict) -> dict | None:
    purpose = values.get("purpose")
    org_id = values.get("org_id")
    if not isinstance(org_id, str) or not org_id:
        return None
    if purpose == "portal":
        contact_id = values.get("contact_id")
        if not isinstance(contact_id, str) or not contact_id:
            return None
        return {"purpose": purpose, "org_id": org_id, "contact_id": contact_id}
    if purpose == "review":
        evaluator_id = values.get("evaluator_id")
        if not isinstance(evaluator_id, str) or not evaluator_id:
            return None
        return {"purpose": purpose, "org_id": org_id, "evaluator_id": evaluator_id}
    return None


@router.post("/redeem")
@limiter.limit(RATE_PUBLIC_WRITE)
async def redeem_session(request: Request, payload: RedeemRequest, response: Response):
    try:
        redeemed = await redeem(payload.token)
    except InvalidMagicLinkError as exc:
        raise HTTPException(status_code=400, detail=INVALID_LINK_DETAIL) from exc

    context = _portal_context(redeemed)
    if context is None:
        raise HTTPException(status_code=400, detail=INVALID_LINK_DETAIL)

    response.set_cookie(
        key=COOKIE_NAME,
        value=issue_session(**context, ttl_hours=SESSION_TTL_HOURS),
        max_age=SESSION_MAX_AGE,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return context


@router.get("/me")
async def get_session(request: Request):
    claims = read_session(request.cookies.get(COOKIE_NAME, ""))
    context = _portal_context(claims or {})
    if context is None:
        raise HTTPException(status_code=401, detail=INVALID_SESSION_DETAIL)
    return context


@router.post("/logout", status_code=204)
async def logout_session(response: Response):
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )
