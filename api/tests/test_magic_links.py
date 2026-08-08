"""Magic-link persistence, cookie exchange, and scoped dependencies."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from deps.portal_deps import get_portal_contact, get_reviewer
from routes.portal_session_routes import COOKIE_NAME, SESSION_MAX_AGE, router
from security.rate_limiting import limiter
from services import magic_links
from tests.conftest import TEST_JWT_SECRET, TEST_ORG_ID

CONTACT_ID = "22222222-2222-2222-2222-222222222222"
EVALUATOR_ID = "33333333-3333-3333-3333-333333333333"
NOW = datetime(2026, 8, 8, 16, 0, tzinfo=timezone.utc)


def _seed_link(
    fake_db,
    raw: str,
    *,
    purpose: str = "portal",
    expires_at: datetime | None = None,
    used_at: str | None = None,
    revoked_at: str | None = None,
) -> None:
    fake_db.seed(
        "magic_link_tokens",
        {
            "id": f"link-{len(fake_db.rows('magic_link_tokens')) + 1}",
            "org_id": TEST_ORG_ID,
            "token_hash": magic_links.hash_token(raw),
            "purpose": purpose,
            "contact_id": CONTACT_ID if purpose == "portal" else None,
            "evaluator_id": EVALUATOR_ID if purpose == "review" else None,
            "expires_at": (expires_at or NOW + timedelta(hours=1)).isoformat(),
            "used_at": used_at,
            "revoked_at": revoked_at,
        },
    )


@pytest.fixture
def portal_client():
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(router)

    @app.get("/_test/contact")
    async def contact_dependency(
        auth: tuple[str, str] = Depends(get_portal_contact),
    ):
        return {"org_id": auth[0], "contact_id": auth[1]}

    @app.get("/_test/reviewer")
    async def reviewer_dependency(
        auth: tuple[str, str] = Depends(get_reviewer),
    ):
        return {"org_id": auth[0], "evaluator_id": auth[1]}

    with TestClient(app, base_url="https://testserver") as test_client:
        yield test_client


async def test_mint_stores_only_the_hash_and_uses_injected_now(fake_db, monkeypatch):
    monkeypatch.setattr(magic_links, "generate_token", lambda: "raw-secret-token")

    raw = await magic_links.mint(
        TEST_ORG_ID,
        "portal",
        contact_id=CONTACT_ID,
        ttl_hours=6,
        now=NOW,
    )

    assert raw == "raw-secret-token"
    row = fake_db.rows("magic_link_tokens")[0]
    assert row["token_hash"] == magic_links.hash_token(raw)
    assert raw not in row.values()
    assert row["expires_at"] == (NOW + timedelta(hours=6)).isoformat()


async def test_redeem_is_single_use(fake_db):
    _seed_link(fake_db, "one-shot")

    context = await magic_links.redeem("one-shot", now=NOW)

    assert context == {
        "org_id": TEST_ORG_ID,
        "purpose": "portal",
        "contact_id": CONTACT_ID,
        "evaluator_id": None,
    }
    assert fake_db.rows("magic_link_tokens")[0]["used_at"] == NOW.isoformat()
    with pytest.raises(magic_links.InvalidMagicLinkError):
        await magic_links.redeem("one-shot", now=NOW)


async def test_redeem_rejects_expired_link(fake_db):
    _seed_link(fake_db, "too-late", expires_at=NOW - timedelta(seconds=1))

    with pytest.raises(magic_links.InvalidMagicLinkError):
        await magic_links.redeem("too-late", now=NOW)

    assert fake_db.rows("magic_link_tokens")[0]["used_at"] is None


async def test_redeem_rejects_revoked_link(fake_db):
    _seed_link(fake_db, "revoked", revoked_at=(NOW - timedelta(minutes=1)).isoformat())

    with pytest.raises(magic_links.InvalidMagicLinkError):
        await magic_links.redeem("revoked", now=NOW)

    assert fake_db.rows("magic_link_tokens")[0]["used_at"] is None


def test_session_issue_read_round_trip(monkeypatch):
    monkeypatch.setenv("PORTAL_SESSION_SECRET", "dedicated-portal-secret")

    encoded = magic_links.issue_session(
        "review", TEST_ORG_ID, evaluator_id=EVALUATOR_ID, ttl_hours=1
    )
    claims = magic_links.read_session(encoded)

    assert claims is not None
    assert claims["purpose"] == "review"
    assert claims["org_id"] == TEST_ORG_ID
    assert claims["evaluator_id"] == EVALUATOR_ID
    assert magic_links.read_session(f"{encoded}tampered") is None


def test_session_secret_falls_back_to_supabase_secret(monkeypatch):
    monkeypatch.delenv("PORTAL_SESSION_SECRET", raising=False)
    monkeypatch.setenv("SUPABASE_JWT_SECRET", TEST_JWT_SECRET)

    encoded = magic_links.issue_session("portal", TEST_ORG_ID, contact_id=CONTACT_ID)

    assert magic_links.read_session(encoded)["contact_id"] == CONTACT_ID


def test_redeem_me_logout_cookie_flow(fake_db, portal_client):
    _seed_link(fake_db, "speaker-link", expires_at=datetime.now(timezone.utc) + timedelta(hours=1))

    redeemed = portal_client.post("/public/session/redeem", json={"token": "speaker-link"})

    assert redeemed.status_code == 200
    assert redeemed.json() == {
        "purpose": "portal",
        "org_id": TEST_ORG_ID,
        "contact_id": CONTACT_ID,
    }
    set_cookie = redeemed.headers["set-cookie"]
    assert f"{COOKIE_NAME}=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "Secure" in set_cookie
    assert "SameSite=lax" in set_cookie
    assert f"Max-Age={SESSION_MAX_AGE}" in set_cookie

    me = portal_client.get("/public/session/me")
    assert me.status_code == 200
    assert me.json() == redeemed.json()

    dependency = portal_client.get("/_test/contact")
    assert dependency.status_code == 200
    assert dependency.json() == {"org_id": TEST_ORG_ID, "contact_id": CONTACT_ID}
    assert portal_client.get("/_test/reviewer").status_code == 401

    logged_out = portal_client.post("/public/session/logout")
    assert logged_out.status_code == 204
    assert f"{COOKIE_NAME}=\"\"" in logged_out.headers["set-cookie"]
    assert "Max-Age=0" in logged_out.headers["set-cookie"]
    assert portal_client.get("/public/session/me").status_code == 401


def test_redeem_rejects_an_expired_link_with_friendly_detail(fake_db, portal_client):
    _seed_link(
        fake_db,
        "expired-link",
        expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )

    response = portal_client.post("/public/session/redeem", json={"token": "expired-link"})

    assert response.status_code == 400
    assert "invalid, expired, or already used" in response.json()["detail"]


def test_reviewer_dependency_returns_evaluator_context(fake_db, portal_client):
    _seed_link(
        fake_db,
        "reviewer-link",
        purpose="review",
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    assert portal_client.post(
        "/public/session/redeem", json={"token": "reviewer-link"}
    ).status_code == 200

    response = portal_client.get("/_test/reviewer")

    assert response.status_code == 200
    assert response.json() == {"org_id": TEST_ORG_ID, "evaluator_id": EVALUATOR_ID}
