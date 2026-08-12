"""Hosted MCP protocol, auth, discovery, and organization scoping."""

from __future__ import annotations

import json
from typing import Any

import pytest

pytest.importorskip("mcp")

from services.magic_links import hash_token
from tests.conftest import OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID

READ_KEY = "dais_mcp_readkey"
HEADERS = {
    "Authorization": f"Bearer {READ_KEY}",
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}
PROTOCOL_VERSION = "2025-06-18"


class McpAsgiClient:
    """Small protocol client over Starlette's in-process ASGI transport."""

    def __init__(self, client, headers: dict[str, str]) -> None:
        self.client = client
        self.headers = headers
        self.request_id = 0

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict:
        self.request_id += 1
        response = self.client.post(
            "/mcp",
            headers={**self.headers, "MCP-Protocol-Version": PROTOCOL_VERSION},
            json={
                "jsonrpc": "2.0",
                "id": self.request_id,
                "method": method,
                "params": params or {},
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert "error" not in payload, payload
        return payload["result"]

    def initialize(self) -> dict:
        return self.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "dais-tests", "version": "1.0"},
            },
        )


@pytest.fixture
def mcp_db(seeded_db):
    seeded_db.seed(
        "api_tokens",
        {
            "id": "mcp-key",
            "org_id": TEST_ORG_ID,
            "token_hash": hash_token(READ_KEY),
            "scopes": ["read"],
        },
    )
    return seeded_db


def test_mcp_handshake_lists_tools_and_round_trips_org_scoped(client, mcp_db):
    mcp = McpAsgiClient(client, HEADERS)
    initialized = mcp.initialize()
    assert initialized["serverInfo"]["name"] == "dais-conference-management"

    tools = mcp.request("tools/list")["tools"]
    names = {tool["name"] for tool in tools}
    assert names == {
        "list_events",
        "list_submissions",
        "get_submission",
        "decide_submission",
        "list_speakers",
        "get_speaker",
        "invite_speaker_to_portal",
        "list_schedule",
        "place_session",
        "unschedule_session",
        "content_status",
        "remind_outstanding_content",
        "evaluation_summary",
        "ai_triage",
        "get_event_branding",
        "set_event_branding",
    }
    assert all(tool.get("description") for tool in tools)

    result = mcp.request(
        "tools/call", {"name": "list_events", "arguments": {}}
    )
    structured = result["structuredContent"]
    assert [event["id"] for event in structured["data"]] == [TEST_EVENT_ID]
    assert all(event.get("org_id") != OTHER_ORG_ID for event in structured["data"])

    templates = mcp.request("resources/templates/list")["resourceTemplates"]
    assert len(templates) == 4


def test_mcp_branding_tools_and_resource_are_scoped(client, mcp_db):
    mcp = McpAsgiClient(client, HEADERS)
    mcp.initialize()
    definitions = {
        tool["name"]: tool for tool in mcp.request("tools/list")["tools"]
    }
    set_schema = definitions["set_event_branding"]["inputSchema"]
    assert set_schema["properties"]["schedule_layout"]["anyOf"][0]["enum"] == [
        "list",
        "tracks",
        "grid",
    ]

    changed = mcp.request(
        "tools/call",
        {
            "name": "set_event_branding",
            "arguments": {
                "event": TEST_EVENT_ID,
                "accent": "ABCDEF",
                "schedule_layout": "grid",
            },
        },
    )
    assert changed["structuredContent"]["data"]["accent"] == "abcdef"
    assert changed["structuredContent"]["data"]["event_id"] == TEST_EVENT_ID
    write = next(
        entry
        for entry in reversed(mcp_db.log)
        if entry["table"] == "events" and entry["op"] == "update"
    )
    assert ("eq", "org_id", TEST_ORG_ID) in write["filters"]

    resource = mcp.request(
        "resources/read",
        {"uri": f"dais://events/{TEST_EVENT_ID}/branding"},
    )
    document = json.loads(resource["contents"][0]["text"])
    assert document["accent"] == "abcdef"
    assert document["schedule_layout"] == "grid"

    # An omitted argument and an explicit null are indistinguishable in a Python
    # signature, so clearing a value has its own channel. Without it, an MCP
    # client could set a color but never take it back off.
    cleared = mcp.request(
        "tools/call",
        {
            "name": "set_event_branding",
            "arguments": {"event": TEST_EVENT_ID, "reset": ["accent"]},
        },
    )
    assert cleared["structuredContent"]["data"]["accent"] is None
    assert cleared["structuredContent"]["data"]["schedule_layout"] == "grid"

    foreign = mcp.request(
        "tools/call",
        {
            "name": "get_event_branding",
            "arguments": {"event": "11111111-1111-1111-1111-1111111111ff"},
        },
    )
    assert foreign.get("isError") is True


def test_mcp_rejects_bad_bearer_token(client, mcp_db):
    response = client.post(
        "/mcp",
        headers={**HEADERS, "Authorization": "Bearer dais_not_valid"},
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "bad-client", "version": "1.0"},
            },
        },
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Missing or invalid API token"}
    assert response.headers["www-authenticate"].startswith(
        'Bearer resource_metadata="'
    )
    assert response.headers["www-authenticate"].endswith(
        '/.well-known/oauth-protected-resource"'
    )
