"""Cookie-backed dependencies for portal and reviewer feature routes."""

from __future__ import annotations

from fastapi import HTTPException, Request

from routes.portal_session_routes import COOKIE_NAME
from services.magic_links import read_session

INVALID_SESSION_DETAIL = "Your portal session is invalid or has expired."


def _claims(request: Request, purpose: str, subject_claim: str) -> tuple[str, str]:
    claims = read_session(request.cookies.get(COOKIE_NAME, ""))
    if not claims or claims.get("purpose") != purpose:
        raise HTTPException(status_code=401, detail=INVALID_SESSION_DETAIL)

    org_id = claims.get("org_id")
    subject_id = claims.get(subject_claim)
    if not isinstance(org_id, str) or not org_id:
        raise HTTPException(status_code=401, detail=INVALID_SESSION_DETAIL)
    if not isinstance(subject_id, str) or not subject_id:
        raise HTTPException(status_code=401, detail=INVALID_SESSION_DETAIL)
    return org_id, subject_id


async def get_portal_contact(request: Request) -> tuple[str, str]:
    """Require a speaker portal cookie and return ``(org_id, contact_id)``."""
    return _claims(request, "portal", "contact_id")


async def get_reviewer(request: Request) -> tuple[str, str]:
    """Require a reviewer cookie and return ``(org_id, evaluator_id)``."""
    return _claims(request, "review", "evaluator_id")
