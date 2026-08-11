"""Events (create/read/update) and the submission detail view."""

from __future__ import annotations

import pytest

from tests.conftest import (
    OTHER_EVENT_ID,
    OTHER_ORG_ID,
    TEST_EVENT_ID,
    TEST_ORG_ID,
    make_token,
)

SESSION_ID = "99999999-9999-9999-9999-999999999901"
FORM_ID = "66666666-6666-6666-6666-666666666601"
F_ABSTRACT = "55555555-5555-5555-5555-555555555501"
F_SPOKEN = "55555555-5555-5555-5555-555555555507"
CONTACT_ID = "22222222-2222-2222-2222-222222222201"
COSPEAKER_ID = "22222222-2222-2222-2222-222222222202"


# ── POST /api/events ───────────────────────────────────────────────────────


def test_create_event_requires_auth(client):
    assert client.post("/api/events", json={"name": "X"}).status_code == 401


def test_create_event(client, auth_headers, fake_db):
    response = client.post(
        "/api/events",
        headers=auth_headers,
        json={
            "name": "  AI Builders Summit 2026  ",
            "timezone": "America/New_York",
            "starts_at": "2026-10-12T08:00:00-07:00",
            "ends_at": "2026-10-13T18:00:00-07:00",
            "location": "San Francisco, CA",
        },
    )

    assert response.status_code == 201
    event = response.json()["event"]
    assert event["name"] == "AI Builders Summit 2026"
    assert event["slug"] == "ai-builders-summit-2026"
    assert event["org_id"] == TEST_ORG_ID
    assert event["timezone"] == "America/New_York"
    assert event["location"] == "San Francisco, CA"


def test_create_event_seeds_the_default_formats(client, auth_headers, fake_db):
    """An event with no formats cannot accept a submission that names one."""
    event_id = client.post("/api/events", headers=auth_headers, json={"name": "Summit"}).json()[
        "event"
    ]["id"]

    seeded = {(row["name"], row["default_duration_min"]) for row in fake_db.rows("formats")}
    assert seeded == {("Keynote", 45), ("Talk", 30), ("Lightning Talk", 15), ("Workshop", 90)}
    assert {row["event_id"] for row in fake_db.rows("formats")} == {event_id}
    assert {row["org_id"] for row in fake_db.rows("formats")} == {TEST_ORG_ID}


def test_create_event_survives_a_failed_format_seed(client, auth_headers, fake_db, monkeypatch):
    """The event is the thing the organizer asked for; formats are editable."""
    from routes import admin_routes

    real_db = admin_routes.db

    async def flaky(fn, label="query"):
        if label == "create_event_default_formats":
            raise RuntimeError("postgrest is having a day")
        return await real_db(fn, label)

    monkeypatch.setattr(admin_routes, "db", flaky)
    response = client.post("/api/events", headers=auth_headers, json={"name": "Summit"})

    assert response.status_code == 201
    assert fake_db.rows("events")[0]["name"] == "Summit"


def test_create_event_suffixes_a_taken_slug(client, auth_headers, seeded_db):
    """events.slug is global: two orgs may both run an 'AI Builders Summit'."""
    response = client.post("/api/events", headers=auth_headers, json={"name": "AI Builders Summit"})

    slug = response.json()["event"]["slug"]
    assert slug.startswith("ai-builders-summit-")
    assert len(slug) == len("ai-builders-summit-") + 4


def test_create_event_rejects_an_impossible_range(client, auth_headers, fake_db):
    response = client.post(
        "/api/events",
        headers=auth_headers,
        json={
            "name": "Summit",
            "starts_at": "2026-10-13T08:00:00Z",
            "ends_at": "2026-10-12T08:00:00Z",
        },
    )
    assert response.status_code == 400
    assert fake_db.rows("events") == []


# ── GET /api/events/{id} ───────────────────────────────────────────────────


