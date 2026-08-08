"""The public demo-token endpoint mints a token auth.verify_token accepts, scoped to org_dev."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth import verify_token
from routes.demo_routes import DEMO_ORG_ID, DEMO_USER_ID
from routes.demo_routes import router as demo_router
from security.rate_limiting import limiter


@pytest.fixture(scope="module")
def demo_client():
    # Mount the router on its own app (like test_auth.py) so the test doesn't
    # depend on main.py wiring the demo route in.
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(demo_router)
    return TestClient(app)


def test_demo_token_verifies_and_is_scoped_to_demo_org(demo_client):
    response = demo_client.get("/public/demo-token")
    assert response.status_code == 200

    token = response.json()["token"]
    assert isinstance(token, str) and token

    claims = verify_token(token)
    assert claims is not None
    assert claims["org_id"] == DEMO_ORG_ID
    assert claims["sub"] == DEMO_USER_ID
    assert claims["aud"] == "authenticated"


def test_demo_token_expiry_is_in_the_future(demo_client):
    """The minted token carries an exp (auth requires it) and it hasn't already passed."""
    import time

    token = demo_client.get("/public/demo-token").json()["token"]
    claims = verify_token(token)
    assert claims is not None
    assert claims["exp"] > time.time()
