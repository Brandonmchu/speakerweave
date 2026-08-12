"""Per-event branding validation, tenancy, public reads, and asset uploads."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from services.branding import (
    DEFAULT_BRANDING,
    merge_branding,
    resolve_branding,
    validate_branding_patch,
)
from services.magic_links import hash_token
from tests.conftest import OTHER_EVENT_ID, TEST_EVENT_ID, TEST_ORG_ID

FORM_ID = "branding-form"
FORM_SLUG = "brand-call"
SESSION_ID = "branding-session"
API_KEY = "dais_branding_key"
API_HEADERS = {"x-access-token": API_KEY}


@pytest.mark.parametrize(
    ("patch", "key"),
    [
        ({"accent": "yellow"}, "accent"),
        ({"schedule_layout": "timeline"}, "schedule_layout"),
        ({"mystery": True}, "mystery"),
        ({"logo_path": "org/event/logo.png"}, "logo_path"),
    ],
)
def test_validator_rejects_specific_invalid_keys(patch, key):
    with pytest.raises(HTTPException) as caught:
        validate_branding_patch(patch)
    assert caught.value.status_code == 400
    assert key in str(caught.value.detail)
    assert "valid" in str(caught.value.detail)


def test_validator_normalizes_hex_and_merge_patch_retains_and_clears():
    assert validate_branding_patch({"accent": "#Aa33FF"}) == {"accent": "aa33ff"}
    merged = merge_branding(
        {"accent": "aa33ff", "radius": "large"},
        {"accent": None, "density": "compact"},
    )
    assert merged["accent"] is None
    assert merged["radius"] == "large"
    assert merged["density"] == "compact"
    assert resolve_branding({"branding": {}}) == DEFAULT_BRANDING


def test_null_resets_any_client_settable_key_not_only_colors():
    """null means "restore the default" uniformly.

    The nullable colors are the obvious case, but a caller clearing a font or a
    layout should not have to know which product default it is restoring — and
    ``merge_branding`` already reads null that way for every key.
    """
    assert validate_branding_patch({"heading_font": None}) == {"heading_font": None}
    assert validate_branding_patch({"schedule_layout": None}) == {"schedule_layout": None}

    merged = merge_branding(
        {"heading_font": "lora", "schedule_layout": "grid", "accent": "aa33ff"},
        validate_branding_patch({"heading_font": None, "schedule_layout": None}),
    )
    assert merged["heading_font"] == DEFAULT_BRANDING["heading_font"]
    assert merged["schedule_layout"] == DEFAULT_BRANDING["schedule_layout"]
    assert merged["accent"] == "aa33ff"  # untouched keys survive the reset


@pytest.fixture
def branding_db(seeded_db):
    event = next(row for row in seeded_db.rows("events") if row["id"] == TEST_EVENT_ID)
    event["branding"] = {
        "accent": "f3c94b",
        "schedule_layout": "tracks",
        "logo_url": "https://storage.test/logo.png",
    }
    seeded_db.seed(
        "sessions",
        {
            "id": SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "friendly_id": "SESS-BRAND",
            "title": "Branded session",
            "description": "A public session.",
            "status": "accepted",
            "content_approval": "approved",
            "starts_at": "2026-10-12T16:00:00+00:00",
            "ends_at": "2026-10-12T16:45:00+00:00",
            "room_id": None,
            "track_id": None,
            "format_id": None,
        },
    )
    seeded_db.seed(
        "forms",
        {
            "id": FORM_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "slug": FORM_SLUG,
            "name": "Call for sessions",
            "kind": "cfp",
            "settings": {},
        },
    )
    seeded_db.seed(
        "api_tokens",
        {
            "id": "branding-key",
            "org_id": TEST_ORG_ID,
            "token_hash": hash_token(API_KEY),
            "scopes": ["read", "write"],
        },
    )
    return seeded_db


@pytest.mark.parametrize(
    "path",
    [
        "/public/program/ai-builders-summit/schedule",
        "/public/program/ai-builders-summit/speakers",
        f"/public/program/ai-builders-summit/session/{SESSION_ID}",
        f"/public/forms/{FORM_SLUG}",
    ],
)
def test_public_responses_carry_resolved_branding(client, branding_db, path):
    response = client.get(path)
    assert response.status_code == 200, response.text
    branding = response.json()["event"]["branding"]
    assert branding["accent"] == "f3c94b"
    assert branding["schedule_layout"] == "tracks"
    assert branding["body_font"] == "instrument-sans"
    assert branding["show_powered_by"] is True


def test_pre_migration_empty_document_resolves_on_public_reads(client, branding_db):
    event = next(row for row in branding_db.rows("events") if row["id"] == TEST_EVENT_ID)
    event["branding"] = {}
    body = client.get("/public/program/ai-builders-summit/schedule").json()
    assert body["event"]["branding"] == DEFAULT_BRANDING
    form = client.get(f"/public/forms/{FORM_SLUG}").json()
    assert form["event"]["branding"] == DEFAULT_BRANDING


def test_admin_and_v1_merge_patch_share_the_service(client, auth_headers, branding_db):
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}",
        headers=auth_headers,
        json={"branding": {"accent": "#ABCDEF", "density": "compact"}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["event"]["branding"]["accent"] == "abcdef"

    response = client.put(
        f"/v1/events/{TEST_EVENT_ID}/branding",
        headers=API_HEADERS,
        json={"radius": "large", "accent": None},
    )
    assert response.status_code == 200, response.text
    document = response.json()["data"]
    assert document["accent"] is None
    assert document["density"] == "compact"
    assert document["radius"] == "large"
    assert document["event_id"] == TEST_EVENT_ID
    assert document["slug"] == "ai-builders-summit"
    assert document["public_url"].endswith("/e/ai-builders-summit/schedule")


def test_empty_branding_is_still_nothing_to_update(client, auth_headers, branding_db):
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}", headers=auth_headers, json={"branding": {}}
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Nothing to update"


def test_logo_upload_validation_and_delete(client, auth_headers, branding_db):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    accepted = client.post(
        f"/api/events/{TEST_EVENT_ID}/branding/logo",
        headers=auth_headers,
        files={"file": ("mark.png", png, "image/png")},
    )
    assert accepted.status_code == 200, accepted.text
    branding = accepted.json()["branding"]
    assert branding["logo_url"].startswith("https://storage.test/portal-files/")
    assert branding["logo_path"].startswith(
        f"{TEST_ORG_ID}/events/{TEST_EVENT_ID}/branding/logo/"
    )

    svg = client.post(
        f"/api/events/{TEST_EVENT_ID}/branding/logo",
        headers=auth_headers,
        files={"file": ("mark.svg", b"<svg></svg>", "image/svg+xml")},
    )
    assert svg.status_code == 400

    mislabeled = client.post(
        f"/api/events/{TEST_EVENT_ID}/branding/logo",
        headers=auth_headers,
        files={"file": ("mark.png", b"%PDF-1.7", "image/png")},
    )
    assert mislabeled.status_code == 400

    deleted = client.delete(
        f"/api/events/{TEST_EVENT_ID}/branding/logo", headers=auth_headers
    )
    assert deleted.status_code == 200
    assert deleted.json()["branding"]["logo_url"] is None
    assert deleted.json()["branding"]["logo_path"] is None


@pytest.mark.parametrize("kind", ["logo", "favicon"])
def test_foreign_event_asset_routes_are_indistinguishable_404(
    client, auth_headers, branding_db, kind
):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
    assert (
        client.post(
            f"/api/events/{OTHER_EVENT_ID}/branding/{kind}",
            headers=auth_headers,
            files={"file": ("asset.png", png, "image/png")},
        ).status_code
        == 404
    )
    assert (
        client.delete(
            f"/api/events/{OTHER_EVENT_ID}/branding/{kind}", headers=auth_headers
        ).status_code
        == 404
    )


@pytest.mark.parametrize("method", ["get", "put"])
def test_foreign_event_v1_branding_routes_404(client, branding_db, method):
    response = getattr(client, method)(
        f"/v1/events/{OTHER_EVENT_ID}/branding",
        headers=API_HEADERS,
        **({"json": {"accent": "abcdef"}} if method == "put" else {}),
    )
    assert response.status_code == 404