def test_get_event(client, auth_headers, seeded_db):
    response = client.get(f"/api/events/{TEST_EVENT_ID}", headers=auth_headers)
    assert response.status_code == 200
    assert response.json()["event"]["slug"] == "ai-builders-summit"


def test_get_another_orgs_event_404s(client, auth_headers, seeded_db):
    assert client.get(f"/api/events/{OTHER_EVENT_ID}", headers=auth_headers).status_code == 404


# ── PATCH /api/events/{id} ─────────────────────────────────────────────────


def test_patch_event(client, auth_headers, seeded_db):
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}",
        headers=auth_headers,
        json={
            "name": "Renamed Summit",
            "timezone": "UTC",
            "location": "Remote",
            "day_start": "07:30",
            "day_end": "19:00",
            "slot_minutes": 30,
        },
    )

    assert response.status_code == 200
    event = response.json()["event"]
    assert event["name"] == "Renamed Summit"
    assert event["day_start"] == "07:30:00"
    assert event["day_end"] == "19:00:00"
    assert event["slot_minutes"] == 30


@pytest.mark.parametrize("slot_minutes", [7, 0, 90])
def test_patch_event_rejects_a_slot_size_the_schema_forbids(
    client, auth_headers, seeded_db, slot_minutes
):
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}",
        headers=auth_headers,
        json={"slot_minutes": slot_minutes},
    )
    assert response.status_code == 400
    assert "slot_minutes" in response.json()["detail"]


def test_patch_event_rejects_an_end_before_an_existing_start(client, auth_headers, seeded_db):
    seeded_db.rows("events")[0]["starts_at"] = "2026-10-12T08:00:00+00:00"
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}",
        headers=auth_headers,
        json={"ends_at": "2026-10-11T08:00:00Z"},
    )
    assert response.status_code == 400


def test_patch_event_can_clear_a_date(client, auth_headers, seeded_db):
    seeded_db.rows("events")[0]["starts_at"] = "2026-10-12T08:00:00+00:00"
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}", headers=auth_headers, json={"starts_at": None}
    )
    assert response.status_code == 200
    assert response.json()["event"]["starts_at"] is None


def test_patch_event_moves_the_public_slug_when_asked(client, auth_headers, seeded_db):
    """The slug IS the event's public identity, so an organizer can change it.

    It used to be pinned, which quietly broke identity: rename "AI Builders
    Summit" and every /e/ link, embed snippet and publish confirmation still
    announced the old name for the rest of the event's life.
    """
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}", headers=auth_headers, json={"slug": "moved-summit"}
    )
    assert response.status_code == 200
    assert response.json()["event"]["slug"] == "moved-summit"
    assert seeded_db.rows("events")[0]["slug"] == "moved-summit"


@pytest.mark.parametrize(
    "bad",
    ["Has Spaces", "trailing-", "-leading", "under_score", "slash/es", "", "   "],
)
def test_patch_event_rejects_a_slug_that_is_not_url_safe(client, auth_headers, seeded_db, bad):
    """Never silently rewritten: a slug the organizer typed is answered, not
    corrected into something they did not choose."""
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}", headers=auth_headers, json={"slug": bad}
    )
    assert response.status_code in (400, 422)
    assert seeded_db.rows("events")[0]["slug"] == "ai-builders-summit"


def test_patch_event_lowercases_a_slug_rather_than_rejecting_the_case(
    client, auth_headers, seeded_db
):
    """Case is the one thing that IS normalised: URLs are case-insensitive by
    convention here, and refusing "AI-Summit" would be pedantry, not safety."""
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}", headers=auth_headers, json={"slug": "  AI-Summit  "}
    )
    assert response.status_code == 200
    assert response.json()["event"]["slug"] == "ai-summit"


def test_patch_event_409s_when_another_event_holds_that_slug(client, auth_headers, seeded_db):
    """Globally unique (migration 001) — including across orgs, which is exactly
    why the collision is a 409 the organizer can act on and not a 500."""
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}", headers=auth_headers, json={"slug": "someone-else"}
    )
    assert response.status_code == 409
    assert seeded_db.rows("events")[0]["slug"] == "ai-builders-summit"


def test_patch_event_accepts_its_own_slug_unchanged(client, auth_headers, seeded_db):
    """Re-saving the settings form without touching the slug is not a collision
    with itself — the uniqueness probe must exempt the row being patched."""
    response = client.patch(
        f"/api/events/{TEST_EVENT_ID}",
        headers=auth_headers,
        json={"name": "Renamed", "slug": "ai-builders-summit"},
    )
    assert response.status_code == 200
    assert response.json()["event"]["slug"] == "ai-builders-summit"
    assert response.json()["event"]["name"] == "Renamed"


def test_patch_another_orgs_event_404s(client, auth_headers, seeded_db):
    response = client.patch(
        f"/api/events/{OTHER_EVENT_ID}", headers=auth_headers, json={"name": "Mine now"}
    )
    assert response.status_code == 404
    assert seeded_db.rows("events")[1]["name"] == "Someone Else's Conf"


def test_patch_event_with_nothing_to_change_400s(client, auth_headers, seeded_db):
    response = client.patch(f"/api/events/{TEST_EVENT_ID}", headers=auth_headers, json={})
    assert response.status_code == 400


# ── GET /api/sessions/{id} ─────────────────────────────────────────────────


@pytest.fixture
def submission_db(seeded_db):
    seeded_db.seed(
        "sessions",
        {
            "id": SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Scaling LLM inference",
            "status": "pending",
            "source_form_id": FORM_ID,
            "form_answers": {F_ABSTRACT: "A practical tour.", F_SPOKEN: True},
            "submitter_contact_id": CONTACT_ID,
        },
    )
    seeded_db.seed(
        "fields",
        {
            "id": F_ABSTRACT,
            "org_id": TEST_ORG_ID,
            "public_name": "Abstract",
            "field_type": "textarea",
            "options": {},
            "required": True,
        },
        {
            "id": F_SPOKEN,
            "org_id": TEST_ORG_ID,
            "public_name": "Have you spoken before?",
            "field_type": "checkbox",
            "options": {},
            "required": False,
        },
    )
    seeded_db.seed(
        "form_fields",
        {
            "id": "ff1",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_ABSTRACT,
            "page": 1,
            "order": 5,
            "label_override": None,
            "required": True,
        },
        {
            "id": "ff2",
            "org_id": TEST_ORG_ID,
            "form_id": FORM_ID,
            "field_id": F_SPOKEN,
            "page": 1,
            "order": 1,
            "label_override": "Spoken before?",
            "required": False,
        },
    )
    seeded_db.seed(
        "session_participants",
        {
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": COSPEAKER_ID,
            "role": "speaker",
            "is_primary": False,
        },
        {
            "org_id": TEST_ORG_ID,
            "session_id": SESSION_ID,
            "contact_id": CONTACT_ID,
            "role": "submitter",
            "is_primary": True,
        },
    )
    seeded_db.seed(
        "contacts",
        {
            "id": CONTACT_ID,
            "org_id": TEST_ORG_ID,
            "first_name": "Ada",
            "last_name": "Lovelace",
            "email": "ada@example.com",
        },
        {
            "id": COSPEAKER_ID,
            "org_id": TEST_ORG_ID,
            "first_name": "Grace",
            "last_name": "Hopper",
            "email": "grace@example.com",
        },
    )
    return seeded_db


def test_get_session_requires_auth(client):
    assert client.get(f"/api/sessions/{SESSION_ID}").status_code == 401


def test_get_session_answers_follow_form_order_with_resolved_labels(
    client, auth_headers, submission_db
):
    body = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()

    assert body["session"]["title"] == "Scaling LLM inference"
    assert body["answers"] == [
        {
            "field_id": F_SPOKEN,
            "label": "Spoken before?",
            "field_type": "checkbox",
            "value": True,
        },
        {
            "field_id": F_ABSTRACT,
            "label": "Abstract",
            "field_type": "textarea",
            "value": "A practical tour.",
        },
    ]


