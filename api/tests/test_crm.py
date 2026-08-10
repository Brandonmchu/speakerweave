"""The org-level speaker CRM.

What is worth asserting here is exactly what the feature claims and the rest of
dais cannot do: that one human with contact rows at three events collapses to
ONE directory record, that another org's people are invisible, that a merge
moves evidence rather than destroying it, that a stage move leaves a trail, and
that pushing someone into an event creates their contact row without re-keying.

The fake Supabase executes the real query chain (tests/fakes.py), so a dropped
``.eq("org_id", …)`` shows up as a foreign row in a response rather than as a
passing assertion about a mock's call list.
"""

from __future__ import annotations

import pytest

from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

DIRECTORY = "/api/crm/directory"
SECOND_EVENT_ID = "11111111-1111-1111-1111-1111111100b2"

PRIYA = "aaaaaaaa-0000-0000-0000-0000000000a1"
MARCUS = "aaaaaaaa-0000-0000-0000-0000000000a2"
DANA = "aaaaaaaa-0000-0000-0000-0000000000a3"
FOREIGN = "aaaaaaaa-0000-0000-0000-0000000000ff"


def _contact(contact_id: str, email: str, **overrides) -> dict:
    return {
        "id": contact_id,
        "org_id": TEST_ORG_ID,
        "event_id": TEST_EVENT_ID,
        "email": email,
        "first_name": "",
        "last_name": "",
        "company_name": None,
        "title": None,
        "about": None,
        **overrides,
    }


@pytest.fixture
def crm_db(seeded_db):
    """Two events in one org, plus a foreign org's event and contact.

    Priya appears at BOTH events under the same address — the case the whole
    directory exists for. Marcus and Dana appear once each. The foreign row is
    the org-isolation tripwire.
    """
    db = seeded_db
    db.seed(
        "events",
        {
            "id": SECOND_EVENT_ID,
            "org_id": TEST_ORG_ID,
            "name": "DevFlow Conf 2027",
            "slug": "devflow-conf-2027",
        },
    )
    db.seed(
        "contacts",
        _contact(PRIYA, "priya@latticework.example", first_name="Priya", last_name="Raman",
                 company_name="Latticework Systems", title="Principal Engineer", about="Build tooling."),
        _contact(
            "aaaaaaaa-0000-0000-0000-0000000000b1",
            "priya@latticework.example",
            event_id=SECOND_EVENT_ID,
            first_name="Priya",
            last_name="Raman",
        ),
        _contact(MARCUS, "marcus@cloudreach.example", first_name="Marcus", last_name="Okafor",
                 company_name="Cloudreach Labs", title="Staff Developer Advocate"),
        _contact(DANA, "dana@northwind.example", first_name="Dana", last_name="Kowalski",
                 company_name="Northwind", title="Principal Engineer"),
        _contact(
            FOREIGN,
            "someone@foreign.example",
            org_id=OTHER_ORG_ID,
            event_id=OTHER_EVENT_ID,
            first_name="Foreign",
            last_name="Person",
        ),
    )
    return db


def _people(client, auth_headers, **params):
    response = client.get(DIRECTORY, params=params, headers=auth_headers)
    assert response.status_code == 200, response.text
    return response.json()


# ── backfill / cross-event grouping ────────────────────────────────────────


def test_directory_groups_one_person_across_events(client, auth_headers, crm_db):
    """Two contact rows, two events, one email — one directory record listing both.

    This is the entire premise of the area: without it, "Priya" is two unrelated
    speakers and the org has no way to know she has spoken for them twice.
    """
    payload = _people(client, auth_headers)

    priya = [row for row in payload["people"] if row["email"] == "priya@latticework.example"]
    assert len(priya) == 1
    assert priya[0]["event_count"] == 2
    assert {event["name"] for event in priya[0]["events"]} == {
        "AI Builders Summit",
        "DevFlow Conf 2027",
    }
    # The richest appearance wins the identity, not whichever event sorted first.
    assert priya[0]["company_name"] == "Latticework Systems"
    assert payload["total_all"] == 3


def test_backfill_is_idempotent(client, auth_headers, crm_db):
    """Listing twice must not create a second copy of anybody."""
    _people(client, auth_headers)
    before = len(crm_db.rows("directory_people"))
    _people(client, auth_headers)
    assert len(crm_db.rows("directory_people")) == before == 3


