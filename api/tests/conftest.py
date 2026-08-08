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

os.environ["ENVIRONMENT"] = "test"
os.environ["SUPABASE_URL"] = "http://localhost:54321"
os.environ["SUPABASE_SERVICE_API_KEY"] = "test-service-role-key"
os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
os.environ["RATE_LIMIT_ENABLED"] = "false"


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
