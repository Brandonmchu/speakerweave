"""Signed Slack event ingestion and mocked agent replies."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from pathlib import Path

import pytest

from routes.slack_routes import verify_slack_signature
from services import slack_agent


def _signed(body: bytes, secret: str, timestamp: int | None = None) -> dict[str, str]:
    sent_at = str(timestamp if timestamp is not None else int(time.time()))
    base = b"v0:" + sent_at.encode("ascii") + b":" + body
    signature = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return {"x-slack-request-timestamp": sent_at, "x-slack-signature": signature}


def _event_body(event: dict) -> bytes:
    return json.dumps({"type": "event_callback", "event": event}, separators=(",", ":")).encode()


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
    assert not verify_slack_signature(
        body,
        _signed(body, "signing-secret", now - 301)["x-slack-request-timestamp"],
        _signed(body, "signing-secret", now - 301)["x-slack-signature"],
        secret="signing-secret",
        now=now,
    )


def test_url_verification_echoes_challenge(client, monkeypatch):
    secret = "challenge-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    body = json.dumps({"type": "url_verification", "challenge": "prove-it"}).encode()

    response = client.post("/api/slack/events", content=body, headers=_signed(body, secret))

    assert response.status_code == 200
    assert response.json() == {"challenge": "prove-it"}


def test_bad_signature_is_401(client, monkeypatch):
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "right-secret")
    body = _event_body({"type": "app_mention", "text": "hello"})

    response = client.post("/api/slack/events", content=body, headers=_signed(body, "wrong-secret"))

    assert response.status_code == 401


def test_mention_runs_mocked_anthropic_and_posts_threaded_reply(client, monkeypatch):
    secret = "mention-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-not-real")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    model_calls: list[dict] = []
    posted: list[dict] = []

    async def fake_anthropic(messages, *, key):
        model_calls.append({"messages": messages, "key": key})
        return {"content": [{"type": "text", "text": "There are 12 submissions."}]}

    async def fake_post(channel, thread_ts, text):
        posted.append({"channel": channel, "thread_ts": thread_ts, "text": text})

    monkeypatch.setattr(slack_agent, "_call_anthropic", fake_anthropic)
    monkeypatch.setattr(slack_agent, "post_message", fake_post)
    body = _event_body(
        {
            "type": "app_mention",
            "channel": "C123",
            "ts": "171234.500",
            "text": "<@UBOT> how many submissions?",
        }
    )

    response = client.post("/api/slack/events", content=body, headers=_signed(body, secret))

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert len(model_calls) == 1
    assert model_calls[0]["key"] == "sk-ant-test-not-real"
    assert posted == [
        {"channel": "C123", "thread_ts": "171234.500", "text": "There are 12 submissions."}
    ]


def test_bot_messages_are_ignored(client, monkeypatch):
    secret = "bot-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)

    async def explode(*_args, **_kwargs):
        raise AssertionError("bot messages must not start an agent task")

    monkeypatch.setattr(slack_agent, "handle_event", explode)
    body = _event_body(
        {
            "type": "app_mention",
            "bot_id": "B123",
            "channel": "C123",
            "ts": "171234.500",
            "text": "loop",
        }
    )

    response = client.post("/api/slack/events", content=body, headers=_signed(body, secret))

    assert response.status_code == 200


def test_no_anthropic_key_posts_a_graceful_reply(client, monkeypatch):
    secret = "fallback-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    posted: list[str] = []

    async def never_call_model(*_args, **_kwargs):
        raise AssertionError("no-key fallback must not instantiate Anthropic")

    async def fake_post(_channel, _thread_ts, text):
        posted.append(text)

    monkeypatch.setattr(slack_agent, "_call_anthropic", never_call_model)
    monkeypatch.setattr(slack_agent, "post_message", fake_post)
    body = _event_body(
        {
            "type": "message",
            "channel_type": "im",
            "channel": "D123",
            "ts": "171234.500",
            "text": "What is on today?",
        }
    )

    response = client.post("/api/slack/events", content=body, headers=_signed(body, secret))

    assert response.status_code == 200
    assert posted == [slack_agent.NO_KEY_REPLY]


@pytest.mark.asyncio
async def test_agent_executes_tool_use_then_posts_final_text(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    responses = [
        {
            "content": [
                {
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "get_submission",
                    "input": {"id": "session-1"},
                }
            ]
        },
        {"content": [{"type": "text", "text": "The submission is pending."}]},
    ]
    tool_calls: list[tuple[str, str, dict]] = []

    async def fake_anthropic(_messages, *, key):
        assert key == "sk-ant-test-not-real"
        return responses.pop(0)

    async def fake_tool(org_id, name, arguments):
        tool_calls.append((org_id, name, arguments))
        return {"data": {"status": "pending"}}

    monkeypatch.setattr(slack_agent, "_call_anthropic", fake_anthropic)
    monkeypatch.setattr(slack_agent, "run_tool", fake_tool)

    answer = await slack_agent.answer("Check session-1", "org-bound")

    assert answer == "The submission is pending."
    assert tool_calls == [("org-bound", "get_submission", {"id": "session-1"})]


@pytest.mark.asyncio
async def test_slack_http_client_is_mocked_and_posts_to_the_same_thread(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-not-real")
    calls: list[dict] = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True}

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            calls.append({"client": kwargs})

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, path, *, json):
            calls.append({"path": path, "json": json})
            return FakeResponse()

    monkeypatch.setattr(slack_agent.httpx, "AsyncClient", FakeAsyncClient)

    await slack_agent.post_message("C123", "171234.500", "Threaded answer")

    assert calls[1] == {
        "path": "/chat.postMessage",
        "json": {
            "channel": "C123",
            "thread_ts": "171234.500",
            "text": "Threaded answer",
        },
    }


def test_slack_manifest_has_the_required_bot_events_and_scopes():
    manifest = json.loads((Path(__file__).parents[1] / "slack_manifest.json").read_text())

    assert manifest["display_information"]["name"] == "SpeakerWeave"
    assert manifest["settings"]["event_subscriptions"] == {
        "request_url": "https://speakerweave.com/api/slack/events",
        "bot_events": ["app_mention", "message.im"],
    }
    assert manifest["oauth_config"]["scopes"]["bot"] == [
        "app_mentions:read",
        "chat:write",
        "im:history",
        "im:read",
        "im:write",
    ]
