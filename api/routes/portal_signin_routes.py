"""Public cross-org speaker sign-in: request a link, choose a conference.

Unauthenticated, like the rest of `/public`. The credential is the emailed
`portal_choose` token and nothing else: the sign-in POST answers identically
whether or not the address matched, `/choices` refuses to say anything without
a valid token, and `/choose` re-derives the token email's own contacts before
issuing the ordinary `dais_portal` cookie for the one that was picked.

See services/portal_signin.py for why the token spans orgs and why it is a
bearer credential rather than a one-shot.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field

from routes.portal_session_routes import COOKIE_NAME, SESSION_MAX_AGE, SESSION_TTL_HOURS
from security.rate_limiting import RATE_PUBLIC_DEFAULT, RATE_PUBLIC_WRITE, limiter
from services import portal_signin
from services.magic_links import issue_session

router = APIRouter(prefix="/public/portal", tags=["public-portal"])

INVALID_TOKEN_DETAIL = (
    "This sign-in link is invalid or has expired. Please request a new one."
)


class SignInRequest(BaseModel):
    email: EmailStr


class ChooseRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=400)
    contact_id: str = Field(..., min_length=1, max_length=64)


async def _require_choose_email(token: str | None) -> str:
    """Resolve a sign-in token to its verified email, or 401.

    The token is the ONLY thing that authorises the cross-org read behind these
    routes; nothing here ever takes an email from the request.
    """
    try:
        return await portal_signin.validate_choose_token(token or "")
    except portal_signin.InvalidChooseToken as exc:
        raise HTTPException(status_code=401, detail=INVALID_TOKEN_DETAIL) from exc


@router.post("/sign-in", status_code=202)
@limiter.limit(RATE_PUBLIC_WRITE)
async def request_sign_in_link(request: Request, payload: SignInRequest):
    """Email a portal sign-in link IF this address is a contact anywhere.

    ALWAYS returns the same 202 body, whether or not the email matched, so the
    endpoint cannot be used to discover who is speaking where."""
    await portal_signin.issue_sign_in_link(str(payload.email))
    return {"ok": True, "message": portal_signin.SIGN_IN_MESSAGE}


@router.get("/choices")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def list_sign_in_choices(request: Request, token: str = ""):
    """Every conference the token's email appears at, across every org."""
    email = await _require_choose_email(token)
    return {"email": email, "choices": await portal_signin.list_choices(email)}


@router.post("/choose", status_code=204)
@limiter.limit(RATE_PUBLIC_WRITE)
async def choose_portal(request: Request, payload: ChooseRequest, response: Response):
    """Exchange a sign-in token + one of its own contacts for a portal session."""
    email = await _require_choose_email(payload.token)
    choice = await portal_signin.resolve_choice(email, payload.contact_id)
    if choice is None:
        # A contact id that is not this email's own is treated exactly like a
        # bad token: same 401, no hint that the id exists somewhere else.
        raise HTTPException(status_code=401, detail=INVALID_TOKEN_DETAIL)

    response.set_cookie(
        key=COOKIE_NAME,
        value=issue_session(
            "portal",
            choice["org_id"],
            contact_id=choice["contact_id"],
            ttl_hours=SESSION_TTL_HOURS,
        ),
        max_age=SESSION_MAX_AGE,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )
