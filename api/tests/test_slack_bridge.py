"""Slack event transport, thread continuity, approvals, and delivery tests."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest

from agent import permissions
from agent.service import TurnResult
from routes.slack_routes import _resolve_interactivity, verify_slack_signature
from services import slack_bridge
from services.supabase_helpers import db as real_db
from tests.conftest import TEST_ORG_ID


@pytest.fixture(autouse=True)
def clear_slack_state():
    slack_bridge._SEEN_EVENTS.clear()
    slack_bridge._DISPLAY_NAME_CACHE.clear()
    permissions._PENDING.clear()
    yield
    slack_bridge._SEEN_EVENTS.clear()
    slack_bridge._DISPLAY_NAME_CACHE.clear()
    permissions._PENDING.clear()


def _signed(body: bytes, secret: str, timestamp: int | None = None) -> dict[str, str]:
    sent_at = str(timestamp if timestamp is not None else int(time.time()))
    base = b"v0:" + sent_at.encode("ascii") + b":" + body
    signature = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return {
        "x-slack-request-timestamp": sent_at,
        "x-slack-signature": signature,
    }


def _event_body(event: dict, event_id: str = "Ev-1") -> bytes:
    return json.dumps(
        {"type": "event_callback", "event_id": event_id, "event": event},
        separators=(",", ":"),
    ).encode()


def _interaction_body(
    request_id: str,
    action_id: str = "permission_approve",
    *,
    payload_type: str = "block_actions",
) -> bytes:
    payload = {
        "type": payload_type,
        "actions": [{"action_id": action_id, "value": request_id}],
        "user": {"id": "U1", "username": "brandon"},
        "response_url": "https://hooks.slack.test/actions/1",
    }
    return urlencode({"payload": json.dumps(payload)}).encode()


def test_signature_verification_accepts_valid_and_rejects_invalid_or_stale():
    body = b'{"type":"url_verification","challenge":"abc"}'
    now = 2_000_000_000
    headers = _signed(body, "signing-secret", now)
    assert verify_slack_signature(
        body,
        headers["x-slack-request-timestamp"],
        headers["x-slack-signature"],
        secret="signing-secret",
        now=now,
    )
    assert not verify_slack_signature(
        body,
        headers["x-slack-request-timestamp"],
        "v0=bad",
        secret="signing-secret",
        now=now,
    )
    stale = _signed(body, "signing-secret", now - 301)
    assert not verify_slack_signature(
        body,
        stale["x-slack-request-timestamp"],
        stale["x-slack-signature"],
        secret="signing-secret",
        now=now,
    )


def test_content_type_dispatch_and_signatures_cover_json_and_form(client, monkeypatch):
    secret = "dispatch-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    json_body = json.dumps(
        {"type": "url_verification", "challenge": "prove-it"}
    ).encode()
    json_response = client.post(
        "/api/slack/events",
        content=json_body,
        headers={**_signed(json_body, secret), "content-type": "application/json"},
    )
    assert json_response.json() == {"challenge": "prove-it"}

    form_body = urlencode({"payload": json.dumps({"type": "shortcut"})}).encode()
    form_response = client.post(
        "/api/slack/events",
        content=form_body,
        headers={
            **_signed(form_body, secret),
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
    )
    assert form_response.status_code == 200
    assert form_response.text == ""

    rejected = client.post(
        "/api/slack/events",
        content=form_body,
        headers={
            **_signed(form_body, "wrong-secret"),
            "content-type": "application/x-www-form-urlencoded",
        },
    )
    assert rejected.status_code == 401


def test_unsupported_content_type_is_rejected_before_json_parse(client, monkeypatch):
    secret = "type-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    body = b"not-json"
    response = client.post(
        "/api/slack/events",
        content=body,
        headers={**_signed(body, secret), "content-type": "text/plain"},
    )
    assert response.status_code == 415


def test_event_filtering_only_schedules_mentions_and_direct_messages(client, monkeypatch):
    secret = "filter-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    handled: list[tuple[dict, str, str]] = []

    async def fake_handle(event, org_id, event_id):
        handled.append((event, org_id, event_id))

    monkeypatch.setattr(slack_bridge, "handle_event", fake_handle)
    events = [
        ({"type": "reaction_added", "channel": "C1"}, "Ev-ignore"),
        (
            {
                "type": "app_mention",
                "bot_id": "B1",
                "channel": "C1",
                "ts": "1",
            },
            "Ev-bot",
        ),
        (
            {
                "type": "app_mention",
                "user": "U1",
                "channel": "C1",
                "ts": "2",
                "text": "<@B1> hi",
            },
            "Ev-mention",
        ),
        (
            {
                "type": "message",
                "channel_type": "im",
                "user": "U1",
                "channel": "D1",
                "ts": "3",
                "text": "hi",
            },
            "Ev-dm",
        ),
    ]
    for event, event_id in events:
        body = _event_body(event, event_id)
        response = client.post(
            "/api/slack/events",
            content=body,
            headers={**_signed(body, secret), "content-type": "application/json"},
        )
        assert response.json() == {"ok": True}
    assert [(item[0]["type"], item[2]) for item in handled] == [
        ("app_mention", "Ev-mention"),
        ("message", "Ev-dm"),
    ]
    assert all(item[1] == "org_dev" for item in handled)


async def test_dedupe_ttl_capacity_and_duplicate_skip(monkeypatch):
    clock = 1_000.0
    monkeypatch.setattr(slack_bridge.time, "monotonic", lambda: clock)
    assert await slack_bridge.claim_event("Ev-1")
    assert not await slack_bridge.claim_event("Ev-1")
    for index in range(2, 1_003):
        assert await slack_bridge.claim_event(f"Ev-{index}")
    assert len(slack_bridge._SEEN_EVENTS) == 1_000
    assert "Ev-1" not in slack_bridge._SEEN_EVENTS
    clock += slack_bridge.EVENT_DEDUPE_TTL_SECONDS + 1
    assert await slack_bridge.claim_event("Ev-1002")


async def test_duplicate_handle_event_runs_one_turn(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ASSISTANT_PROVIDER", "anthropic")
    turns: list[dict] = []
    posts: list[str] = []

    async def fake_resolve(_event, _org_id):
        return slack_bridge.SlackThread("thread-1", "1.0", None)

    async def fake_run(**kwargs):
        turns.append(kwargs)
        return TurnResult("complete", "Done", None, "thread-1", "turn-1")

    async def fake_post(**kwargs):
        posts.append(kwargs["text"])

    monkeypatch.setattr(slack_bridge, "resolve_thread", fake_resolve)
    monkeypatch.setattr(slack_bridge, "run_turn", fake_run)
    monkeypatch.setattr(slack_bridge, "post_message", fake_post)
    event = {
        "type": "message",
        "channel_type": "im",
        "channel": "D1",
        "ts": "1.0",
        "user": "U1",
        "text": "hello",
    }
    await slack_bridge.handle_event(event, TEST_ORG_ID, "Ev-once")
    await slack_bridge.handle_event(event, TEST_ORG_ID, "Ev-once")
    assert len(turns) == 1
    assert posts == ["Done"]


async def test_channel_and_thread_mapping_are_org_scoped(fake_db):
    top_level = {
        "type": "app_mention",
        "channel": "C1",
        "ts": "10.0",
        "user": "U1",
    }
    first = await slack_bridge.resolve_thread(top_level, TEST_ORG_ID)
    reply = await slack_bridge.resolve_thread(
        {**top_level, "ts": "10.1", "thread_ts": "10.0"}, TEST_ORG_ID
    )
    assert first.agent_thread_id == reply.agent_thread_id
    assert first.reply_thread_ts == reply.reply_thread_ts == "10.0"
    assert len(fake_db.rows("slack_agent_threads")) == 1
    thread_row = fake_db.rows("agent_threads")[0]
    assert thread_row["org_id"] == TEST_ORG_ID
    assert thread_row["user_id"] == "slack:U1"
    assert thread_row["name"] == "Slack"
    mapping_queries = [
        entry for entry in fake_db.log if entry["table"] == "slack_agent_threads"
    ]
    assert mapping_queries
    assert all(
        entry["op"] == "insert"
        or ("eq", "org_id", TEST_ORG_ID) in entry["filters"]
        for entry in mapping_queries
    )


async def test_top_level_dm_resumes_most_recent_mapping_and_posts_unthreaded(fake_db):
    first = await slack_bridge.resolve_thread(
        {
            "type": "message",
            "channel_type": "im",
            "channel": "D1",
            "ts": "20.0",
            "user": "U1",
        },
        TEST_ORG_ID,
    )
    resumed = await slack_bridge.resolve_thread(
        {
            "type": "message",
            "channel_type": "im",
            "channel": "D1",
            "ts": "21.0",
            "user": "U1",
        },
        TEST_ORG_ID,
    )
    assert resumed.agent_thread_id == first.agent_thread_id
    assert resumed.mapping_thread_ts == "20.0"
    assert resumed.reply_thread_ts is None
    assert len(fake_db.rows("slack_agent_threads")) == 1
    latest_query = next(
        entry
        for entry in fake_db.log
        if entry["table"] == "slack_agent_threads" and entry["orders"]
    )
    assert latest_query["orders"] == [("created_at", True)]
    assert ("eq", "org_id", TEST_ORG_ID) in latest_query["filters"]


async def test_mapping_unique_race_rereads_winner(fake_db, monkeypatch):
    winner_id = "22222222-2222-2222-2222-222222222222"

    class UniqueViolation(Exception):
        code = "23505"

    async def racing_db(fn, label="query"):
        if label == "slack_agent_thread_create":
            fake_db.seed(
                "slack_agent_threads",
                {
                    "org_id": TEST_ORG_ID,
                    "channel_id": "C-race",
                    "thread_ts": "30.0",
                    "channel_type": "channel",
                    "agent_thread_id": winner_id,
                    "created_at": "2026-08-11T10:00:00+00:00",
                },
            )
            raise UniqueViolation("duplicate key value violates unique constraint")
        return await real_db(fn, label)

    monkeypatch.setattr(slack_bridge, "db", racing_db)
    resolved = await slack_bridge.resolve_thread(
        {
            "type": "app_mention",
            "channel": "C-race",
            "ts": "30.0",
            "user": "U1",
        },
        TEST_ORG_ID,
    )
    assert resolved.agent_thread_id == winner_id


def test_mention_stripping_only_drops_the_leading_mention_and_handles_bare():
    assert slack_bridge.strip_leading_mention(" <@UBOT> hello <@U2>") == "hello <@U2>"
    assert slack_bridge.strip_leading_mention("<@UBOT>") == (
        "What can you help me with?"
    )
    assert slack_bridge.strip_leading_mention("hello <@UBOT>") == "hello <@UBOT>"


async def test_channel_attribution_prefix_and_slack_metadata_reach_run_turn(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ASSISTANT_PROVIDER", "anthropic")
    captured: dict = {}

    async def fake_resolve(_event, _org_id):
        return slack_bridge.SlackThread("thread-1", "40.0", "40.0")

    async def fake_name(_user_id):
        return "Brandon Chu"

    async def fake_run(**kwargs):
        captured.update(kwargs)
        return TurnResult("complete", "Hello", None, "thread-1", "turn-1")

    async def fake_post(**_kwargs):
        return None

    monkeypatch.setattr(slack_bridge, "resolve_thread", fake_resolve)
    monkeypatch.setattr(slack_bridge, "slack_display_name", fake_name)
    monkeypatch.setattr(slack_bridge, "run_turn", fake_run)
    monkeypatch.setattr(slack_bridge, "post_message", fake_post)
    await slack_bridge.handle_event(
        {
            "type": "app_mention",
            "channel": "C1",
            "ts": "40.0",
            "user": "U1",
            "text": "<@UBOT> show the schedule",
        },
        TEST_ORG_ID,
        "Ev-meta",
    )
    assert captured["message"] == "Brandon Chu: show the schedule"
    assert captured["user_id"] == "slack:U1"
    assert captured["thread_id"] == "thread-1"
    assert captured["permission_timeout_seconds"] == 300.0
    assert captured["metadata"] == {
        "source": "slack",
        "slack_channel_id": "C1",
        "slack_event_id": "Ev-meta",
    }


async def test_display_name_uses_users_info_cache_and_failure_falls_back(monkeypatch):
    calls: list[str] = []

    async def fake_api(path, payload, *, timeout_seconds):
        calls.append(path)
        assert payload == {"user": "U1"}
        assert timeout_seconds == 5.0
        return {"ok": True, "user": {"profile": {"display_name": "Brandon"}}}

    monkeypatch.setattr(slack_bridge, "_slack_api_post", fake_api)
    assert await slack_bridge.slack_display_name("U1") == "Brandon"
    assert await slack_bridge.slack_display_name("U1") == "Brandon"
    assert calls == ["/users.info"]

    async def broken(*_args, **_kwargs):
        raise RuntimeError("Slack unavailable")

    monkeypatch.setattr(slack_bridge, "_slack_api_post", broken)
    assert await slack_bridge.slack_display_name("U2") is None


async def test_permission_timeout_reads_turn_context_metadata(monkeypatch):
    async def unchanged(_org_id, _tool_name, tool_input):
        return tool_input

    monkeypatch.setattr(permissions, "resolve_display_fields", unchanged)
    queue: asyncio.Queue[dict] = asyncio.Queue()
    allowed, _clean = await permissions.request_permission(
        org_id=TEST_ORG_ID,
        user_id="slack:U1",
        thread_id="thread-1",
        turn_id="turn-1",
        tool_name="decide_submission",
        tool_input={"id": "session-1", "decision": "accept"},
        progress_queue=queue,
        context=SimpleNamespace(metadata={"permission_timeout_seconds": 0.001}),
    )
    assert not allowed
    request, resolution = await queue.get(), await queue.get()
    assert request["type"] == "permission_request"
    assert resolution["approved"] is False


async def test_permission_request_posts_block_kit_card_with_opaque_values(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ASSISTANT_PROVIDER", "anthropic")
    posts: list[dict] = []

    async def fake_resolve(_event, _org_id):
        return slack_bridge.SlackThread("thread-1", "50.0", "50.0")

    async def fake_name(_user_id):
        return None

    async def fake_run(**kwargs):
        await kwargs["on_event"](
            {
                "type": "permission_request",
                "request_id": "opaque-request-id",
                "description": "Publish this event's schedule?",
                "tool_input": {"_submission_display": "SESS-12 — Agent Design"},
            }
        )
        return TurnResult("complete", "Published.", None, "thread-1", "turn-1")

    async def fake_post(**kwargs):
        posts.append(kwargs)

    monkeypatch.setattr(slack_bridge, "resolve_thread", fake_resolve)
    monkeypatch.setattr(slack_bridge, "slack_display_name", fake_name)
    monkeypatch.setattr(slack_bridge, "run_turn", fake_run)
    monkeypatch.setattr(slack_bridge, "post_message", fake_post)
    await slack_bridge.handle_event(
        {
            "type": "app_mention",
            "channel": "C1",
            "ts": "50.0",
            "user": "U1",
            "text": "<@B1> publish",
        },
        TEST_ORG_ID,
        "Ev-permission",
    )
    assert len(posts) == 2
    card = posts[0]
    assert card["thread_ts"] == "50.0"
    assert card["text"] == "Approval needed: Publish this event's schedule?"
    assert [block["type"] for block in card["blocks"]] == ["section", "actions"]
    assert "SESS-12 — Agent Design" in card["blocks"][0]["text"]["text"]
    buttons = card["blocks"][1]["elements"]
    assert [(button["action_id"], button["style"], button["value"]) for button in buttons] == [
        ("permission_approve", "primary", "opaque-request-id"),
        ("permission_deny", "danger", "opaque-request-id"),
    ]
    assert all(set(button) == {"type", "action_id", "text", "style", "value"} for button in buttons)
    assert posts[1]["text"] == "Published."


@pytest.mark.parametrize(
    ("action_id", "approved", "terminal"),
    [
        ("permission_approve", True, "✅ Approved by brandon"),
        ("permission_deny", False, "🚫 Denied by brandon"),
    ],
)
async def test_interactivity_resolves_live_permission_and_replaces_terminal_card(
    monkeypatch, action_id, approved, terminal
):
    async def unchanged(_org_id, _tool_name, tool_input):
        return tool_input

    monkeypatch.setattr(permissions, "resolve_display_fields", unchanged)
    queue: asyncio.Queue[dict] = asyncio.Queue()
    pending = asyncio.create_task(
        permissions.request_permission(
            org_id=TEST_ORG_ID,
            user_id="slack:U1",
            thread_id="thread-1",
            turn_id="turn-1",
            tool_name="decide_submission",
            tool_input={"id": "session-1", "decision": "accept"},
            progress_queue=queue,
            timeout_seconds=2,
        )
    )
    request = await queue.get()
    replacements: list[tuple[str, str]] = []

    async def fake_replace(url, text):
        replacements.append((url, text))

    monkeypatch.setattr(slack_bridge, "replace_permission_card", fake_replace)
    await _resolve_interactivity(
        {
            "type": "block_actions",
            "actions": [
                {"action_id": action_id, "value": request["request_id"]}
            ],
            "user": {"id": "U1", "username": "brandon"},
            "response_url": "https://hooks.slack.test/actions/1",
        },
        TEST_ORG_ID,
    )
    allowed, _clean = await pending
    assert allowed is approved
    assert replacements == [("https://hooks.slack.test/actions/1", terminal)]


def test_interactivity_expired_path_and_validation_chain(client, monkeypatch):
    secret = "expired-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    replacements: list[str] = []

    async def fake_replace(_url, text):
        replacements.append(text)

    monkeypatch.setattr(slack_bridge, "replace_permission_card", fake_replace)
    expired = _interaction_body("unknown-request")
    response = client.post(
        "/api/slack/events",
        content=expired,
        headers={
            **_signed(expired, secret),
            "content-type": "application/x-www-form-urlencoded",
        },
    )
    assert response.text == ""
    for body in (
        _interaction_body("ignored", payload_type="view_submission"),
        _interaction_body("ignored", action_id="unrelated_action"),
    ):
        response = client.post(
            "/api/slack/events",
            content=body,
            headers={
                **_signed(body, secret),
                "content-type": "application/x-www-form-urlencoded",
            },
        )
        assert response.text == ""
    assert replacements == ["This approval was already handled or expired."]


async def test_terminal_card_replacement_has_no_interactive_elements(monkeypatch):
    calls: list[dict] = []

    class FakeResponse:
        def raise_for_status(self):
            return None

    class FakeClient:
        def __init__(self, **kwargs):
            calls.append({"client": kwargs})

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, json):
            calls.append({"url": url, "json": json})
            return FakeResponse()

    monkeypatch.setattr(slack_bridge.httpx, "AsyncClient", FakeClient)
    await slack_bridge.replace_permission_card(
        "https://hooks.slack.test/action", "✅ Approved by Brandon"
    )
    payload = calls[1]["json"]
    assert payload["replace_original"] is True
    assert payload["blocks"] == [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": "✅ Approved by Brandon"},
        }
    ]
    assert "actions" not in json.dumps(payload)


@pytest.mark.parametrize(
    ("status", "message", "expected"),
    [
        ("complete", "**Done**", "**Done**"),
        ("error", "partial", slack_bridge.ERROR_REPLY),
        ("cancelled", "partial", slack_bridge.ERROR_REPLY),
        ("busy", "", slack_bridge.BUSY_REPLY),
    ],
)
async def test_reply_delivery_maps_each_turn_status_once(
    monkeypatch, status, message, expected
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ASSISTANT_PROVIDER", "anthropic")
    posts: list[dict] = []

    async def fake_resolve(_event, _org_id):
        return slack_bridge.SlackThread("thread-1", "60.0", None)

    async def fake_run(**_kwargs):
        return TurnResult(status, message, "failure", "thread-1", "turn-1")

    async def fake_post(**kwargs):
        posts.append(kwargs)

    monkeypatch.setattr(slack_bridge, "resolve_thread", fake_resolve)
    monkeypatch.setattr(slack_bridge, "run_turn", fake_run)
    monkeypatch.setattr(slack_bridge, "post_message", fake_post)
    await slack_bridge.handle_event(
        {
            "type": "message",
            "channel_type": "im",
            "channel": "D1",
            "ts": "60.0",
            "user": "U1",
            "text": "hello",
        },
        TEST_ORG_ID,
        f"Ev-{status}",
    )
    assert posts == [
        {"channel_id": "D1", "thread_ts": None, "text": expected}
    ]


async def test_post_message_converts_mrkdwn_disables_unfurls_and_handles_dm(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    calls: list[dict] = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True}

    class FakeClient:
        def __init__(self, **kwargs):
            calls.append({"client": kwargs})

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, path, *, json):
            calls.append({"path": path, "json": json})
            return FakeResponse()

    monkeypatch.setattr(slack_bridge.httpx, "AsyncClient", FakeClient)
    await slack_bridge.post_message(
        channel_id="D1", thread_ts=None, text="## Done\n- [Open](https://x.io)"
    )
    assert calls[0]["client"]["timeout"] == 15.0
    assert calls[1] == {
        "path": "/chat.postMessage",
        "json": {
            "channel": "D1",
            "text": "*Done*\n• <https://x.io|Open>",
            "unfurl_links": False,
            "unfurl_media": False,
        },
    }


@pytest.mark.parametrize(
    ("provider", "expected_key"),
    [("openai", "OPENAI_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY")],
)
async def test_provider_aware_missing_key_reply(monkeypatch, provider, expected_key):
    monkeypatch.setenv("ASSISTANT_PROVIDER", provider)
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    posts: list[dict] = []

    async def should_not_resolve(*_args, **_kwargs):
        raise AssertionError("missing model configuration must not create a thread")

    async def fake_post(**kwargs):
        posts.append(kwargs)

    monkeypatch.setattr(slack_bridge, "resolve_thread", should_not_resolve)
    monkeypatch.setattr(slack_bridge, "post_message", fake_post)
    await slack_bridge.handle_event(
        {
            "type": "message",
            "channel_type": "im",
            "channel": "D1",
            "ts": "70.0",
            "user": "U1",
            "text": "hello",
        },
        TEST_ORG_ID,
        f"Ev-no-{provider}",
    )
    assert len(posts) == 1
    assert expected_key in posts[0]["text"]


def test_status_is_provider_aware_and_keeps_legacy_fields(
    client, auth_headers, monkeypatch
):
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "secret")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("ASSISTANT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    response = client.get("/api/integrations/slack/status", headers=auth_headers)
    assert response.status_code == 200
    status = response.json()
    assert status["configured"] is True
    assert status["signing_secret_configured"] is True
    assert status["bot_token_configured"] is True
    assert status["anthropic_configured"] is False
    assert status["provider"] == "openai"
    assert status["agent_backed"] is True
    assert status["model_key_configured"] is True
    assert status["default_org"] == "org_dev"
    assert status["source"] == "environment"


def test_slack_manifest_matches_agent_bridge_contract():
    manifest = json.loads((Path(__file__).parents[1] / "slack_manifest.json").read_text())
    assert manifest["oauth_config"]["scopes"]["bot"] == [
        "app_mentions:read",
        "chat:write",
        "im:history",
        "im:read",
        "im:write",
        "users:read",
    ]
    assert manifest["settings"]["event_subscriptions"] == {
        "request_url": "https://speakerweave.com/api/slack/events",
        "bot_events": ["app_mention", "message.im"],
    }
    assert manifest["settings"]["interactivity"] == {
        "is_enabled": True,
        "request_url": "https://speakerweave.com/api/slack/events",
    }
    assert manifest["settings"]["socket_mode_enabled"] is False


def test_slack_source_gets_surface_prompt_overlay():
    from agent.prompt import build_system_prompt

    slack_prompt = build_system_prompt(
        org_id="org_dev",
        user_id="slack:U123",
        metadata={"source": "slack"},
        event=None,
        mcp_connectors_connected=0,
    )
    web_prompt = build_system_prompt(
        org_id="org_dev",
        user_id="user_1",
        metadata={},
        event=None,
        mcp_connectors_connected=0,
    )
    assert "SURFACE" in slack_prompt
    assert "renders in Slack" in slack_prompt
    assert "SURFACE" not in web_prompt
