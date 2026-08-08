"""In-process rate limiting via slowapi, applied to the public surface.

IMPORTANT: this is per-worker, not per-replica. With WORKERS=4 the effective
rate per IP is 4x the configured value, so limits are tuned TARGET / WORKERS.
Good enough to stop casual abuse of the unauthenticated CFP endpoints; not a
defense against a distributed adversary.
"""

from __future__ import annotations

import logging
import os

from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger("rate_limiting")

DEFAULT_WORKERS = int(os.getenv("WORKERS", os.getenv("WEB_CONCURRENCY", "1")))

# user-target -> per-worker setting
RATE_PUBLIC_DEFAULT = f"{max(1, 60 // DEFAULT_WORKERS)}/minute"  # target ~60/min/IP
RATE_PUBLIC_WRITE = f"{max(1, 10 // DEFAULT_WORKERS)}/minute"  # target ~10/min/IP


def _key_for_request(request: Request) -> str:
    """Limit by client IP.

    Behind Railway's edge proxy `request.client.host` is the proxy, which
    defeats per-client accrual. Prefer the first X-Forwarded-For entry (the
    original client) and fall back to the peer address for local/direct hits.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return get_remote_address(request)


limiter = Limiter(
    key_func=_key_for_request,
    default_limits=[],  # decorators only — nothing app-wide
    headers_enabled=False,
    enabled=os.getenv("RATE_LIMIT_ENABLED", "true").lower() != "false",
)


async def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    logger.info("rate_limit_hit route=%s identity=%s", request.url.path, _key_for_request(request))
    return JSONResponse(
        status_code=429,
        content={
            "error": "rate_limit_exceeded",
            "detail": str(getattr(exc, "detail", "Rate limit exceeded")),
            "retry_after_seconds": 60,
        },
        headers={"Retry-After": "60"},
    )
