"""The public demo entrances.

`/public/demo-token` mints a token auth.verify_token accepts, scoped to org_dev.
`/public/demo-entry/{persona}` opens the same workspace as any of its three
audiences: the organizer gets that same token, while the reviewer and the
speaker get the real magic link an organizer would have emailed them.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth import verify_token
from routes.demo_routes import (
    DEMO_ORG_ID,
    DEMO_REVIEWER_EVALUATOR_ID,
    DEMO_SPEAKER_CONTACT_ID,
    DEMO_USER_ID,
)
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


@pytest.fixture
def seeded_demo(fake_db):
    """The two seeded rows the reviewer and speaker personas enter as."""
    fake_db.seed("contacts", {"id": DEMO_SPEAKER_CONTACT_ID, "org_id": DEMO_ORG_ID})
    fake_db.seed("evaluators", {"id": DEMO_REVIEWER_EVALUATOR_ID, "org_id": DEMO_ORG_ID})
    return fake_db


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


def test_organizer_entry_is_the_same_credential_as_the_demo_token(demo_client):
    """The existing door is unchanged: same shape, same claims, same org."""
    body = demo_client.get("/public/demo-entry/organizer").json()
    assert body["persona"] == "organizer"
    assert body["kind"] == "token"

    claims = verify_token(body["token"])
    assert claims is not None
    assert claims["org_id"] == DEMO_ORG_ID
    assert claims["sub"] == DEMO_USER_ID



async def test_reviewer_entry_mints_a_real_review_link(demo_client, seeded_demo):
    """The link redeems as a review magic link bound to the seeded evaluator."""
    from services import magic_links

    body = demo_client.get("/public/demo-entry/reviewer").json()
    assert body["persona"] == "reviewer"
    assert body["kind"] == "path"
    assert body["path"].startswith("/review/")

    raw = body["path"].removeprefix("/review/")
    context = await magic_links.redeem(raw)
    assert context["purpose"] == "review"
    assert context["org_id"] == DEMO_ORG_ID
    assert context["evaluator_id"] == DEMO_REVIEWER_EVALUATOR_ID

    # Review links are reusable by design (services/magic_links), and a judge who
    # reopens the tab must not find a dead end.
    again = await magic_links.redeem(raw)
    assert again["evaluator_id"] == DEMO_REVIEWER_EVALUATOR_ID



async def test_speaker_entry_mints_a_real_portal_link(demo_client, seeded_demo):
    """The link redeems as a portal magic link bound to the seeded speaker."""
    from services import magic_links

    body = demo_client.get("/public/demo-entry/speaker").json()
    assert body["persona"] == "speaker"
    assert body["kind"] == "path"
    assert body["path"].startswith("/portal/")

    raw = body["path"].removeprefix("/portal/")
    context = await magic_links.redeem(raw)
    assert context["purpose"] == "portal"
    assert context["org_id"] == DEMO_ORG_ID
    assert context["contact_id"] == DEMO_SPEAKER_CONTACT_ID


def test_unknown_persona_is_not_found(demo_client):
    assert demo_client.get("/public/demo-entry/admin").status_code == 404
    assert demo_client.get("/public/demo-entry/organiser").status_code == 404


def test_unseeded_deployment_refuses_rather_than_minting_a_dead_link(demo_client, fake_db):
    """No seeded workspace, no link — and nothing written to the token table."""
    for persona in ("reviewer", "speaker"):
        response = demo_client.get(f"/public/demo-entry/{persona}")
        assert response.status_code == 404
        assert "demo" in response.json()["detail"].lower()

    assert fake_db.rows("magic_link_tokens") == []


def test_rows_belonging_to_another_org_do_not_open_the_demo(demo_client, fake_db):
    """The seeded ids are demo ids; the same id under a real org is not a door."""
    fake_db.seed("contacts", {"id": DEMO_SPEAKER_CONTACT_ID, "org_id": "org_real"})
    fake_db.seed("evaluators", {"id": DEMO_REVIEWER_EVALUATOR_ID, "org_id": "org_real"})

    assert demo_client.get("/public/demo-entry/speaker").status_code == 404
    assert demo_client.get("/public/demo-entry/reviewer").status_code == 404
    assert fake_db.rows("magic_link_tokens") == []
