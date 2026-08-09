"""Shared test fixtures.

Importing `main` builds a Supabase client at module scope, so the environment
must be populated BEFORE any app import — hence the assignments at the top of
this file (conftest is imported first). Values are forced, not defaulted, so a
developer's real .env can never point the suite at a live project.
"""

import os
from datetime import datetime, timedelta, timezone

import jwt
import pytest

TEST_JWT_SECRET = "dais-test-jwt-secret-not-for-real-use"
TEST_USER_ID = "dev_user"
TEST_ORG_ID = "org_dev"
OTHER_ORG_ID = "org_someone_else"
TEST_EVENT_ID = "11111111-1111-1111-1111-111111111111"
OTHER_EVENT_ID = "11111111-1111-1111-1111-1111111111ff"

os.environ["ENVIRONMENT"] = "test"
os.environ["SUPABASE_URL"] = "http://localhost:54321"
os.environ["SUPABASE_SERVICE_API_KEY"] = "test-service-role-key"
os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
os.environ["RATE_LIMIT_ENABLED"] = "false"
# load_dotenv() (settings/supabase_client) pulls the developer's real .env into
# the process — including a real RESEND_API_KEY. Tests must always run the
# dev-mode mailer (.eml outbox, no suppression). Set EMPTY (not pop): dotenv
# never overrides an existing var, but it would re-add a popped one.
os.environ["RESEND_API_KEY"] = ""


def make_token(
    sub: str = TEST_USER_ID,
    org_id: str | None = TEST_ORG_ID,
    secret: str = TEST_JWT_SECRET,
    audience: str = "authenticated",
    expires_in_minutes: int = 60,
) -> str:
    """Mint a JWT in the shape auth.py expects (mirrors scripts/mint_dev_token.py)."""
    now = datetime.now(timezone.utc)
    claims = {
        "sub": sub,
        "aud": audience,
        "iat": now,
        "exp": now + timedelta(minutes=expires_in_minutes),
    }
    if org_id is not None:
        claims["org_id"] = org_id
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def auth_headers():
    return {"Authorization": f"Bearer {make_token()}"}


@pytest.fixture(autouse=True)
def _org_cache_warm():
    """Pre-warm auth's org cache.

    `get_current_user_and_org` lazily upserts the org on first sight, which in
    a test means a doomed round trip to a Supabase that is not running. The
    upsert is best-effort in production too, so skipping it changes nothing
    the tests are about.
    """
    import time

    import auth

    auth._ORG_SEEN[TEST_ORG_ID] = time.monotonic()
    yield


@pytest.fixture
def fake_db(monkeypatch):
    """An empty in-memory Supabase, installed everywhere it is imported."""
    import importlib

    from tests.fakes import PATCH_TARGET_MODULES, FakeSupabase

    fake = FakeSupabase()
    for module_path in PATCH_TARGET_MODULES:
        monkeypatch.setattr(importlib.import_module(module_path), "supabase", fake)
    return fake


@pytest.fixture
def seeded_db(fake_db):
    """One org, one event — the minimum every authenticated route needs."""
    fake_db.seed("orgs", {"org_id": TEST_ORG_ID, "name": "Dais Dev Org"})
    fake_db.seed(
        "events",
        {
            "id": TEST_EVENT_ID,
            "org_id": TEST_ORG_ID,
            "name": "AI Builders Summit",
            "slug": "ai-builders-summit",
            "timezone": "America/Los_Angeles",
        },
    )
    fake_db.seed(
        "events",
        {
            "id": OTHER_EVENT_ID,
            "org_id": OTHER_ORG_ID,
            "name": "Someone Else's Conf",
            "slug": "someone-else",
        },
    )
    return fake_db
