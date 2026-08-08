"""Application settings sourced from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()

_DEV_CORS_ORIGINS: list[str] = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def _split_csv(value: str | None) -> list[str]:
    """Parse a CSV env value. Returns [] (not ['*']) when unset."""
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _default_cors_origins(environment: str, frontend_url: str | None) -> list[str]:
    """Per-environment CORS defaults. Explicit list — no wildcard, no regex."""
    origins: list[str] = []
    if (environment or "development").lower() != "production":
        origins.extend(_DEV_CORS_ORIGINS)
    if frontend_url and frontend_url not in origins:
        origins.append(frontend_url.rstrip("/"))
    return origins


def _resolve_cors_origins(env_csv: str | None, environment: str, frontend_url: str | None) -> list[str]:
    """CORS_ALLOWED_ORIGINS wins when set; '*' is rejected — fail closed."""
    configured = _split_csv(env_csv)
    if configured:
        if "*" in configured:
            raise RuntimeError(
                "CORS_ALLOWED_ORIGINS must not contain '*' — fail closed. "
                "Use an explicit list of allowed origins."
            )
        return configured
    return _default_cors_origins(environment, frontend_url)


@dataclass(frozen=True)
class AppSettings:
    environment: str = field(default="development")
    log_level: str = field(default="INFO")
    cors_allowed_origins: list[str] = field(default_factory=list)
    frontend_url: str = field(default="http://localhost:5173")
    # Public base URL of THIS api — invites embed absolute .ics links, so a
    # localhost value in production means dead links in someone's calendar.
    public_api_url: str = field(default="http://localhost:8000")

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


def _load_settings() -> AppSettings:
    environment = os.getenv("ENVIRONMENT", "development")
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    return AppSettings(
        environment=environment,
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        cors_allowed_origins=_resolve_cors_origins(
            os.getenv("CORS_ALLOWED_ORIGINS"), environment, frontend_url
        ),
        frontend_url=frontend_url,
        public_api_url=os.getenv("PUBLIC_API_URL", "http://localhost:8000").rstrip("/"),
    )


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    """Return a cached settings instance."""
    return _load_settings()


settings = get_settings()
