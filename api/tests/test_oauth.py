"""OAuth 2.1 discovery, public-client flow, rotation, and MCP integration."""

from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest

pytest.importorskip("mcp")

from services.magic_links import hash_token
from tests.conftest import TEST_ORG_ID
from tests.test_mcp import McpAsgiClient

ORIGIN = "https://speakerweave.test"
REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback"
BRIDGE_API_TOKEN = "dais_oauth_bridge_key"
VERIFIER = "oauth-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE"
CHALLENGE = (
    base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode("ascii")).digest())
    .rstrip(b"=")
    .decode("ascii")
)


@pytest.fixture(autouse=True)
def oauth_origin(monkeypatch):
    monkeypatch.setenv("PUBLIC_APP_URL", ORIGIN)


@pytest.fixture
def oauth_db(seeded_db):
    seeded_db.seed(
        "api_tokens",
        {
            "id": "oauth-bridge-key",
            "org_id": TEST_ORG_ID,
            "token_hash": hash_token(BRIDGE_API_TOKEN),
            "scopes": ["read"],
        },
    )
    return seeded_db


def _register(client, *, redirect_uris: list[str] | None = None) -> dict:
    response = client.post(
        "/oauth/register",
        json={
            "client_name": "Claude for Work",
            "redirect_uris": redirect_uris or [REDIRECT_URI],
            "token_endpoint_auth_method": "none",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _authorization_params(client_id: str, *, state: str = "state-123") -> dict[str, str]:
    return {
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "code_challenge": CHALLENGE,
        "code_challenge_method": "S256",
        "state": state,
        "resource": f"{ORIGIN}/mcp",
    }


def _authorize(client, client_id: str, *, state: str = "state-123") -> str:
    params = _authorization_params(client_id, state=state)
    consent = client.get("/oauth/authorize", params=params)
    assert consent.status_code == 200
    assert "SpeakerWeave — Authorize Claude for Work" in consent.text
    assert "Settings → API tokens" in consent.text
    assert consent.text.count('type="password"') == 1

    decision = client.post(
        "/oauth/authorize/decision",
        params=params,
        data={"decision": "approve", "org_token": BRIDGE_API_TOKEN},
        follow_redirects=False,
    )
    assert decision.status_code == 302, decision.text
    query = parse_qs(urlsplit(decision.headers["location"]).query)
    assert query["state"] == [state]
    return query["code"][0]


def _exchange(client, client_id: str, code: str, *, verifier: str = VERIFIER):
    return client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": verifier,
            "resource": f"{ORIGIN}/mcp",
        },
    )


def _mcp_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }


def _initialize_request() -> dict:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "oauth-tests", "version": "1.0"},
        },
    }


