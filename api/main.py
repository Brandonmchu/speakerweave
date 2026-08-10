import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded

from app.core.logging_config import get_logger, setup_logging
from app.core.security import SecurityHeadersMiddleware
from app.core.settings import settings
from routes.admin_routes import router as admin_router
from routes.api_key_admin_routes import router as api_key_admin_router
from routes.comms_routes import router as comms_router
from routes.crm_routes import router as crm_router
from routes.dashboard_routes import router as dashboard_router
from routes.demo_routes import router as demo_router
from routes.evaluation_routes import router as evaluation_router
from routes.field_routes import router as field_router
from routes.form_admin_routes import router as form_admin_router
from routes.health_routes import router as health_router
from routes.ics_routes import router as ics_router
from routes.portal_admin_routes import router as portal_admin_router
from routes.portal_routes import router as portal_router
from routes.portal_session_routes import router as portal_session_router
from routes.program_routes import router as program_router
from routes.public_routes import router as public_router
from routes.review_routes import router as review_router
from routes.schedule_routes import router as schedule_router
from routes.taxonomy_routes import router as taxonomy_router
from routes.v1_routes import router as v1_router
from security.rate_limiting import limiter, rate_limit_exceeded_handler
from services import outbox_worker

setup_logging(default_level=settings.log_level)
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the email_outbox drain loop where enabled (prod), stop it on
    shutdown. Off by default so the test suite runs without a background task."""
    task = None
    if outbox_worker.is_enabled():
        task = asyncio.create_task(outbox_worker.run_forever())
        logger.info("outbox worker enabled")
    else:
        logger.info("outbox worker disabled (set OUTBOX_WORKER_ENABLED=1 to enable)")
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


app = FastAPI(
    title="dais api",
    description="Conference speaker management",
    version="0.1.0",
    lifespan=lifespan,
)

# Rate limiting (in-process, per worker; see security/rate_limiting.py)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

# Middleware: last added is outermost, so CORS wraps SecurityHeaders and
# preflights get their CORS headers before anything else runs.
app.add_middleware(SecurityHeadersMiddleware)

_CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
# Explicit, not wildcard. Any NEW browser-sent custom header must be added
# here in the same change, or the whole preflight 400s — not just that header.
_CORS_ALLOW_HEADERS = ["Authorization", "Content-Type"]

logger.info("CORS allowed origins: %s", settings.cors_allowed_origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_credentials=True,
    allow_methods=_CORS_ALLOW_METHODS,
    allow_headers=_CORS_ALLOW_HEADERS,
    expose_headers=["retry-after"],
)

app.include_router(health_router)
app.include_router(public_router)
app.include_router(demo_router)
app.include_router(program_router)
app.include_router(portal_session_router)
app.include_router(ics_router)
app.include_router(admin_router)
app.include_router(taxonomy_router)
app.include_router(form_admin_router)
app.include_router(field_router)
app.include_router(schedule_router)
app.include_router(dashboard_router)
app.include_router(evaluation_router)
app.include_router(review_router)
app.include_router(portal_router)
app.include_router(portal_admin_router)
app.include_router(comms_router)
app.include_router(crm_router)
app.include_router(v1_router)
app.include_router(api_key_admin_router)


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    environment = os.getenv("ENVIRONMENT", "development")
    reload = environment == "development"
    workers = 1 if reload else int(os.getenv("WORKERS", os.getenv("WEB_CONCURRENCY", "2")))

    logger.info("Starting dais api :%s (env=%s workers=%s)", port, environment, workers)
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        workers=workers,
        reload=reload,
        server_header=False,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
