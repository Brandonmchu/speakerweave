"""Multi-organization support, tested at its boundaries.

Two features share this file because they share one rule: what a caller may
reach across an org boundary is decided by something the server verified, never
by something the request said.

* Organizer switching — `org_memberships` is read from the database before a
  token is signed. An org the caller has no row in is a 404, not a 403, and no
  token comes back.
* Speaker cross-org sign-in — the emailed `portal_choose` token is the only
  thing that authorises the one cross-org read in the system. The sign-in
  endpoint answers identically for a known and an unknown address, `/choices`
  never shows another email's contacts, and `/choose` refuses a `contact_id`
  the token's email does not own.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pytest

from routes.portal_session_routes import COOKIE_NAME
from services.magic_links import hash_token, read_session
from services.portal_signin import CHOOSE_PURPOSE
from tests.conftest import (
    OTHER_ORG_ID,
    TEST_EVENT_ID,
    TEST_ORG_ID,
    TEST_USER_ID,
    make_token,
)

# ── organizer fixtures ──────────────────────────────────────────────────────

SECOND_ORG = "org_second_client"
THIRD_ORG = "org_not_mine"
SECOND_EVENT = "55555555-5555-5555-5555-555555550001"


@pytest.fixture
def org_db(seeded_db, monkeypatch):
    """Two orgs this user belongs to, one they do not.

    `supabase_client.supabase` is patched too: the auth dependency imports it
    at call time for its lazy org/membership bootstrap, so this keeps that
    write inside the fake instead of reaching for a Supabase that isn't there.
    """
    monkeypatch.setattr("supabase_client.supabase", seeded_db)

    seeded_db.seed("orgs", {"org_id": SECOND_ORG, "name": "Frontend Guild", "created_at": "2026-02-01T00:00:00+00:00"})
    seeded_db.seed("orgs", {"org_id": THIRD_ORG, "name": "Someone Else", "created_at": "2026-03-01T00:00:00+00:00"})
    seeded_db.rows("orgs")[0]["created_at"] = "2026-01-01T00:00:00+00:00"
    seeded_db.seed(
        "events",
        {"id": SECOND_EVENT, "org_id": SECOND_ORG, "name": "Frontend Fest", "slug": "frontend-fest"},
    )
    seeded_db.seed(
        "org_memberships",
        {"org_id": TEST_ORG_ID, "user_id": TEST_USER_ID, "role": "admin"},
        {"org_id": SECOND_ORG, "user_id": TEST_USER_ID, "role": "member"},
        # Another person's membership in the org this user may NOT reach.
        {"org_id": THIRD_ORG, "user_id": "someone_else", "role": "admin"},
    )
    return seeded_db


def auth_header(org_id: str = TEST_ORG_ID, sub: str = TEST_USER_ID) -> dict:
    return {"Authorization": f"Bearer {make_token(sub=sub, org_id=org_id)}"}


# ── GET /v1/me/organizations ────────────────────────────────────────────────


def test_lists_only_orgs_this_user_belongs_to(client, org_db):
    response = client.get("/v1/me/organizations", headers=auth_header())

    assert response.status_code == 200
    organizations = response.json()["organizations"]
    assert [org["org_id"] for org in organizations] == [SECOND_ORG, TEST_ORG_ID]
    assert THIRD_ORG not in {org["org_id"] for org in organizations}

    current = next(org for org in organizations if org["org_id"] == TEST_ORG_ID)
    other = next(org for org in organizations if org["org_id"] == SECOND_ORG)
    assert current == {
        "org_id": TEST_ORG_ID,
        "name": "Dais Dev Org",
        "role": "admin",
        "events": 1,
        "is_current": True,
    }
    assert other["role"] == "member"
    assert other["events"] == 1
    assert other["is_current"] is False


def test_list_always_includes_the_token_org_without_a_membership_row(client, seeded_db):
    """An existing token must never see an empty switcher and lose its org."""
    assert seeded_db.rows("org_memberships") == []

    response = client.get("/v1/me/organizations", headers=auth_header())

    assert response.status_code == 200
    assert response.json() == {
        "organizations": [
            {
                "org_id": TEST_ORG_ID,
                "name": "Dais Dev Org",
                "role": "admin",
                "events": 1,
                "is_current": True,
            }
        ]
    }


def test_list_requires_a_token(client, org_db):
    assert client.get("/v1/me/organizations").status_code == 401


def test_list_never_401s_a_validly_authenticated_user(client, fake_db):
    """The web client signs an organizer out on a 401 from an authed route, so
    this one must answer 200 for any valid token — even with an empty database
    where the org row itself has never been written."""
    assert fake_db.rows("orgs") == []

    response = client.get("/v1/me/organizations", headers=auth_header())

    assert response.status_code == 200
    organizations = response.json()["organizations"]
    assert [org["org_id"] for org in organizations] == [TEST_ORG_ID]
    assert organizations[0]["name"] == TEST_ORG_ID  # no orgs row: fall back to the id
    assert organizations[0]["events"] == 0
    assert organizations[0]["is_current"] is True


def test_membership_backfill_never_downgrades_an_existing_role(client, seeded_db, monkeypatch):
    """Signing in again must not reset a role someone was deliberately given."""
    import auth

    monkeypatch.setattr("supabase_client.supabase", seeded_db)
    seeded_db.seed(
        "org_memberships",
        {"org_id": TEST_ORG_ID, "user_id": TEST_USER_ID, "role": "member"},
    )
    auth._ORG_SEEN.pop((TEST_ORG_ID, TEST_USER_ID), None)

    response = client.get("/v1/me/organizations", headers=auth_header())

    assert response.status_code == 200
    assert len(seeded_db.rows("org_memberships")) == 1
    assert seeded_db.rows("org_memberships")[0]["role"] == "member"
    assert response.json()["organizations"][0]["role"] == "member"


def test_api_alias_serves_the_same_payload(client, org_db):
    """The web tier proxies /api, not /v1; both mounts must agree."""
    v1 = client.get("/v1/me/organizations", headers=auth_header())
    api = client.get("/api/me/organizations", headers=auth_header())

    assert api.status_code == 200
    assert api.json() == v1.json()


# ── POST /v1/me/organizations/{org_id}/token ────────────────────────────────


def test_minted_token_authenticates_and_carries_the_requested_org(client, org_db):
    response = client.post(f"/v1/me/organizations/{SECOND_ORG}/token", headers=auth_header())

    assert response.status_code == 200
    token = response.json()["token"]

    from auth import verify_token

    claims = verify_token(token)
    assert claims is not None
    assert claims["org_id"] == SECOND_ORG
    assert claims["sub"] == TEST_USER_ID  # same person, different org
    assert claims["aud"] == "authenticated"
    assert claims["exp"] > claims["iat"]

    # And it really works: the switched token now reports the second org.
    switched = client.get(
        "/v1/me/organizations", headers={"Authorization": f"Bearer {token}"}
    )
    assert switched.status_code == 200
    current = [org for org in switched.json()["organizations"] if org["is_current"]]
    assert [org["org_id"] for org in current] == [SECOND_ORG]


def test_minting_takes_no_request_body(client, org_db):
    """The browser sends this with no body and no Content-Type; 422 would break
    every switch. org_id comes from the path and nowhere else."""
    response = client.post(
        f"/v1/me/organizations/{SECOND_ORG}/token", headers=auth_header(), content=b""
    )

    assert response.status_code == 200
    assert response.json()["token"]


def test_non_member_asking_for_another_orgs_token_gets_404(client, org_db):
    """404, not 403: the caller learns nothing about THIRD_ORG's existence."""
    response = client.post(f"/v1/me/organizations/{THIRD_ORG}/token", headers=auth_header())

    assert response.status_code == 404
    assert "token" not in response.json()