def test_discovery_documents_same_origin_public_pkce_server(client):
    protected = client.get("/.well-known/oauth-protected-resource")
    assert protected.status_code == 200
    assert protected.json() == {
        "resource": f"{ORIGIN}/mcp",
        "authorization_servers": [ORIGIN],
        "bearer_methods_supported": ["header"],
    }

    server = client.get("/.well-known/oauth-authorization-server")
    assert server.status_code == 200
    assert server.json() == {
        "issuer": ORIGIN,
        "authorization_endpoint": f"{ORIGIN}/oauth/authorize",
        "token_endpoint": f"{ORIGIN}/oauth/token",
        "registration_endpoint": f"{ORIGIN}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }


@pytest.mark.parametrize(
    "redirect_uri",
    [
        "http://claude.ai/callback",
        "javascript:alert(1)",
        "https://claude.ai/callback#fragment",
        "https://user:password@claude.ai/callback",
    ],
)
def test_dynamic_registration_rejects_unsafe_redirect_uris(
    client, oauth_db, redirect_uri
):
    response = client.post(
        "/oauth/register",
        json={"client_name": "Unsafe", "redirect_uris": [redirect_uri]},
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_redirect_uri"


def test_dynamic_registration_accepts_https_and_localhost(client, oauth_db):
    metadata = _register(
        client,
        redirect_uris=[REDIRECT_URI, "http://localhost:43110/oauth/callback"],
    )
    assert metadata["client_id"].startswith("sw_client_")
    assert metadata["client_name"] == "Claude for Work"
    assert metadata["token_endpoint_auth_method"] == "none"
    assert metadata["redirect_uris"] == [
        REDIRECT_URI,
        "http://localhost:43110/oauth/callback",
    ]


def test_code_pkce_exchange_initializes_mcp_and_code_is_single_use(client, oauth_db):
    client_id = _register(client)["client_id"]
    code = _authorize(client, client_id)
    token_response = _exchange(client, client_id, code)
    assert token_response.status_code == 200, token_response.text
    tokens = token_response.json()
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] == 3600
    assert tokens["access_token"].startswith("sw_access_")
    assert tokens["refresh_token"].startswith("sw_refresh_")

    initialized = McpAsgiClient(
        client, _mcp_headers(tokens["access_token"])
    ).initialize()
    assert initialized["serverInfo"]["name"] == "dais-conference-management"

    reused = _exchange(client, client_id, code)
    assert reused.status_code == 400
    assert reused.json()["error"] == "invalid_grant"

    stored_code = oauth_db.rows("oauth_codes")[0]
    stored_token = oauth_db.rows("oauth_tokens")[0]
    assert stored_code["code_hash"] == hash_token(code)
    assert stored_token["token_hash"] == hash_token(tokens["access_token"])
    assert stored_token["refresh_hash"] == hash_token(tokens["refresh_token"])
    assert code not in str(stored_code)
    assert tokens["access_token"] not in str(stored_token)
    assert tokens["refresh_token"] not in str(stored_token)


def test_wrong_verifier_and_expired_code_are_rejected(client, oauth_db):
    client_id = _register(client)["client_id"]
    wrong_verifier_code = _authorize(client, client_id, state="wrong-verifier")
    wrong = _exchange(client, client_id, wrong_verifier_code, verifier="x" * 64)
    assert wrong.status_code == 400
    assert wrong.json()["error"] == "invalid_grant"
    assert oauth_db.rows("oauth_codes")[0].get("used_at") is None

    expired_code = _authorize(client, client_id, state="expired")
    expired_row = next(
        row
        for row in oauth_db.rows("oauth_codes")
        if row["code_hash"] == hash_token(expired_code)
    )
    expired_row["expires_at"] = (
        datetime.now(timezone.utc) - timedelta(seconds=1)
    ).isoformat()
    expired = _exchange(client, client_id, expired_code)
    assert expired.status_code == 400
    assert expired.json()["error"] == "invalid_grant"


def test_refresh_rotation_revocation_and_api_token_compatibility(client, oauth_db):
    client_id = _register(client)["client_id"]
    original = _exchange(client, client_id, _authorize(client, client_id)).json()

    rotated_response = client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": original["refresh_token"],
            "resource": f"{ORIGIN}/mcp",
        },
    )
    assert rotated_response.status_code == 200, rotated_response.text
    rotated = rotated_response.json()
    assert rotated["refresh_token"] != original["refresh_token"]
    assert rotated["access_token"] != original["access_token"]

    replay = client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": original["refresh_token"],
        },
    )
    assert replay.status_code == 400
    assert replay.json()["error"] == "invalid_grant"

    superseded = client.post(
        "/mcp", headers=_mcp_headers(original["access_token"]), json=_initialize_request()
    )
    assert superseded.status_code == 401

    rotated_row = next(
        row
        for row in oauth_db.rows("oauth_tokens")
        if row["token_hash"] == hash_token(rotated["access_token"])
    )
    rotated_row["revoked_at"] = datetime.now(timezone.utc).isoformat()
    revoked = client.post(
        "/mcp", headers=_mcp_headers(rotated["access_token"]), json=_initialize_request()
    )
    assert revoked.status_code == 401
    assert revoked.headers["www-authenticate"] == (
        f'Bearer resource_metadata="{ORIGIN}/.well-known/oauth-protected-resource"'
    )

    # The original org API-token bearer path remains valid alongside OAuth.
    initialized = McpAsgiClient(client, _mcp_headers(BRIDGE_API_TOKEN)).initialize()
    assert initialized["serverInfo"]["name"] == "dais-conference-management"


def test_denial_preserves_state_without_minting_code(client, oauth_db):
    client_id = _register(client)["client_id"]
    response = client.post(
        "/oauth/authorize/decision",
        params=_authorization_params(client_id, state="deny-state"),
        data={"decision": "deny"},
        follow_redirects=False,
    )
    assert response.status_code == 302
    query = parse_qs(urlsplit(response.headers["location"]).query)
    assert query == {"error": ["access_denied"], "state": ["deny-state"]}
    assert oauth_db.rows("oauth_codes") == []


def test_unauthorized_mcp_advertises_resource_metadata(client, oauth_db):
    response = client.post("/mcp", json=_initialize_request())
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == (
        f'Bearer resource_metadata="{ORIGIN}/.well-known/oauth-protected-resource"'
    )
