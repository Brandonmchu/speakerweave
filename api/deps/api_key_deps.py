"""API-key dependency for the public ``/v1`` API.

Mirrors Other Conference/CFP Software's contract: the key travels in the ``x-access-token``
header (NOT ``Authorization: Bearer``, which is the organizer JWT surface). A
missing or unrecognised key is a flat 401 — never a 403, which would leak that
the key format was accepted but the org was wrong.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from services.api_keys import resolve_api_key

# Other Conference/CFP Software names this header exactly; we match it so their SDKs/snippets work.
API_KEY_HEADER = "x-access-token"

_UNAUTHORIZED = "Missing or invalid API key. Pass your key in the x-access-token header."


async def get_api_org(request: Request) -> tuple[str, list[str]]:
    """FastAPI dependency → ``(org_id, scopes)``. Raises 401 otherwise.

    Usage::

        @router.get("/v1/events")
        async def list_events(auth: tuple = Depends(get_api_org)):
            org_id, scopes = auth
    """
    raw = (request.headers.get(API_KEY_HEADER) or "").strip()
    if not raw:
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED)

    resolved = await resolve_api_key(raw)
    if not resolved:
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED)

    return resolved