def test_unknown_org_is_the_same_404_as_a_foreign_one(client, org_db):
    real = client.post(f"/v1/me/organizations/{THIRD_ORG}/token", headers=auth_header())
    imaginary = client.post(
        "/v1/me/organizations/org_does_not_exist/token", headers=auth_header()
    )

    assert real.status_code == imaginary.status_code == 404
    assert real.json() == imaginary.json()


def test_token_for_the_callers_own_org_survives_a_missing_membership_row(client, seeded_db):
    """The caller already holds a verified token for it; re-issuing grants nothing."""
    assert seeded_db.rows("org_memberships") == []

    response = client.post(f"/v1/me/organizations/{TEST_ORG_ID}/token", headers=auth_header())

    assert response.status_code == 200

    from auth import verify_token

    assert verify_token(response.json()["token"])["org_id"] == TEST_ORG_ID


def test_minting_requires_a_token(client, org_db):
    assert client.post(f"/v1/me/organizations/{SECOND_ORG}/token").status_code == 401


# ── membership backfill ─────────────────────────────────────────────────────


def test_membership_is_backfilled_on_first_authentication(client, seeded_db, monkeypatch):
    """The row nothing wrote before now appears — once per (user, org)."""
    import auth

    monkeypatch.setattr("supabase_client.supabase", seeded_db)
    auth._ORG_SEEN.pop((TEST_ORG_ID, TEST_USER_ID), None)
    assert seeded_db.rows("org_memberships") == []

    assert client.get("/v1/me/organizations", headers=auth_header()).status_code == 200

    memberships = seeded_db.rows("org_memberships")
    assert len(memberships) == 1
    assert memberships[0]["org_id"] == TEST_ORG_ID
    assert memberships[0]["user_id"] == TEST_USER_ID
    assert memberships[0]["role"] == "admin"

    def membership_writes():
        return [
            entry
            for entry in seeded_db.log
            if entry["table"] == "org_memberships" and entry["op"] == "upsert"
        ]

    assert len(membership_writes()) == 1

    # Cached: a second request in the same TTL must not write again.
    assert client.get("/v1/me/organizations", headers=auth_header()).status_code == 200
    assert len(membership_writes()) == 1
    assert len(seeded_db.rows("org_memberships")) == 1