def test_get_session_still_shows_answers_to_removed_fields(client, auth_headers, submission_db):
    """Nothing an applicant wrote disappears because a form was edited later."""
    submission_db.rows("form_fields").pop()  # drop the abstract from the form
    submission_db.rows("sessions")[0]["form_answers"]["ghost"] = "orphaned"

    answers = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()["answers"]

    by_id = {answer["field_id"]: answer for answer in answers}
    assert by_id[F_ABSTRACT]["label"] == "Abstract"
    assert by_id["ghost"] == {
        "field_id": "ghost",
        "label": "ghost",
        "field_type": "text",
        "value": "orphaned",
    }


def test_get_session_participants_put_the_primary_first(client, auth_headers, submission_db):
    participants = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()[
        "participants"
    ]

    assert participants == [
        {
            "contact_id": CONTACT_ID,
            "role": "submitter",
            "is_primary": True,
            "first_name": "Ada",
            "last_name": "Lovelace",
            "email": "ada@example.com",
        },
        {
            "contact_id": COSPEAKER_ID,
            "role": "speaker",
            "is_primary": False,
            "first_name": "Grace",
            "last_name": "Hopper",
            "email": "grace@example.com",
        },
    ]


def test_get_session_without_answers_or_participants(client, auth_headers, seeded_db):
    seeded_db.seed(
        "sessions",
        {
            "id": SESSION_ID,
            "org_id": TEST_ORG_ID,
            "event_id": TEST_EVENT_ID,
            "title": "Bare",
            "form_answers": {},
        },
    )
    body = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()
    assert body["answers"] == []
    assert body["participants"] == []


def test_get_another_orgs_session_404s(client, auth_headers, submission_db):
    submission_db.rows("sessions")[0]["org_id"] = OTHER_ORG_ID
    assert client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).status_code == 404


# ── PATCH /api/sessions/{id} — the central title/abstract editor (CNT-09) ───
# The inbox drawer is where an organizer reads a submission, so it is where they
# fix its title. What must hold: the edit is org-scoped, a title can never be
# emptied, and editing one field never blanks the other.


def test_patch_session_edits_title_and_abstract(client, auth_headers, submission_db):
    response = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=auth_headers,
        json={"title": "  Scaling LLM inference, in practice  ", "description": " A tour.  "},
    )

    assert response.status_code == 200
    session = response.json()["session"]
    assert session["title"] == "Scaling LLM inference, in practice"  # trimmed
    assert session["description"] == "A tour."
    row = submission_db.rows("sessions")[0]
    assert row["title"] == "Scaling LLM inference, in practice"
    assert row["updated_at"]  # the edit stamps the row


def test_session_edits_are_listed_and_restorable(client, auth_headers, submission_db):
    response = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=auth_headers,
        json={"title": "A revised title", "description": "A revised abstract."},
    )
    assert response.status_code == 200

    history = client.get(
        f"/api/sessions/{SESSION_ID}/revisions", headers=auth_headers
    )
    assert history.status_code == 200
    revisions = history.json()["revisions"]
    assert {revision["field"] for revision in revisions} == {"title", "description"}
    assert {revision["actor"] for revision in revisions} == {"Organizer"}

    title_revision = next(revision for revision in revisions if revision["field"] == "title")
    assert title_revision["old_value"] == "Scaling LLM inference"
    assert title_revision["new_value"] == "A revised title"

    restored = client.post(
        f"/api/sessions/{SESSION_ID}/revisions/{title_revision['id']}/restore",
        headers=auth_headers,
    )
    assert restored.status_code == 200
    assert restored.json()["session"]["title"] == "Scaling LLM inference"

    latest = client.get(
        f"/api/sessions/{SESSION_ID}/revisions", headers=auth_headers
    ).json()["revisions"]
    restore_revision = next(
        revision
        for revision in latest
        if revision["field"] == "title"
        and revision["old_value"] == "A revised title"
        and revision["new_value"] == "Scaling LLM inference"
    )
    assert restore_revision["actor"] == "Organizer"


