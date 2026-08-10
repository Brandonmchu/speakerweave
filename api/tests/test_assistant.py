"""In-app assistant history validation, tool audit, and tenant safety."""

from __future__ import annotations

from services import assistant
from services.magic_links import hash_token
from tests.conftest import TEST_ORG_ID


def _tool_use(name: str, arguments: dict) -> dict:
    return {
        "content": [
            {
                "type": "tool_use",
                "id": f"tool-{name}",
                "name": name,
                "input": arguments,
            }
        ]
    }


def test_chat_accepts_org_api_token(client, fake_db, monkeypatch):
    """The companion CLI can use its durable org token without a JWT."""
    raw_token = "dais_cli_assistant_test"
    fake_db.seed(
        "api_tokens",
        {
            "id": "cli-assistant-token",
            "org_id": TEST_ORG_ID,
            "token_hash": hash_token(raw_token),
            "scopes": ["read"],
        },
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")

    response = client.post(
        "/api/assistant/chat",
        headers={"x-access-token": raw_token},
        json={"messages": [{"role": "user", "content": "What needs attention?"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"reply": assistant.WEB_NO_KEY_REPLY, "tool_calls": []}


def test_chat_rejects_invalid_org_api_token(client, fake_db):
    response = client.post(
        "/api/assistant/chat",
        headers={"x-access-token": "dais_not_valid"},
        json={"messages": [{"role": "user", "content": "Hello"}]},
    )

    assert response.status_code == 401


def test_chat_executes_tools_in_jwt_org_and_returns_audit(client, auth_headers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    responses = [
        _tool_use("list_submissions", {"status": "pending"}),
        {"content": [{"type": "text", "text": "There are 4 pending submissions."}]},
    ]
    model_calls: list[dict] = []
    service_calls: list[dict] = []

    async def fake_model(messages, *, key, system_prompt):
        model_calls.append(
            {"messages": messages, "key": key, "system_prompt": system_prompt}
        )
        return responses.pop(0)

    async def fake_list_submissions(
        org_id,
        *,
        event_id,
        status,
        track,
        page,
        page_size,
    ):
        service_calls.append(
            {
                "org_id": org_id,
                "event_id": event_id,
                "status": status,
                "track": track,
                "page": page,
                "page_size": page_size,
            }
        )
        return {"data": [{"id": "session-1", "status": "pending"}], "total": 4}

    monkeypatch.setattr(assistant, "_call_anthropic", fake_model)
    monkeypatch.setattr(assistant.integration_api, "list_submissions", fake_list_submissions)

    response = client.post(
        "/api/assistant/chat",
        headers=auth_headers,
        json={"messages": [{"role": "user", "content": "What's pending?"}]},
    )

    assert response.status_code == 200
    assert response.json() == {
        "reply": "There are 4 pending submissions.",
        "tool_calls": [
            {"name": "list_submissions", "summary": 'status="pending"'}
        ],
    }
    assert service_calls == [
        {
            "org_id": "org_dev",
            "event_id": None,
            "status": "pending",
            "track": None,
            "page": 1,
            "page_size": assistant.integration_api.MAX_PAGE_SIZE,
        }
    ]
    assert model_calls[0]["key"] == "sk-ant-test-not-real"
    assert "inside the organizer app" in model_calls[0]["system_prompt"]


def test_chat_rejects_more_than_thirty_messages(client, auth_headers, monkeypatch):
    async def never_call_model(*_args, **_kwargs):
        raise AssertionError("invalid history must not reach the model")

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    monkeypatch.setattr(assistant, "_call_anthropic", never_call_model)
    response = client.post(
        "/api/assistant/chat",
        headers=auth_headers,
        json={
            "messages": [
                {"role": "user" if index % 2 == 0 else "assistant", "content": str(index)}
                for index in range(31)
            ]
        },
    )

    assert response.status_code == 422


def test_chat_without_anthropic_key_returns_graceful_fallback(
    client, auth_headers, monkeypatch
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")

    async def never_call_model(*_args, **_kwargs):
        raise AssertionError("no-key fallback must not instantiate Anthropic")

    monkeypatch.setattr(assistant, "_call_anthropic", never_call_model)
    response = client.post(
        "/api/assistant/chat",
        headers=auth_headers,
        json={"messages": [{"role": "user", "content": "Help me"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"reply": assistant.WEB_NO_KEY_REPLY, "tool_calls": []}


def test_decide_submission_is_blocked_without_an_explicit_request(
    client, auth_headers, monkeypatch
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    responses = [
        _tool_use("decide_submission", {"id": "session-1", "decision": "accept"}),
        {
            "content": [
                {
                    "type": "text",
                    "text": "I didn't change the submission because you didn't ask me to.",
                }
            ]
        },
    ]
    model_messages: list[list[dict]] = []

    async def fake_model(messages, *, key, system_prompt):
        assert key == "sk-ant-test-not-real"
        assert "decide_submission" in system_prompt
        model_messages.append(messages)
        return responses.pop(0)

    async def never_decide(*_args, **_kwargs):
        raise AssertionError("a non-explicit request must never mutate a decision")

    monkeypatch.setattr(assistant, "_call_anthropic", fake_model)
    monkeypatch.setattr(assistant.integration_api, "decide_submission", never_decide)
    response = client.post(
        "/api/assistant/chat",
        headers=auth_headers,
        json={
            "messages": [
                {"role": "user", "content": "What is the status of session-1?"}
            ]
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "reply": "I didn't change the submission because you didn't ask me to.",
        "tool_calls": [],
    }
    tool_result = model_messages[1][-1]["content"][0]["content"]
    assert "was blocked" in tool_result


def test_decide_submission_runs_after_an_explicit_request(client, auth_headers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    responses = [
        _tool_use("decide_submission", {"id": "session-1", "decision": "accept"}),
        {"content": [{"type": "text", "text": "Session session-1 is accepted."}]},
    ]
    decisions: list[tuple] = []

    async def fake_model(_messages, *, key, system_prompt):
        assert key == "sk-ant-test-not-real"
        assert "decide_submission" in system_prompt
        return responses.pop(0)

    async def fake_decide(org_id, session_id, decision, feedback):
        decisions.append((org_id, session_id, decision, feedback))
        return {"id": session_id, "status": "accepted"}

    monkeypatch.setattr(assistant, "_call_anthropic", fake_model)
    monkeypatch.setattr(assistant.integration_api, "decide_submission", fake_decide)
    response = client.post(
        "/api/assistant/chat",
        headers=auth_headers,
        json={
            "messages": [
                {"role": "user", "content": "Please accept session-1."}
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["tool_calls"] == [
        {
            "name": "decide_submission",
            "summary": 'decision="accept", id="session-1"',
        }
    ]
    assert decisions == [("org_dev", "session-1", "accept", None)]