def test_backfill_failure_never_fails_the_request(client, seeded_db, monkeypatch):
    """Best-effort: a broken membership write must not 500 an authed call."""
    import auth
    from services import org_membership

    monkeypatch.setattr("supabase_client.supabase", seeded_db)
    auth._ORG_SEEN.pop((TEST_ORG_ID, TEST_USER_ID), None)

    async def boom(*_args, **_kwargs):
        raise RuntimeError("membership table is on fire")

    monkeypatch.setattr(org_membership, "upsert_membership", boom)

    response = client.get("/v1/me/organizations", headers=auth_header())

    assert response.status_code == 200
    # Uncached, so the next request retries rather than silently giving up.
    # (The autouse cache-warm fixture re-primes it for the next test.)
    assert (TEST_ORG_ID, TEST_USER_ID) not in auth._ORG_SEEN


# ── speaker cross-org sign-in ───────────────────────────────────────────────

ORG_B = "org_frontend_guild"
EVENT_B = "55555555-5555-5555-5555-5555555500b1"
ADA_A = "66666666-6666-6666-6666-6666666600a1"
ADA_B = "66666666-6666-6666-6666-6666666600b1"
BEN_A = "66666666-6666-6666-6666-6666666600a2"
ADA = "ada@example.com"
BEN = "ben@example.com"
CHOOSE_TOKEN = "portal-choose-raw-token"
CFP_SLUG = "ai-builders-cfp"


