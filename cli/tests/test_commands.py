from __future__ import annotations

import json

import httpx
from click.testing import CliRunner

from speakerweave_cli.main import cli

BASE_ARGS = ["--server", "https://conf.example", "--token", "dais_test"]
EVENT = {
    "id": "event-1",
    "name": "Future Forum",
    "slug": "future-forum",
    "starts_at": "2099-06-10T13:00:00Z",
    "ends_at": "2099-06-11T21:00:00Z",
    "timezone": "America/Toronto",
}
SUBMISSION = {
    "id": "submission-1",
    "friendly_id": "SESS-42",
    "title": "Practical Agents",
    "status": "pending",
    "track": {"id": "track-1", "name": "AI"},
    "speakers": [{"id": "speaker-1", "full_name": "Ada Lovelace"}],
}


def _list_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/v1/events":
        return httpx.Response(200, json={"data": [EVENT], "page": 1, "pageSize": 100, "total": 1})
    if request.url.path == "/v1/events/event-1/submissions":
        return httpx.Response(
            200,
            json={"data": [SUBMISSION], "page": 1, "pageSize": 100, "total": 1},
        )
    raise AssertionError(f"Unexpected request: {request.method} {request.url}")


def test_submissions_list_renders_aligned_human_table(mock_http):
    mock_http(_list_handler)

    result = CliRunner().invoke(cli, [*BASE_ARGS, "submissions", "list"])

    assert result.exit_code == 0, result.output
    assert "Future Forum" in result.output
    assert "REF" in result.output and "TITLE" in result.output and "STATUS" in result.output
    assert "SESS-42" in result.output
    assert "Practical Agents" in result.output
    assert "Ada Lovelace" in result.output


def test_submissions_list_json_is_machine_readable(mock_http):
    mock_http(_list_handler)

    result = CliRunner().invoke(cli, [*BASE_ARGS, "submissions", "list", "--json"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == [SUBMISSION]


def test_submission_action_sends_status_and_feedback(mock_http):
    observed = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PATCH"
        assert request.url.path == "/v1/submissions/submission-1"
        observed.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {**SUBMISSION, "status": "accepted"}})

    mock_http(handler)
    result = CliRunner().invoke(
        cli,
        [*BASE_ARGS, "submissions", "accept", "submission-1", "--feedback", "Great fit"],
    )

    assert result.exit_code == 0, result.output
    assert observed == {"status": "accepted", "feedback": "Great fit"}
    assert "SESS-42 → accepted" in result.output


def test_401_maps_to_friendly_exit_one(mock_http):
    mock_http(lambda _request: httpx.Response(401, json={"detail": "nope"}))

    result = CliRunner().invoke(cli, [*BASE_ARGS, "events", "list"])

    assert result.exit_code == 1
    assert "Authentication failed" in result.output
    assert "sw auth login" in result.output


def test_ask_prints_reply_and_used_tools(mock_http):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/assistant/chat"
        assert json.loads(request.content) == {
            "messages": [{"role": "user", "content": "What is still pending?"}]
        }
        return httpx.Response(
            200,
            json={
                "reply": "Four submissions are still pending.",
                "tool_calls": [
                    {"name": "list_submissions", "summary": 'status="pending"'}
                ],
            },
        )

    mock_http(handler)
    result = CliRunner().invoke(cli, [*BASE_ARGS, "ask", "What is still pending?"])

    assert result.exit_code == 0, result.output
    assert "Four submissions are still pending." in result.output
    assert "used tools: list_submissions" in result.output


def test_ask_without_question_is_usage_error():
    result = CliRunner().invoke(cli, [*BASE_ARGS, "ask"])

    assert result.exit_code == 2
    assert "Provide a question or use --interactive" in result.output