def test_session_edits_and_restore_use_the_acting_users_display_name(client, submission_db):
    headers = {
        "Authorization": f"Bearer {make_token(extra_claims={'name': 'Jordan Alvarez'})}"
    }
    edited = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=headers,
        json={"title": "Jordan's title", "description": "Jordan's abstract"},
    )
    assert edited.status_code == 200

    revisions = client.get(
        f"/api/sessions/{SESSION_ID}/revisions", headers=headers
    ).json()["revisions"]
    assert len(revisions) == 2
    assert {revision["actor"] for revision in revisions} == {"Jordan Alvarez"}
    assert all(revision["created_at"] for revision in revisions)

    title_revision = next(revision for revision in revisions if revision["field"] == "title")
    restored = client.post(
        f"/api/sessions/{SESSION_ID}/revisions/{title_revision['id']}/restore",
        headers=headers,
    )
    assert restored.status_code == 200
    latest = client.get(
        f"/api/sessions/{SESSION_ID}/revisions", headers=headers
    ).json()["revisions"]
    assert latest[0]["actor"] == "Jordan Alvarez"
    assert latest[0]["created_at"]


def test_session_history_is_org_scoped(client, auth_headers, submission_db):
    submission_db.seed(
        "session_revisions",
        {
            "id": "revision-foreign",
            "org_id": OTHER_ORG_ID,
            "session_id": SESSION_ID,
            "field": "title",
            "old_value": "Private",
            "new_value": "Still private",
            "actor": "Organizer",
        },
    )

    history = client.get(
        f"/api/sessions/{SESSION_ID}/revisions", headers=auth_headers
    ).json()["revisions"]
    assert history == []
    assert client.post(
        f"/api/sessions/{SESSION_ID}/revisions/revision-foreign/restore",
        headers=auth_headers,
    ).status_code == 404


def test_session_edit_survives_when_revision_table_is_not_migrated(
    client, auth_headers, submission_db, monkeypatch
):
    from services import session_revisions

    class WithoutRevisionTable:
        def table(self, name):
            if name == "session_revisions":
                raise RuntimeError("relation session_revisions does not exist")
            return submission_db.table(name)

    monkeypatch.setattr(session_revisions, "supabase", WithoutRevisionTable())
    edited = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=auth_headers,
        json={"title": "Saved without migration"},
    )
    assert edited.status_code == 200
    assert submission_db.rows("sessions")[0]["title"] == "Saved without migration"
    history = client.get(
        f"/api/sessions/{SESSION_ID}/revisions", headers=auth_headers
    )
    assert history.status_code == 200
    assert history.json() == {"revisions": []}


def test_patch_status_to_accepted_provisions_onboarding(
    client, auth_headers, submission_db, monkeypatch
):
    """Acceptance means the same thing on every path: flipping status to
    'accepted' via the generic PATCH provisions onboarding exactly like the
    dedicated decision endpoint (idempotent), so the status dropdown can't
    create un-onboarded accepted speakers."""
    calls: list[tuple] = []

    async def _provision(org_id, event_id, session_id):
        calls.append((org_id, event_id, session_id))
        return 6

    from routes import admin_routes

    monkeypatch.setattr(admin_routes, "provision_speaker_onboarding", _provision)

    accepted = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"status": "accepted"}
    )
    assert accepted.status_code == 200
    assert len(calls) == 1 and calls[0][2] == SESSION_ID

    # Already accepted → no re-provisioning; other statuses never provision.
    again = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"status": "accepted"}
    )
    moved = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"status": "pending"}
    )
    assert again.status_code == 200 and moved.status_code == 200
    assert len(calls) == 1