def seed_choose_token(db, *, raw=CHOOSE_TOKEN, email=ADA, org_id=TEST_ORG_ID,
                      purpose=CHOOSE_PURPOSE, expires_at=None, revoked_at=None):
    db.seed(
        "magic_link_tokens",
        {
            "id": f"mlt-{raw}",
            "org_id": org_id,
            "token_hash": hash_token(raw),
            "purpose": purpose,
            "contact_id": None,
            "email": email,
            "expires_at": expires_at
            or (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "revoked_at": revoked_at,
            "used_at": None,
        },
    )
    return raw


@pytest.fixture
def speaker_db(seeded_db):
    """One address (Ada) speaking at two conferences in two different orgs."""
    seeded_db.rows("events")[0]["starts_at"] = "2026-03-01T09:00:00+00:00"
    seeded_db.rows("events")[0]["ends_at"] = "2026-03-02T17:00:00+00:00"
    seeded_db.seed("orgs", {"org_id": ORG_B, "name": "Frontend Guild"})
    seeded_db.seed(
        "events",
        {
            "id": EVENT_B,
            "org_id": ORG_B,
            "name": "Frontend Fest",
            "slug": "frontend-fest",
            "starts_at": "2026-09-01T09:00:00+00:00",
            "ends_at": "2026-09-02T17:00:00+00:00",
        },
    )
    seeded_db.seed(
        "contacts",
        {"id": ADA_A, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "email": ADA, "first_name": "Ada"},
        {"id": ADA_B, "org_id": ORG_B, "event_id": EVENT_B, "email": ADA, "first_name": "Ada"},
        {"id": BEN_A, "org_id": TEST_ORG_ID, "event_id": TEST_EVENT_ID, "email": BEN, "first_name": "Ben"},
    )
    # The older, event-scoped manage-link path lives on beside the new one.
    seeded_db.seed(
        "forms",
        {
            "id": "77777777-7777-7777-7777-7777777700a1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "slug": CFP_SLUG,
            "name": "Call for Speakers",
            "kind": "cfp",
            "settings": {},
        },
    )
    seeded_db.seed(
        "sessions",
        {
            "id": "88888888-8888-8888-8888-8888888800a1",
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Scaling LLM inference",
            "status": "pending",
            "source_form_id": "77777777-7777-7777-7777-7777777700a1",
            "submitter_contact_id": ADA_A,
        },
    )
    return seeded_db


@pytest.fixture
def https_client():
    """A client the portal cookie actually comes back on.

    The shared `client` speaks http://testserver, and httpx will not send a
    Secure cookie over http — so a round trip through the real session
    dependency needs https, exactly as test_magic_links does. No lifespan here:
    the session-scoped `client` already owns the app's startup.
    """
    from fastapi.testclient import TestClient

    from main import app

    return TestClient(app, base_url="https://testserver")


def token_from_outbox(db) -> str:
    html = db.rows("email_outbox")[0]["payload"]["html"]
    match = re.search(r"/portal/choose\?token=([A-Za-z0-9_\-]+)", html)
    assert match, html
    return match.group(1)


# ── POST /public/portal/sign-in ─────────────────────────────────────────────


def test_sign_in_is_identical_for_a_known_and_an_unknown_address(client, speaker_db):
    known = client.post("/public/portal/sign-in", json={"email": ADA})
    unknown = client.post("/public/portal/sign-in", json={"email": "nobody@example.com"})

    assert known.status_code == 202
    assert unknown.status_code == known.status_code
    assert unknown.content == known.content  # byte for byte

    # Only the real address produced anything at all.
    assert len(speaker_db.rows("magic_link_tokens")) == 1
    assert len(speaker_db.rows("email_outbox")) == 1


def test_sign_in_sends_one_link_covering_every_org(client, speaker_db):
    response = client.post("/public/portal/sign-in", json={"email": ADA})

    assert response.status_code == 202
    assert response.json() == {
        "ok": True,
        "message": (
            "If that email is on any conference we host, we've sent a sign-in "
            "link. Check your inbox."
        ),
    }

    tokens = speaker_db.rows("magic_link_tokens")
    assert len(tokens) == 1
    assert tokens[0]["purpose"] == CHOOSE_PURPOSE
    assert tokens[0]["email"] == ADA
    assert tokens[0]["contact_id"] is None  # bound to the address, not a contact
    assert "token" not in tokens[0]  # only the hash is persisted

    outbox = speaker_db.rows("email_outbox")
    assert len(outbox) == 1  # ONE email, not one per conference
    assert outbox[0]["template_key"] == "portal_sign_in"
    assert outbox[0]["payload"]["to"] == ADA
    assert hash_token(token_from_outbox(speaker_db)) == tokens[0]["token_hash"]


def test_sign_in_normalizes_the_address(client, speaker_db):
    response = client.post("/public/portal/sign-in", json={"email": "  Ada@Example.COM "})

    assert response.status_code == 202
    assert speaker_db.rows("magic_link_tokens")[0]["email"] == ADA


def test_sign_in_stays_silent_when_the_lookup_fails(client, speaker_db, monkeypatch):
    """A database outage must not become a distinguishable answer."""
    from services import portal_signin

    async def boom(*_args, **_kwargs):
        raise RuntimeError("contacts table is on fire")

    monkeypatch.setattr(portal_signin, "_contacts_for_email", boom)

    broken = client.post("/public/portal/sign-in", json={"email": ADA})
    unknown = client.post("/public/portal/sign-in", json={"email": "nobody@example.com"})

    assert broken.status_code == 202
    assert broken.content == unknown.content


# ── GET /public/portal/choices ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "query",
    ["", "?token=", "?token=not-a-real-token"],
)
def test_choices_needs_a_valid_token(client, speaker_db, query):
    response = client.get(f"/public/portal/choices{query}")

    assert response.status_code == 401
    assert "choices" not in response.json()


