"""The auth dependency accepts exactly the tokens it should, and nothing else."""

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from auth import get_current_user_and_org, verify_org_access
from tests.conftest import TEST_ORG_ID, TEST_USER_ID, make_token

_app = FastAPI()


@_app.get("/whoami")
async def whoami(auth: tuple = Depends(get_current_user_and_org)):
    user_id, org_id = auth
    return {"user_id": user_id, "org_id": org_id}


@pytest.fixture(scope="module")
def auth_client():
    return TestClient(_app)


def test_valid_token_accepted(auth_client):
    response = auth_client.get(
        "/whoami", headers={"Authorization": f"Bearer {make_token()}"}
    )
    assert response.status_code == 200
    assert response.json() == {"user_id": TEST_USER_ID, "org_id": TEST_ORG_ID}


def test_missing_header_rejected(auth_client):
    assert auth_client.get("/whoami").status_code == 401


def test_garbage_token_rejected(auth_client):
    response = auth_client.get("/whoami", headers={"Authorization": "Bearer not-a-jwt"})
    assert response.status_code == 401


def test_wrong_secret_rejected(auth_client):
    token = make_token(secret="some-other-projects-secret")
    response = auth_client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_expired_token_rejected(auth_client):
    token = make_token(expires_in_minutes=-120)
    response = auth_client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_wrong_audience_rejected(auth_client):
    token = make_token(audience="anon")
    response = auth_client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_token_without_org_rejected(auth_client):
    """No org claim means no org predicate is possible — fail closed."""
    token = make_token(org_id=None)
    response = auth_client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_token_without_exp_rejected(auth_client):
    """A token that never expires is not a Supabase-shaped token — fail closed."""
    import jwt

    from tests.conftest import TEST_JWT_SECRET

    # A well-formed token in every way except that it omits `exp`.
    claims = {"sub": TEST_USER_ID, "aud": "authenticated", "org_id": TEST_ORG_ID}
    token = jwt.encode(claims, TEST_JWT_SECRET, algorithm="HS256")
    response = auth_client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_verify_org_access_allows_matching_org():
    row = {"id": "abc", "org_id": TEST_ORG_ID}
    assert verify_org_access(row, TEST_ORG_ID) is row


def test_verify_org_access_404s_on_other_org():
    with pytest.raises(HTTPException) as exc:
        verify_org_access({"id": "abc", "org_id": "org_someone_else"}, TEST_ORG_ID)
    assert exc.value.status_code == 404


def test_verify_org_access_404s_on_missing_row():
    with pytest.raises(HTTPException) as exc:
        verify_org_access(None, TEST_ORG_ID, "Event")
    assert exc.value.status_code == 404
    assert exc.value.detail == "Event not found"