def test_patch_session_accepts_abstract_as_an_alias(client, auth_headers, submission_db):
    """The CFP form and the manual-add dialog both call the column 'abstract'."""
    response = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=auth_headers,
        json={"abstract": "Rewritten by the organizer."},
    )
    assert response.status_code == 200
    assert response.json()["session"]["description"] == "Rewritten by the organizer."


def test_patch_session_title_only_leaves_the_abstract_alone(client, auth_headers, submission_db):
    submission_db.rows("sessions")[0]["description"] = "Untouched."
    response = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"title": "New title"}
    )
    assert response.status_code == 200
    assert submission_db.rows("sessions")[0]["description"] == "Untouched."


def test_patch_session_can_clear_the_abstract(client, auth_headers, submission_db):
    response = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"description": ""}
    )
    assert response.status_code == 200
    assert submission_db.rows("sessions")[0]["description"] == ""


def test_patch_session_can_edit_and_move_in_one_call(client, auth_headers, submission_db):
    response = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=auth_headers,
        json={"title": "Retitled", "status": "accept_queue"},
    )
    assert response.status_code == 200
    session = response.json()["session"]
    assert session["title"] == "Retitled"
    assert session["status"] == "accept_queue"


def test_content_approval_persists_and_remains_in_organizer_surfaces(
    client, auth_headers, submission_db
):
    updated = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=auth_headers,
        json={"content_approval": "in_review"},
    )
    assert updated.status_code == 200
    assert updated.json()["session"]["content_approval"] == "in_review"
    assert submission_db.rows("sessions")[0]["content_approval"] == "in_review"

    detail = client.get(f"/api/sessions/{SESSION_ID}", headers=auth_headers).json()
    assert detail["session"]["content_approval"] == "in_review"
    submissions = client.get(
        f"/api/events/{TEST_EVENT_ID}/submissions", headers=auth_headers
    ).json()["submissions"]
    assert next(row for row in submissions if row["id"] == SESSION_ID)["content_approval"] == "in_review"


def test_content_approval_update_is_org_scoped(client, auth_headers, submission_db):
    submission_db.rows("sessions")[0]["org_id"] = OTHER_ORG_ID
    response = client.patch(
        f"/api/sessions/{SESSION_ID}",
        headers=auth_headers,
        json={"content_approval": "draft"},
    )
    assert response.status_code == 404
    assert submission_db.rows("sessions")[0].get("content_approval") is None


def test_patch_session_rejects_an_empty_title(client, auth_headers, submission_db):
    response = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"title": "   "}
    )
    assert response.status_code == 400
    assert submission_db.rows("sessions")[0]["title"] == "Scaling LLM inference"


def test_patch_session_rejects_an_overlong_title(client, auth_headers, submission_db):
    response = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"title": "x" * 301}
    )
    assert response.status_code == 400  # a readable 400, not pydantic's 422
    assert submission_db.rows("sessions")[0]["title"] == "Scaling LLM inference"


def test_patch_session_rejects_an_overlong_abstract(client, auth_headers, submission_db):
    response = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"description": "x" * 10_001}
    )
    assert response.status_code == 400


def test_patch_session_with_nothing_to_change_400s(client, auth_headers, submission_db):
    assert (
        client.patch(f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={}).status_code
        == 400
    )


def test_patch_another_orgs_session_404s(client, auth_headers, submission_db):
    """A session id from another org is not editable, however valid the payload."""
    submission_db.rows("sessions")[0]["org_id"] = OTHER_ORG_ID
    response = client.patch(
        f"/api/sessions/{SESSION_ID}", headers=auth_headers, json={"title": "Stolen"}
    )
    assert response.status_code == 404
    assert submission_db.rows("sessions")[0]["title"] == "Scaling LLM inference"


def test_patch_session_requires_auth(client, submission_db):
    assert client.patch(f"/api/sessions/{SESSION_ID}", json={"title": "X"}).status_code == 401