def test_choices_lists_every_conference_newest_first(client, speaker_db):
    seed_choose_token(speaker_db)

    response = client.get(f"/public/portal/choices?token={CHOOSE_TOKEN}")

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == ADA
    assert body["choices"] == [
        {
            "contact_id": ADA_B,
            "org_id": ORG_B,
            "org_name": "Frontend Guild",
            "event_id": EVENT_B,
            "event_name": "Frontend Fest",
            "starts_at": "2026-09-01T09:00:00+00:00",
            "ends_at": "2026-09-02T17:00:00+00:00",
        },
        {
            "contact_id": ADA_A,
            "org_id": TEST_ORG_ID,
            "org_name": "Dais Dev Org",
            "event_id": TEST_EVENT_ID,
            "event_name": "AI Builders Summit",
            "starts_at": "2026-03-01T09:00:00+00:00",
            "ends_at": "2026-03-02T17:00:00+00:00",
        },
    ]


def test_choices_never_leaks_another_email(client, speaker_db):
    seed_choose_token(speaker_db, raw="bens-token", email=BEN)

    response = client.get("/public/portal/choices?token=bens-token")

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == BEN
    assert [choice["contact_id"] for choice in body["choices"]] == [BEN_A]
    assert ADA_A not in str(body) and ADA_B not in str(body)


def test_choices_refuses_an_expired_token(client, speaker_db):
    seed_choose_token(
        speaker_db,
        raw="stale-token",
        expires_at=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
    )

    assert client.get("/public/portal/choices?token=stale-token").status_code == 401


def test_choices_refuses_a_revoked_token(client, speaker_db):
    seed_choose_token(
        speaker_db,
        raw="revoked-token",
        revoked_at=datetime.now(timezone.utc).isoformat(),
    )

    assert client.get("/public/portal/choices?token=revoked-token").status_code == 401


def test_choices_refuses_a_token_minted_for_another_purpose(client, speaker_db):
    """A submitter/portal token must not open the cross-org read."""
    seed_choose_token(speaker_db, raw="submitter-token", purpose="submitter")

    assert client.get("/public/portal/choices?token=submitter-token").status_code == 401


def test_a_choose_token_cannot_be_redeemed_for_a_session_directly(client, speaker_db):
    """Its purpose is deliberately outside the portal-session vocabulary."""
    seed_choose_token(speaker_db)

    response = client.post("/public/session/redeem", json={"token": CHOOSE_TOKEN})

    assert response.status_code == 400
    assert COOKIE_NAME not in response.headers.get("set-cookie", "")


# ── POST /public/portal/choose ──────────────────────────────────────────────


