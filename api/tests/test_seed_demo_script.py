from __future__ import annotations

from datetime import datetime, timezone

import jwt

from scripts import mint_dev_token, seed_demo


def test_remap_is_stable_and_default_is_exact() -> None:
    assert seed_demo.remap(seed_demo.EVENT, None) == seed_demo.EVENT
    assert seed_demo.namespace_byte("a") == "aa"
    assert seed_demo.namespace_byte("b") == "ab"
    assert seed_demo.remap(seed_demo.EVENT, "a") == (
        "aa111111-1111-1111-1111-111111111111"
    )
    assert seed_demo.remap(seed_demo.TRACK_ENG, "a").startswith("aa")
    assert seed_demo.remap(seed_demo.TRACK_ENG, "a")[2:] == seed_demo.TRACK_ENG[2:]


def test_replica_prerequisites_and_content_references_are_consistently_scoped() -> None:
    prerequisites = dict(seed_demo._build_prerequisites("a"))
    event = prerequisites["events"][0]
    form = prerequisites["forms"][0]
    question_rule = prerequisites["question_rules"][0]
    session = seed_demo._scope_rows(seed_demo.build_sessions(), "a")[0]

    assert prerequisites["orgs"] == [
        {"org_id": "org_replica_a", "name": "Dais Dev Org"}
    ]
    assert event["id"] == seed_demo.remap(seed_demo.EVENT, "a")
    assert event["org_id"] == "org_replica_a"
    assert event["slug"] == "ai-builders-summit-a"
    assert form["id"] == seed_demo.remap(seed_demo.CFP_FORM, "a")
    assert form["slug"] == "call-for-speakers-a"
    assert question_rule["logic"]["when"][0]["field"] == seed_demo.remap(
        seed_demo.F_SPOKEN, "a"
    )

    assert session["org_id"] == "org_replica_a"
    assert session["event_id"] == event["id"]
    assert session["track_id"] == seed_demo.remap(seed_demo.TRACK_ENG, "a")
    assert session["source_form_id"] == form["id"]
    assert seed_demo.remap(seed_demo.F_ABSTRACT, "a") in session["form_answers"]
    assert seed_demo.F_ABSTRACT not in session["form_answers"]


def test_namespaced_seed_bootstraps_org_and_prints_connection_details(
    fake_db, monkeypatch, capsys
) -> None:
    async def no_extra_assignments(*_args) -> int:
        return 0

    monkeypatch.setattr(seed_demo, "supabase", fake_db)
    monkeypatch.setattr(seed_demo, "provision_speaker_onboarding", no_extra_assignments)
    monkeypatch.setattr(seed_demo, "mint_dev_token", lambda *, org: f"token-for-{org}")

    seed_demo.seed("a")

    assert len(fake_db.rows("orgs")) == 1
    assert fake_db.rows("orgs")[0]["org_id"] == "org_replica_a"
    assert fake_db.rows("orgs")[0]["name"] == "Dais Dev Org"
    assert fake_db.rows("events")[0]["slug"] == "ai-builders-summit-a"
    assert fake_db.rows("forms")[0]["slug"] == "call-for-speakers-a"
    assert all(row["org_id"] == "org_replica_a" for row in fake_db.rows("contacts"))
    assert all(
        row["event_id"] == seed_demo.remap(seed_demo.EVENT, "a")
        for row in fake_db.rows("sessions")
    )

    inserts = fake_db.tables_touched("insert")
    assert inserts.index("orgs") < inserts.index("events") < inserts.index("contacts")
    output = capsys.readouterr().out
    assert "org id: org_replica_a" in output
    assert "event slug: ai-builders-summit-a" in output
    assert "dev token: token-for-org_replica_a" in output


def test_reset_deletes_content_before_assignments_and_only_drops_replica_org(
    fake_db, monkeypatch
) -> None:
    monkeypatch.setattr(seed_demo, "supabase", fake_db)

    seed_demo.reset()
    default_deletes = fake_db.tables_touched("delete")
    assert default_deletes[:2] == ["content_comments", "files"]
    assert default_deletes.index("files") < default_deletes.index("task_assignments")
    assert "orgs" not in default_deletes

    fake_db.log.clear()
    seed_demo.reset("b")
    replica_deletes = fake_db.tables_touched("delete")
    assert replica_deletes[:2] == ["content_comments", "files"]
    assert replica_deletes.index("files") < replica_deletes.index("task_assignments")
    assert replica_deletes[-1] == "orgs"
    org_delete = next(
        entry
        for entry in fake_db.log
        if entry["table"] == "orgs" and entry["op"] == "delete"
    )
    assert ("eq", "org_id", "org_replica_b") in org_delete["filters"]


def test_content_subcommand_forwards_namespace(monkeypatch, capsys) -> None:
    seen = []
    monkeypatch.setattr(
        seed_demo,
        "seed_content_files",
        lambda namespace=None: seen.append(namespace) or 3,
    )

    assert seed_demo.main(["seed_demo", "content", "--namespace", "a"]) == 0
    assert seen == ["a"]
    assert "content: 3 file version(s) written" in capsys.readouterr().out


def test_importable_token_minter_uses_requested_org() -> None:
    issued_at = datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc)
    token = mint_dev_token.mint_dev_token(
        org="org_replica_a",
        sub="replica_tester",
        name="Jordan Alvarez",
        hours=2,
        secret="test-secret",
        now=issued_at,
    )

    claims = jwt.decode(
        token,
        "test-secret",
        algorithms=["HS256"],
        audience="authenticated",
        options={"verify_exp": False},
    )
    assert claims["org_id"] == "org_replica_a"
    assert claims["sub"] == "replica_tester"
    assert claims["name"] == "Jordan Alvarez"
    assert claims["exp"] - claims["iat"] == 2 * 60 * 60