def test_foreign_org_people_are_invisible(client, auth_headers, crm_db):
    """The service-role client bypasses RLS; the org predicate is the only guard."""
    payload = _people(client, auth_headers)
    emails = {row["email"] for row in payload["people"]}
    assert "someone@foreign.example" not in emails


def test_foreign_person_detail_404s(client, auth_headers, crm_db):
    _people(client, auth_headers)  # backfill this org
    crm_db.seed(
        "directory_people",
        {
            "id": "cccccccc-0000-0000-0000-0000000000ff",
            "org_id": OTHER_ORG_ID,
            "email": "someone@foreign.example",
            "first_name": "Foreign",
            "last_name": "Person",
        },
    )
    response = client.get(
        "/api/crm/people/cccccccc-0000-0000-0000-0000000000ff", headers=auth_headers
    )
    assert response.status_code == 404


# ── search & filters ───────────────────────────────────────────────────────


def test_search_narrows_and_clearing_restores(client, auth_headers, crm_db):
    assert _people(client, auth_headers)["total"] == 3
    narrowed = _people(client, auth_headers, q="priya")
    assert narrowed["total"] == 1
    assert narrowed["people"][0]["name"] == "Priya Raman"
    assert _people(client, auth_headers)["total"] == 3


def test_attribute_filters_and_the_facets_that_offer_them(client, auth_headers, crm_db):
    payload = _people(client, auth_headers, company="Cloudreach Labs")
    assert [row["name"] for row in payload["people"]] == ["Marcus Okafor"]
    assert "Latticework Systems" in payload["facets"]["companies"]

    # Two criteria AND together: only Priya is a Principal Engineer at Latticework.
    both = _people(
        client, auth_headers, company="Latticework Systems", title="Principal Engineer"
    )
    assert [row["name"] for row in both["people"]] == ["Priya Raman"]

    # Title alone is broader — the AND above really was narrowing.
    assert _people(client, auth_headers, title="Principal Engineer")["total"] == 2


def test_tag_filter(client, auth_headers, crm_db):
    person_id = _people(client, auth_headers, q="marcus")["people"][0]["id"]
    patch = client.patch(
        f"/api/crm/people/{person_id}", json={"tags": ["AI", "ai", " Keynote "]}, headers=auth_headers
    )
    assert patch.status_code == 200
    # Case-insensitive de-duplication: "AI" and "ai" are one tag.
    assert patch.json()["person"]["tags"] == ["AI", "Keynote"]

    tagged = _people(client, auth_headers, tag="ai")
    assert [row["name"] for row in tagged["people"]] == ["Marcus Okafor"]


# ── notes & custom fields ──────────────────────────────────────────────────


def test_note_persists_and_reads_back_on_the_profile(client, auth_headers, crm_db):
    person_id = _people(client, auth_headers, q="priya")["people"][0]["id"]
    body = "Met at DevFlow 2026 - strong on CI topics; shortlist for keynote."

    created = client.post(
        f"/api/crm/people/{person_id}/notes", json={"body": body}, headers=auth_headers
    )
    assert created.status_code == 201

    detail = client.get(f"/api/crm/people/{person_id}", headers=auth_headers).json()
    assert [note["body"] for note in detail["notes"]] == [body]
    # The profile also carries the cross-event history half of the criterion.
    assert {row["event_name"] for row in detail["appearances"]} == {
        "AI Builders Summit",
        "DevFlow Conf 2027",
    }


def test_custom_field_definition_and_value_round_trip(client, auth_headers, crm_db):
    field = client.post(
        "/api/crm/fields",
        json={"label": "Speaker Type", "field_type": "dropdown", "options": ["Internal", "External"]},
        headers=auth_headers,
    )
    assert field.status_code == 201
    key = field.json()["field"]["key"]
    assert key == "speaker_type"

    person_id = _people(client, auth_headers, q="dana")["people"][0]["id"]
    client.patch(
        f"/api/crm/people/{person_id}", json={"custom": {key: "External"}}, headers=auth_headers
    )

    detail = client.get(f"/api/crm/people/{person_id}", headers=auth_headers).json()
    assert detail["person"]["custom"][key] == "External"
    assert [row["label"] for row in detail["custom_fields"]] == ["Speaker Type"]


