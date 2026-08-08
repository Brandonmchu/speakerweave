"""Public .ics download.

No auth by design: the UID (dais-{session_uuid}-{contact_uuid}@dais.events)
carries two unguessable v4 UUIDs, and the payload is the speaker's own session
time — the same information the public agenda page shows. That buys a link that
works from any email client, on any device, with no login.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, Response

from security.rate_limiting import RATE_PUBLIC_DEFAULT, limiter
from services.invites import (
    InviteTargetNotFound,
    SessionNotScheduled,
    build_ics_for_uid,
)

router = APIRouter(prefix="/public", tags=["public"])
logger = logging.getLogger(__name__)


@router.get("/invites/{uid}.ics")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def download_invite(request: Request, uid: str):
    """Current invite for a ledger UID, regenerated from live session data."""
    try:
        ics = await build_ics_for_uid(uid)
    except InviteTargetNotFound:
        raise HTTPException(status_code=404, detail="Invite not found") from None
    except SessionNotScheduled as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None

    return Response(
        content=ics,
        media_type="text/calendar",
        headers={"Content-Disposition": 'attachment; filename="invite.ics"'},
    )