def test_choose_issues_a_portal_session_for_the_chosen_org(client, speaker_db):
    seed_choose_token(speaker_db)

    response = client.post(
        "/public/portal/choose", json={"token": CHOOSE_TOKEN, "contact_id": ADA_B}
    )

    assert response.status_code == 204
    set_cookie = response.headers["set-cookie"]
    assert f"{COOKIE_NAME}=" in set_cookie
    assert "HttpOnly" in set_cookie and "Secure" in set_cookie and "SameSite=lax" in set_cookie

    claims = read_session(set_cookie.split(f"{COOKIE_NAME}=")[1].split(";")[0])
    assert claims is not None
    assert claims["purpose"] == "portal"
    assert claims["org_id"] == ORG_B  # the org of the CHOSEN conference
    assert claims["contact_id"] == ADA_B


def test_choose_refuses_a_contact_belonging_to_another_email(client, speaker_db):
    seed_choose_token(speaker_db)  # Ada's token…

    response = client.post(
        "/public/portal/choose", json={"token": CHOOSE_TOKEN, "contact_id": BEN_A}  # …Ben's contact
    )

    assert response.status_code == 401
    assert COOKIE_NAME not in response.headers.get("set-cookie", "")


def test_choose_refuses_a_contact_from_an_org_the_email_is_not_in(client, speaker_db):
    """An id that exists somewhere is still not this email's to enter."""
    speaker_db.seed(
        "contacts",
        {
            "id": "66666666-6666-6666-6666-6666666600ff",
            "org_id": OTHER_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "email": "stranger@example.com",
        },
    )
    seed_choose_token(speaker_db)

    response = client.post(
        "/public/portal/choose",
        json={"token": CHOOSE_TOKEN, "contact_id": "66666666-6666-6666-6666-6666666600ff"},
    )

    assert response.status_code == 401
    assert COOKIE_NAME not in response.headers.get("set-cookie", "")


def test_choose_refuses_an_expired_token(client, speaker_db):
    seed_choose_token(
        speaker_db,
        raw="stale-token",
        expires_at=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
    )

    response = client.post(
        "/public/portal/choose", json={"token": "stale-token", "contact_id": ADA_A}
    )

    assert response.status_code == 401
    assert COOKIE_NAME not in response.headers.get("set-cookie", "")


def test_the_event_scoped_manage_link_is_unchanged(client, speaker_db):
    """The new cross-org endpoint is additive: the submitter flow the CFP
    confirmation screen uses still mints its own event-scoped token."""
    response = client.post(f"/public/forms/{CFP_SLUG}/manage-link", json={"email": ADA})

    assert response.status_code == 200
    assert response.json()["ok"] is True

    tokens = speaker_db.rows("magic_link_tokens")
    assert [token["purpose"] for token in tokens] == ["submitter"]
    assert tokens[0]["contact_id"] == ADA_A  # one contact, one event, as before
    assert speaker_db.rows("email_outbox")[0]["template_key"] == "submitter_manage_link"


def test_sign_in_to_portal_end_to_end(https_client, speaker_db):
    """Request a link, read the token out of the queued email, enter a portal."""
    assert https_client.post("/public/portal/sign-in", json={"email": ADA}).status_code == 202
    raw = token_from_outbox(speaker_db)

    choices = https_client.get(f"/public/portal/choices?token={raw}")
    assert choices.status_code == 200
    assert [choice["org_id"] for choice in choices.json()["choices"]] == [ORG_B, TEST_ORG_ID]

    chosen = choices.json()["choices"][1]  # the older conference, in the other org
    entered = https_client.post(
        "/public/portal/choose", json={"token": raw, "contact_id": chosen["contact_id"]}
    )
    assert entered.status_code == 204

    # The cookie is accepted by the ordinary portal session dependency, scoped
    # to the chosen org's contact and nothing else.
    me = https_client.get("/public/session/me")
    assert me.status_code == 200
    assert me.json() == {
        "purpose": "portal",
        "org_id": TEST_ORG_ID,
        "contact_id": ADA_A,
    }