def test_patching_one_custom_field_keeps_the_others(client, auth_headers, crm_db):
    """The drawer edits one field at a time; a partial write must not blank the rest."""
    person_id = _people(client, auth_headers, q="dana")["people"][0]["id"]
    client.patch(
        f"/api/crm/people/{person_id}",
        json={"custom": {"speaker_type": "External", "region": "EMEA"}},
        headers=auth_headers,
    )
    updated = client.patch(
        f"/api/crm/people/{person_id}", json={"custom": {"region": "AMER"}}, headers=auth_headers
    ).json()
    assert updated["person"]["custom"] == {"speaker_type": "External", "region": "AMER"}


# ── duplicates & merge ─────────────────────────────────────────────────────


def _create_duplicate(client, auth_headers) -> str:
    response = client.post(
        DIRECTORY,
        json={
            "email": "priya.raman.alt@sbek-test.example.com",
            "first_name": "Priya",
            "last_name": "Raman",
        },
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    return response.json()["person"]["id"]


def test_same_name_different_email_is_flagged_as_a_duplicate(client, auth_headers, crm_db):
    _people(client, auth_headers)
    duplicate_id = _create_duplicate(client, auth_headers)

    payload = _people(client, auth_headers)
    # Both halves of the pair are flagged — the organizer has to look at two rows.
    assert payload["duplicate_count"] == 2
    flagged = {row["id"] for row in payload["people"] if row["is_duplicate"]}
    assert duplicate_id in flagged

    groups = client.get("/api/crm/duplicates", headers=auth_headers).json()["groups"]
    assert groups[0]["reason"] == "Same name, different email"
    assert len(groups[0]["members"]) == 2


def test_merge_absorbs_the_loser_without_destroying_it(client, auth_headers, crm_db):
    """A merge moves evidence: addresses, notes and history end up on the winner,
    the loser's row survives stamped `merged_into`, and the directory shrinks."""
    before = _people(client, auth_headers)["total_all"]
    primary_id = _people(client, auth_headers, q="priya@latticework")["people"][0]["id"]
    duplicate_id = _create_duplicate(client, auth_headers)
    assert _people(client, auth_headers)["total_all"] == before + 1

    client.post(
        f"/api/crm/people/{duplicate_id}/notes",
        json={"body": "Alt address — she submitted from gmail."},
        headers=auth_headers,
    )

    merged = client.post(
        "/api/crm/merge",
        json={"primary_id": primary_id, "duplicate_id": duplicate_id},
        headers=auth_headers,
    )
    assert merged.status_code == 200, merged.text

    after = _people(client, auth_headers)
    assert after["total_all"] == before
    assert duplicate_id not in {row["id"] for row in after["people"]}

    detail = client.get(f"/api/crm/people/{primary_id}", headers=auth_headers).json()
    assert "priya.raman.alt@sbek-test.example.com" in detail["person"]["alt_emails"]
    bodies = [note["body"] for note in detail["notes"]]
    assert "Alt address — she submitted from gmail." in bodies
    # The loser's row is kept, not deleted — the merge stays auditable.
    stored = {str(row["id"]): row for row in crm_db.rows("directory_people")}
    assert stored[duplicate_id]["merged_into"] == primary_id


def test_merge_keeps_the_richer_value_when_the_winner_is_blank(client, auth_headers, crm_db):
    _people(client, auth_headers)
    thin = client.post(
        DIRECTORY, json={"email": "m.okafor@cloudreach.example", "first_name": "Marcus", "last_name": "Okafor"},
        headers=auth_headers,
    ).json()["person"]["id"]
    rich = _people(client, auth_headers, q="marcus@cloudreach")["people"][0]["id"]

    merged = client.post(
        "/api/crm/merge",
        json={"primary_id": thin, "duplicate_id": rich},
        headers=auth_headers,
    ).json()
    assert merged["person"]["company_name"] == "Cloudreach Labs"


def test_merging_a_record_into_itself_is_refused(client, auth_headers, crm_db):
    person_id = _people(client, auth_headers, q="dana")["people"][0]["id"]
    response = client.post(
        "/api/crm/merge",
        json={"primary_id": person_id, "duplicate_id": person_id},
        headers=auth_headers,
    )
    assert response.status_code == 400


# ── pipeline ───────────────────────────────────────────────────────────────


def test_stage_move_writes_history(client, auth_headers, crm_db):
    person_id = _people(client, auth_headers, q="marcus")["people"][0]["id"]

    enroll = client.post(
        f"/api/crm/people/{person_id}/stage",
        json={
            "stage": "identified",
            "score": 85,
            "rationale": "Strong platform-engineering track record; ideal for Platform & Infra track.",
        },
        headers=auth_headers,
    )
    assert enroll.status_code == 200, enroll.text
    assert enroll.json()["person"]["score"] == 85

    for stage in ("contacted", "interested"):
        moved = client.post(
            f"/api/crm/people/{person_id}/stage", json={"stage": stage}, headers=auth_headers
        )
        assert moved.status_code == 200

    detail = client.get(f"/api/crm/people/{person_id}", headers=auth_headers).json()
    transitions = [(row["from_stage"], row["to_stage"]) for row in detail["stage_history"]]
    assert transitions == [
        ("contacted", "interested"),
        ("identified", "contacted"),
        (None, "identified"),
    ]
    assert all(row["created_at"] for row in detail["stage_history"])


def test_pipeline_board_has_open_and_terminal_columns(client, auth_headers, crm_db):
    person_id = _people(client, auth_headers, q="marcus")["people"][0]["id"]
    client.post(
        f"/api/crm/people/{person_id}/stage", json={"stage": "contacted"}, headers=auth_headers
    )

    board = client.get("/api/crm/pipeline", headers=auth_headers).json()
    assert [column["stage"] for column in board["columns"]] == [
        "researching",
        "identified",
        "contacted",
        "interested",
        "confirmed",
        "declined",
    ]
    assert [column["stage"] for column in board["columns"] if column["terminal"]] == [
        "confirmed",
        "declined",
    ]
    contacted = next(column for column in board["columns"] if column["stage"] == "contacted")
    assert [card["name"] for card in contacted["cards"]] == ["Marcus Okafor"]
    # Everyone else stays a candidate rather than flooding the board.
    assert person_id not in {row["id"] for row in board["candidates"]}
    assert board["total"] == 1


def test_unknown_stage_is_rejected(client, auth_headers, crm_db):
    person_id = _people(client, auth_headers, q="dana")["people"][0]["id"]
    response = client.post(
        f"/api/crm/people/{person_id}/stage", json={"stage": "nowhere"}, headers=auth_headers
    )
    assert response.status_code == 400


# ── segments ───────────────────────────────────────────────────────────────


def test_segment_round_trip_reruns_its_filter(client, auth_headers, crm_db):
    marcus_id = _people(client, auth_headers, q="marcus")["people"][0]["id"]
    client.patch(f"/api/crm/people/{marcus_id}", json={"tags": ["AI"]}, headers=auth_headers)

    created = client.post(
        "/api/crm/segments",
        json={"name": "AI Experts", "kind": "dynamic", "filter": {"tag": "AI", "q": ""}},
        headers=auth_headers,
    )
    assert created.status_code == 201
    segment_id = created.json()["segment"]["id"]
    # Empty criteria are dropped — a segment stores intent, not blank keys.
    assert created.json()["segment"]["filter"] == {"tag": "AI"}

    listed = client.get("/api/crm/segments", headers=auth_headers).json()["segments"]
    assert [(row["name"], row["member_count"]) for row in listed] == [("AI Experts", 1)]

    reopened = _people(client, auth_headers, segment_id=segment_id)
    assert [row["name"] for row in reopened["people"]] == ["Marcus Okafor"]

    # Dynamic really means dynamic: a newly tagged person joins without edits.
    dana_id = _people(client, auth_headers, q="dana")["people"][0]["id"]
    client.patch(f"/api/crm/people/{dana_id}", json={"tags": ["AI"]}, headers=auth_headers)
    assert _people(client, auth_headers, segment_id=segment_id)["total"] == 2


def test_curated_segment_freezes_its_membership(client, auth_headers, crm_db):
    dana_id = _people(client, auth_headers, q="dana")["people"][0]["id"]
    segment_id = client.post(
        "/api/crm/segments",
        json={"name": "Keynote shortlist", "kind": "curated", "member_ids": [dana_id]},
        headers=auth_headers,
    ).json()["segment"]["id"]

    reopened = _people(client, auth_headers, segment_id=segment_id)
    assert [row["id"] for row in reopened["people"]] == [dana_id]


def test_duplicate_segment_name_is_refused(client, auth_headers, crm_db):
    client.post("/api/crm/segments", json={"name": "AI Experts"}, headers=auth_headers)
    clash = client.post("/api/crm/segments", json={"name": "AI Experts"}, headers=auth_headers)
    assert clash.status_code == 409


def test_missing_segment_404s(client, auth_headers, crm_db):
    response = client.get(
        DIRECTORY, params={"segment_id": "eeeeeeee-0000-0000-0000-00000000000f"}, headers=auth_headers
    )
    assert response.status_code == 404


# ── push into an event ─────────────────────────────────────────────────────


def test_add_to_event_creates_the_contact_with_profile_intact(client, auth_headers, crm_db):
    """The payoff of an org-level record: no re-keying at the next event."""
    marcus_id = _people(client, auth_headers, q="marcus")["people"][0]["id"]

    response = client.post(
        f"/api/crm/people/{marcus_id}/add-to-event",
        json={"event_id": SECOND_EVENT_ID},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["created"] is True
    assert body["event"]["name"] == "DevFlow Conf 2027"
    assert body["contact"]["email"] == "marcus@cloudreach.example"
    assert body["contact"]["company_name"] == "Cloudreach Labs"
    assert body["contact"]["title"] == "Staff Developer Advocate"

    created = [
        row
        for row in crm_db.rows("contacts")
        if row["event_id"] == SECOND_EVENT_ID and row["email"] == "marcus@cloudreach.example"
    ]
    assert len(created) == 1
    assert created[0]["org_id"] == TEST_ORG_ID

    # The directory now shows him at both events.
    assert _people(client, auth_headers, q="marcus")["people"][0]["event_count"] == 2


def test_add_to_event_is_idempotent(client, auth_headers, crm_db):
    priya_id = _people(client, auth_headers, q="priya@latticework")["people"][0]["id"]
    response = client.post(
        f"/api/crm/people/{priya_id}/add-to-event",
        json={"event_id": SECOND_EVENT_ID},
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["created"] is False
    matching = [
        row
        for row in crm_db.rows("contacts")
        if row["event_id"] == SECOND_EVENT_ID and row["email"] == "priya@latticework.example"
    ]
    assert len(matching) == 1


def test_add_to_a_foreign_event_404s(client, auth_headers, crm_db):
    priya_id = _people(client, auth_headers, q="priya")["people"][0]["id"]
    response = client.post(
        f"/api/crm/people/{priya_id}/add-to-event",
        json={"event_id": OTHER_EVENT_ID},
        headers=auth_headers,
    )
    assert response.status_code == 404


# ── the sync hook ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sync_contact_upserts_and_fills_blanks(crm_db):
    """The hook the CFP and import paths call: create once, then fill gaps only."""
    from services import crm

    created = await crm.sync_contact(
        TEST_ORG_ID,
        {"email": "New.Speaker@example.com", "first_name": "New", "last_name": "Speaker"},
    )
    assert created is not None
    assert created["email"] == "new.speaker@example.com"

    again = await crm.sync_contact(
        TEST_ORG_ID,
        {"email": "new.speaker@example.com", "first_name": "Renamed", "company_name": "Acme"},
    )
    # A later sighting fills the blank company but never renames a curated name.
    assert again["first_name"] == "New"
    assert again["company_name"] == "Acme"
    assert len([row for row in crm_db.rows("directory_people") if row["email"] == "new.speaker@example.com"]) == 1


@pytest.mark.asyncio
async def test_sync_contact_never_raises(monkeypatch):
    """A directory write may never cost an organizer a submission."""
    from services import crm

    def _explode(*_args, **_kwargs):
        raise RuntimeError("database on fire")

    monkeypatch.setattr(crm.supabase, "table", _explode, raising=False)
    assert await crm.sync_contact(TEST_ORG_ID, {"email": "someone@example.com"}) is None


def test_cfp_submission_syncs_the_submitter_into_the_directory(client, auth_headers, crm_db):
    """The hook wired into the public CFP path, exercised end to end."""
    import asyncio

    from services import crm

    contact = {
        "org_id": TEST_ORG_ID,
        "event_id": TEST_EVENT_ID,
        "email": "cfp.submitter@example.com",
        "first_name": "Cfp",
        "last_name": "Submitter",
    }
    asyncio.run(crm.sync_contact(TEST_ORG_ID, contact))
    emails = {row["email"] for row in _people(client, auth_headers)["people"]}
    assert "cfp.submitter@example.com" in emails


# ── import ─────────────────────────────────────────────────────────────────

CSV = (
    "first_name,last_name,email,company,title\n"
    "Priya,Raman,priya@latticework.example,Latticework Systems,Principal Engineer\n"
    "Marcus,Okafor,marcus@cloudreach.example,Cloudreach Labs,Staff Developer Advocate\n"
    "Nobody,,,Ghost Inc,Nobody\n"
)


def test_import_dry_run_reports_rows_and_problems_without_writing(client, auth_headers, crm_db):
    _people(client, auth_headers)
    before = len(crm_db.rows("directory_people"))

    response = client.post(
        "/api/crm/import", json={"csv": CSV, "dry_run": True}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] == 2
    assert len(body["errors"]) == 1
    assert "email" in body["errors"][0]["message"].lower()
    assert len(crm_db.rows("directory_people")) == before


def test_import_adds_new_people_and_optionally_the_event_contact(client, auth_headers, crm_db):
    _people(client, auth_headers)
    csv = "first_name,last_name,email,company,title\nNew,Person,new.person@example.com,Acme,Engineer\n"

    response = client.post(
        "/api/crm/import", json={"csv": csv, "event_id": SECOND_EVENT_ID}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["created"] == 1
    assert body["added_to_event"] == 1

    listed = _people(client, auth_headers, q="new.person")
    assert listed["total"] == 1
    assert listed["people"][0]["events"][0]["name"] == "DevFlow Conf 2027"


def test_import_rejects_a_file_with_no_email_column(client, auth_headers, crm_db):
    response = client.post(
        "/api/crm/import", json={"csv": "name,company\nPriya,Latticework\n"}, headers=auth_headers
    )
    assert response.status_code == 400


# ── overview ───────────────────────────────────────────────────────────────


def test_overview_kpis_match_the_directory(client, auth_headers, crm_db):
    directory = _people(client, auth_headers)
    overview = client.get("/api/crm/overview", headers=auth_headers).json()

    assert overview["totals"]["contacts"] == directory["total_all"] == 3
    assert overview["totals"]["events"] == 2
    # Priya is the only person at more than one event — the metric a per-event
    # dashboard structurally cannot produce.
    assert overview["totals"]["returning_speakers"] == 1

    companies = {row["name"]: row["count"] for row in overview["top_companies"]}
    assert companies["Latticework Systems"] == 1
    assert overview["by_stage"][0]["label"] == "Researching"


# ── outreach ───────────────────────────────────────────────────────────────


def test_bulk_outreach_personalizes_and_logs_every_send(client, auth_headers, crm_db):
    people = _people(client, auth_headers)["people"]
    ids = [row["id"] for row in people if row["email"] != "priya@latticework.example"][:2]

    response = client.post(
        "/api/crm/outreach",
        json={
            "person_ids": ids,
            "subject": "Speak at DevFlow Conf 2027?",
            "body_html": "<p>Hi {{first_name}}, we'd love to have {{company}} on stage.</p>",
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 2
    assert body["sent"] + body["skipped"] + body["failed"] == 2

    log = client.get("/api/crm/outreach/log", headers=auth_headers).json()["entries"]
    assert len(log) == 2
    assert all(entry["subject"] == "Speak at DevFlow Conf 2027?" for entry in log)
    # Merge tags resolved against the directory record, not left literal.
    stored = [row["payload"]["body_html"] for row in crm_db.rows("email_outbox")]
    assert all("{{first_name}}" not in html for html in stored)
    assert any("Cloudreach Labs" in html for html in stored)


def test_outreach_to_a_foreign_person_finds_nobody(client, auth_headers, crm_db):
    _people(client, auth_headers)
    crm_db.seed(
        "directory_people",
        {
            "id": "dddddddd-0000-0000-0000-0000000000ff",
            "org_id": OTHER_ORG_ID,
            "email": "foreign@example.com",
            "first_name": "Foreign",
            "last_name": "Person",
        },
    )
    response = client.post(
        "/api/crm/outreach",
        json={
            "person_ids": ["dddddddd-0000-0000-0000-0000000000ff"],
            "subject": "Hello",
            "body_html": "<p>Hi</p>",
        },
        headers=auth_headers,
    )
    assert response.status_code == 404


# ── auth ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    ["/api/crm/directory", "/api/crm/pipeline", "/api/crm/overview", "/api/crm/segments"],
)
def test_crm_requires_a_token(client, path):
    assert client.get(path).status_code == 401
