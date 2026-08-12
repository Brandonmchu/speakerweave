"""Frozen chat-agent contract, safety gates, tenancy, and harness tests."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent import context_search, mcp_connectors, permissions, threads, titles, tools
from agent.events import PUBLIC_EVENT_TYPES, format_sse_event
from agent.router import (
    _ACTIVE_TURNS,
    ActiveTurn,
    assistant_enabled,
    cancel_turn,
    claim_turn,
    release_turn,
    resolve_provider,
)
from agent.router import (
    router as agent_router,
)
from agent.tools import TurnContext
from auth import get_current_user_or_api_org
from services import assistant
from tests.conftest import OTHER_EVENT_ID, OTHER_ORG_ID, TEST_EVENT_ID, TEST_ORG_ID


@pytest.fixture(autouse=True)
def clear_agent_registries():
    permissions._PENDING.clear()
    _ACTIVE_TURNS.clear()
    mcp_connectors._OAUTH_ATTEMPTS.clear()
    yield
    permissions._PENDING.clear()
    _ACTIVE_TURNS.clear()
    mcp_connectors._OAUTH_ATTEMPTS.clear()


def _context(
    *, thread_id: str = "11111111-1111-1111-1111-111111111111", turn_id: str = "turn"
) -> TurnContext:
    return TurnContext(
        org_id=TEST_ORG_ID,
        user_id="dev_user",
        thread_id=thread_id,
        turn_id=turn_id,
        metadata={"pathname": "/dashboard", "timezone": "UTC"},
        progress_queue=asyncio.Queue(),
        cancel_event=asyncio.Event(),
    )


def _test_app() -> FastAPI:
    app = FastAPI()
    app.include_router(agent_router)

    async def auth_override() -> tuple[str, str]:
        return "dev_user", TEST_ORG_ID

    app.dependency_overrides[get_current_user_or_api_org] = auth_override
    return app


def _sse_events(body: str) -> list[dict[str, Any]]:
    return [
        json.loads(frame.removeprefix("data: "))
        for frame in body.split("\n\n")
        if frame.startswith("data: ")
    ]


def test_sse_frame_format_and_public_vocabulary_match_frozen_contract():
    expected = {
        "thread_started",
        "message_delta",
        "message_complete",
        "progress",
        "reasoning",
        "permission_request",
        "permission_resolved",
        "navigate",
        "entity_update",
        "thread_update",
        "complete",
        "error",
        "cancelled",
        "keepalive",
    }
    assert PUBLIC_EVENT_TYPES == expected
    assert format_sse_event("message_delta", {"message": "Hello"}) == (
        'data: {"type": "message_delta", "message": "Hello"}\n\n'
    )
    with pytest.raises(ValueError):
        format_sse_event("stream_done")


@pytest.mark.parametrize("approved", [True, False])
async def test_permission_gate_approve_and_deny_paths(monkeypatch, approved):
    async def resolved(_org_id, _tool_name, tool_input):
        return {**tool_input, "_submission_display": "SESS-12 — Agent Design"}

    monkeypatch.setattr(permissions, "resolve_display_fields", resolved)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    pending_task = asyncio.create_task(
        permissions.request_permission(
            org_id=TEST_ORG_ID,
            user_id="dev_user",
            thread_id="thread-1",
            turn_id="turn-1",
            tool_name="decide_submission",
            tool_input={"id": "session-1", "decision": "accept"},
            progress_queue=queue,
            timeout_seconds=1,
        )
    )
    request = await asyncio.wait_for(queue.get(), 1)
    assert request["type"] == "permission_request"
    assert request["tool_input"]["_submission_display"] == "SESS-12 — Agent Design"
    assert "SESS-12 — Agent Design" in request["description"]
    assert await permissions.resolve_permission(
        request["request_id"], TEST_ORG_ID, approved
    )

    allowed, clean_input = await pending_task
    assert allowed is approved
    assert clean_input == {"id": "session-1", "decision": "accept"}
    assert await queue.get() == {
        "type": "permission_resolved",
        "request_id": request["request_id"],
        "approved": approved,
    }


async def test_permission_gate_timeout_is_a_model_visible_denial(monkeypatch):
    async def unchanged(_org_id, _tool_name, tool_input):
        return tool_input

    monkeypatch.setattr(permissions, "resolve_display_fields", unchanged)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    allowed, clean_input = await permissions.request_permission(
        org_id=TEST_ORG_ID,
        user_id="dev_user",
        thread_id="thread-1",
        turn_id="turn-1",
        tool_name="decide_submission",
        tool_input={"id": "session-1", "decision": "decline"},
        progress_queue=queue,
        timeout_seconds=0.001,
    )
    assert not allowed
    assert clean_input["decision"] == "decline"
    assert [await queue.get(), await queue.get()][1]["approved"] is False
    assert json.loads(permissions.denied_tool_result("decide_submission")) == {
        "error": "Permission to run decide_submission was denied or expired.",
        "denied": True,
    }


async def test_permission_label_resolution_is_org_scoped(fake_db):
    fake_db.seed(
        "sessions",
        {
            "id": "session-ours",
            "org_id": TEST_ORG_ID,
            "friendly_id": "SESS-12",
            "title": "Agent Design",
        },
        {
            "id": "session-theirs",
            "org_id": OTHER_ORG_ID,
            "friendly_id": "SESS-99",
            "title": "Secret Session",
        },
    )
    resolved = await permissions.resolve_display_fields(
        TEST_ORG_ID,
        "decide_submission",
        {"id": "session-ours", "decision": "accept"},
    )
    assert resolved["_submission_display"] == "SESS-12 — Agent Design"
    query = fake_db.log[-1]
    assert ("eq", "org_id", TEST_ORG_ID) in query["filters"]


def test_permission_policy_covers_dais_and_external_mcp_mutations():
    assert permissions.permission_action_for_tool("decide_submission") == (
        "DECIDE_SUBMISSION"
    )
    assert permissions.permission_action_for_tool("publish_schedule") == (
        "PUBLISH_SCHEDULE"
    )
    assert permissions.permission_action_for_tool("set_event_branding") == (
        "UPDATE_BRANDING"
    )
    assert permissions.permission_description(
        "UPDATE_BRANDING", "set_event_branding", {"event": TEST_EVENT_ID}
    ) == "Update this event's branding?"
    assert permissions.permission_action_for_tool("send_communication") == "SEND_EMAIL"
    assert permissions.permission_action_for_tool("delete_form") == "DELETE"
    assert permissions.permission_action_for_tool("mcp__every__create_proposal") == (
        "EXTERNAL_MCP_ACTION"
    )
    assert permissions.permission_action_for_tool("mcp__every__list_invoices") is None
    assert permissions.permission_action_for_tool("mcp__crm__find_contact") is None
    assert permissions.permission_action_for_tool("mcp__crm__update_contact") == (
        "EXTERNAL_MCP_ACTION"
    )
    assert permissions.permission_description(
        "EXTERNAL_MCP_ACTION",
        "mcp__crm__update_contact",
        {"_connector_name": "Sales CRM"},
    ) == "Allow Sales CRM to run update_contact?"
    assert permissions.permission_action_for_tool("list_submissions") is None


async def test_turn_claim_rejects_second_live_turn_and_cancel_checks_turn_id():
    first = ActiveTurn("thread-1", "turn-1", _context(thread_id="thread-1", turn_id="turn-1"))
    second = ActiveTurn("thread-1", "turn-2", _context(thread_id="thread-1", turn_id="turn-2"))
    assert await claim_turn(first)
    assert not await claim_turn(second)
    assert not await cancel_turn("thread-1", "turn-wrong")
    assert await cancel_turn("thread-1", "turn-1")
    assert first.context.cancel_event.is_set()
    await release_turn("thread-1", "turn-1")
    assert await claim_turn(second)


async def test_new_tool_registry_handler_parity_and_navigation_validation():
    assert tools.BASE_TOOLS is assistant.TOOLS
    base_names = {definition["name"] for definition in assistant.TOOLS}
    assert base_names <= {definition["name"] for definition in tools.TOOL_REGISTRY}
    new_names = {definition["name"] for definition in tools.NEW_TOOLS}
    assert new_names == {*tools.LOCAL_TOOL_HANDLERS, "navigate_user_to_page"}

    context = _context()
    assert await tools.navigate_user_to_page(
        context, "/submissions?open=session-1", "Agent Design"
    ) == "Navigated user to Agent Design"
    assert await context.progress_queue.get() == {
        "type": "navigate",
        "route": "/submissions?open=session-1",
        "label": "Agent Design",
    }
    rejected = await tools.navigate_user_to_page(
        context, "https://evil.example/settings", "Settings"
    )
    assert isinstance(rejected, dict) and "error" in rejected
    assert tools.is_valid_navigation_route("/forms/form-1")
    assert tools.is_valid_navigation_route("/forms")

    definitions = {definition["name"]: definition for definition in tools.NEW_TOOLS}
    schema = definitions["set_event_branding"]["input_schema"]
    assert schema["additionalProperties"] is False
    assert schema["properties"]["schedule_layout"]["enum"] == [
        "list",
        "tracks",
        "grid",
    ]
    assert "6 hex digits, no #" in schema["properties"]["accent"]["description"]


async def test_branding_tool_handlers_are_org_scoped(seeded_db):
    result = await tools._set_event_branding(
        TEST_ORG_ID,
        {"event": TEST_EVENT_ID, "accent": "ABCDEF", "radius": "large"},
    )
    assert result["data"]["accent"] == "abcdef"
    assert result["data"]["event_id"] == TEST_EVENT_ID
    write = next(
        entry
        for entry in reversed(seeded_db.log)
        if entry["table"] == "events" and entry["op"] == "update"
    )
    assert ("eq", "org_id", TEST_ORG_ID) in write["filters"]

    with pytest.raises(Exception) as caught:
        await tools._get_event_branding(TEST_ORG_ID, {"event": OTHER_EVENT_ID})
    assert getattr(caught.value, "status_code", None) == 404


async def test_entity_updates_are_deterministic_and_deduplicated():
    context = _context()
    result = {
        "data": {
            "id": "session-1",
            "friendly_id": "SESS-12",
            "title": "Agent Design",
        }
    }
    await tools._emit_entity_update(
        context, "decide_submission", {"id": "session-1"}, result
    )
    await tools._emit_entity_update(
        context, "decide_submission", {"id": "session-1"}, result
    )
    assert context.activity == [
        {
            "entity_type": "submission",
            "entity_id": "session-1",
            "change_type": "updated",
            "display": "SESS-12 — Agent Design",
        }
    ]
    assert await context.progress_queue.get() == {
        "type": "entity_update",
        **context.activity[0],
    }
    assert context.progress_queue.empty()


async def test_context_search_is_org_scoped_and_type_filtered(fake_db):
    fake_db.seed(
        "sessions",
        {
            "id": "session-ours",
            "org_id": TEST_ORG_ID,
            "friendly_id": "SESS-12",
            "title": "Agent Design Keynote",
            "status": "pending",
        },
        {
            "id": "session-theirs",
            "org_id": OTHER_ORG_ID,
            "friendly_id": "SESS-99",
            "title": "Agent Design Secret",
            "status": "pending",
        },
    )
    results = await context_search.search_context(
        TEST_ORG_ID, "Agent Design", "submission"
    )
    assert results == [
        {
            "type": "submission",
            "id": "session-ours",
            "display": "SESS-12 — Agent Design Keynote",
            "sublabel": "pending",
        }
    ]
    selects = [entry for entry in fake_db.log if entry["op"] == "select"]
    assert {entry["table"] for entry in selects} == {"sessions"}
    assert all(("eq", "org_id", TEST_ORG_ID) in entry["filters"] for entry in selects)
    assert await context_search.search_context(TEST_ORG_ID, "a", None) == []


@pytest.mark.parametrize(
    ("openai_key", "anthropic_key", "flag", "provider_env", "enabled", "provider"),
    [
        ("", "", "", "", False, None),
        ("sk-openai", "", "", "", True, "openai"),
        ("", "sk-anthropic", "", "", True, "anthropic"),
        ("sk-openai", "sk-anthropic", "false", "openai", False, None),
        ("sk-openai", "sk-anthropic", "", "anthropic", True, "anthropic"),
    ],
)
def test_capabilities_on_off_matrix(
    monkeypatch,
    openai_key,
    anthropic_key,
    flag,
    provider_env,
    enabled,
    provider,
):
    monkeypatch.setenv("OPENAI_API_KEY", openai_key)
    monkeypatch.setenv("ANTHROPIC_API_KEY", anthropic_key)
    monkeypatch.setenv("ASSISTANT_ENABLED", flag)
    monkeypatch.setenv("ASSISTANT_PROVIDER", provider_env)
    assert assistant_enabled() is enabled
    assert (resolve_provider() if enabled else None) == provider

    async def disconnected(_org_id):
        return 0

    monkeypatch.setattr("agent.router.mcp_connectors.connected_count", disconnected)
    with TestClient(_test_app()) as client:
        response = client.get("/api/agent/capabilities")
        assert response.status_code == 200
        assert response.json() == {
            "assistant": enabled,
            "provider": provider,
            "mcp": {"available": True, "connectors_connected": 0},
        }
        if not enabled:
            assert client.get("/api/agent/threads").status_code == 404


def test_title_generation_only_runs_for_first_reply_on_default_thread():
    assert titles.should_generate_title("Chat", [{"role": "user", "content": "Hi"}])
    assert not titles.should_generate_title(
        "Chat",
        [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello"},
        ],
    )
    assert not titles.should_generate_title(
        "Speaker pipeline", [{"role": "user", "content": "Hi"}]
    )


async def test_mcp_oauth_discovery_pkce_exchange_and_state_maps_to_connector(
    monkeypatch, fake_db
):
    requests: list[tuple[str, str, dict[str, Any]]] = []

    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url):
            requests.append(("GET", url, {}))
            if url.endswith("/.well-known/oauth-protected-resource"):
                return FakeResponse(
                    {"authorization_servers": ["https://auth.every.test"]}
                )
            return FakeResponse(
                {
                    "registration_endpoint": "https://auth.every.test/register",
                    "authorization_endpoint": "https://auth.every.test/authorize",
                    "token_endpoint": "https://auth.every.test/token",
                }
            )

        async def post(self, url, **kwargs):
            requests.append(("POST", url, kwargs))
            if url.endswith("/register"):
                return FakeResponse({"client_id": "speakerweave-client"})
            return FakeResponse(
                {
                    "access_token": "every-access-token",
                    "refresh_token": "every-refresh-token",
                    "expires_in": 3600,
                    "email": "owner@example.com",
                }
            )

    monkeypatch.setenv("EVERY_MCP_URL", "https://mcp.every.test/mcp")
    monkeypatch.setenv("PUBLIC_API_URL", "https://api.speakerweave.test")
    monkeypatch.setenv("PUBLIC_WEB_URL", "https://speakerweave.test")
    monkeypatch.setattr(mcp_connectors.httpx, "AsyncClient", FakeClient)

    authorize_url = await mcp_connectors.begin_connect(TEST_ORG_ID, "dev_user", "every")
    parsed = urlsplit(authorize_url)
    query = parse_qs(parsed.query)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == (
        "https://auth.every.test/authorize"
    )
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["code_challenge"][0]) == 43
    assert query["state"][0] not in mcp_connectors._OAUTH_ATTEMPTS
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    from agent.router import mcp_connector_callback

    class _FakeCallbackRequest:
        def __init__(self) -> None:
            self.base_url = "http://testserver/"
            self.headers: dict[str, str] = {}

    callback = await mcp_connector_callback(
        _FakeCallbackRequest(), "authorization-code", query["state"][0]
    )
    assert callback.status_code == 302
    assert callback.headers["location"].endswith("/settings?mcp=connected:every")
    assert callback.headers["location"].startswith("http")

    stored = fake_db.rows("org_integrations")
    assert len(stored) == 1
    assert stored[0]["org_id"] == TEST_ORG_ID
    assert stored[0]["provider"] == "mcp_connector"
    assert stored[0]["kind"] == "mcp_connector:every"
    assert stored[0]["config"]["tokens"]["access_token"] == "every-access-token"
    listed = await mcp_connectors.list_connectors(TEST_ORG_ID)
    assert listed[0]["key"] == "every"
    assert listed[0]["connected"] is True
    assert "tokens" not in listed[0]
    registration = next(item for item in requests if item[1].endswith("/register"))
    assert registration[2]["json"]["redirect_uris"] == [
        "https://api.speakerweave.test/api/agent/integrations/mcp/callback",
        "https://speakerweave.test/api/agent/integrations/mcp/callback",
    ]


async def test_mcp_preset_catalog_merges_environment_and_connection(monkeypatch, fake_db):
    monkeypatch.setenv("EVERY_MCP_URL", "")
    assert await mcp_connectors.list_connectors(TEST_ORG_ID) == []

    monkeypatch.setenv("EVERY_MCP_URL", "https://mcp.every.test/mcp")
    available = await mcp_connectors.list_connectors(TEST_ORG_ID)
    assert available == [
        {
            "key": "every",
            "name": "Every",
            "url": "https://mcp.every.test/mcp",
            "auth_kind": "oauth",
            "preset": True,
            "connected": False,
            "status": "disconnected",
            "description": "Business tools: proposals, invoices, clients",
        }
    ]

    fake_db.seed(
        "org_integrations",
        {
            "org_id": TEST_ORG_ID,
            "provider": "mcp_connector",
            "kind": "mcp_connector:every",
            "config": {
                "key": "every",
                "name": "Stale name",
                "url": "https://stale.test/mcp",
                "auth_kind": "oauth",
                "status": "connected",
                "connected_at": "2026-08-10T14:00:00+00:00",
                "tokens": {"access_token": "secret-access"},
            },
        },
    )
    connected = (await mcp_connectors.list_connectors(TEST_ORG_ID))[0]
    assert connected["name"] == "Every"
    assert connected["url"] == "https://mcp.every.test/mcp"
    assert connected["connected"] is True
    assert "tokens" not in connected


def test_custom_mcp_crud_validates_live_and_never_returns_secrets(monkeypatch, fake_db):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    pings: list[tuple[str, dict[str, str]]] = []

    async def valid(url, headers):
        pings.append((url, dict(headers)))

    monkeypatch.setattr(mcp_connectors, "validate_connection", valid)
    with TestClient(_test_app()) as client:
        created = client.post(
            "/api/agent/integrations/mcp",
            json={
                "name": "Sales CRM",
                "url": "https://crm.example.com/mcp",
                "auth_kind": "bearer",
                "bearer_token": "super-secret-token",
            },
        )
        assert created.status_code == 200
        assert created.json()["key"] == "sales-crm"
        assert created.json()["connected"] is True
        assert "super-secret-token" not in created.text
        assert pings == [
            (
                "https://crm.example.com/mcp",
                {"Authorization": "Bearer super-secret-token"},
            )
        ]

        listed = client.get("/api/agent/integrations/mcp")
        assert listed.status_code == 200
        assert listed.json()["connectors"][0]["name"] == "Sales CRM"
        assert "super-secret-token" not in listed.text
        assert "bearer_token" not in listed.text
        assert "tokens" not in listed.text

        removed = client.delete("/api/agent/integrations/mcp/sales-crm")
        assert removed.status_code == 200
        assert client.get("/api/agent/integrations/mcp").json() == {"connectors": []}

    writes = [entry for entry in fake_db.log if entry["table"] == "org_integrations"]
    assert writes
    assert all(("eq", "org_id", TEST_ORG_ID) in entry["filters"] for entry in writes if entry["op"] != "insert")


def test_custom_mcp_validation_failure_is_422_and_not_persisted(monkeypatch, fake_db):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")

    async def invalid(_url, _headers):
        raise RuntimeError("tools/list rejected the credential")

    monkeypatch.setattr(mcp_connectors, "validate_connection", invalid)
    with TestClient(_test_app()) as client:
        response = client.post(
            "/api/agent/integrations/mcp",
            json={
                "name": "Broken CRM",
                "url": "https://crm.example.com/mcp",
                "auth_kind": "none",
            },
        )
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "MCP validation failed: tools/list rejected the credential"
    )
    assert fake_db.rows("org_integrations") == []


def test_custom_mcp_rejects_insecure_remote_url(monkeypatch, fake_db):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    with TestClient(_test_app()) as client:
        response = client.post(
            "/api/agent/integrations/mcp",
            json={
                "name": "Remote",
                "url": "http://crm.example.com/mcp",
                "auth_kind": "none",
            },
        )
    assert response.status_code == 422
    assert "HTTPS" in response.json()["detail"]
    assert fake_db.rows("org_integrations") == []


async def test_runtime_attach_isolates_broken_connector_and_keeps_healthy_tools(
    monkeypatch, fake_db
):
    import agents.mcp

    for key, name in (("broken", "Broken CRM"), ("healthy", "Healthy CRM")):
        fake_db.seed(
            "org_integrations",
            {
                "org_id": TEST_ORG_ID,
                "provider": "mcp_connector",
                "kind": f"mcp_connector:{key}",
                "config": {
                    "key": key,
                    "name": name,
                    "url": f"https://{key}.example.com/mcp",
                    "auth_kind": "none",
                    "status": "connected",
                    "tokens": {},
                    "bearer_token": None,
                },
            },
        )

    class FakeServer:
        def __init__(self, *, name, **_kwargs):
            self.name = name

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def list_tools(self):
            if self.name == "Broken CRM":
                raise RuntimeError("offline")
            return [
                SimpleNamespace(
                    name="list_contacts",
                    description="List CRM contacts",
                    inputSchema={"type": "object", "properties": {}},
                )
            ]

        async def call_tool(self, name, arguments):
            return {"tool": name, "arguments": arguments}

    monkeypatch.setattr(agents.mcp, "MCPServerStreamableHttp", FakeServer)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    from contextlib import AsyncExitStack

    async with AsyncExitStack() as stack:
        definitions, handler = await mcp_connectors.openai_tools(
            stack, TEST_ORG_ID, queue
        )
        assert [item["name"] for item in definitions] == [
            "mcp__healthy__list_contacts"
        ]
        assert handler is not None
        assert await handler("mcp__healthy__list_contacts", {"q": "Ada"}) == {
            "tool": "list_contacts",
            "arguments": {"q": "Ada"},
        }
    assert await queue.get() == {
        "type": "progress",
        "message": "Couldn't reach Broken CRM — continuing without it",
    }


def test_capabilities_counts_connected_mcp_connectors(monkeypatch, fake_db):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    for key, status in (("one", "connected"), ("two", "connected"), ("three", "error")):
        fake_db.seed(
            "org_integrations",
            {
                "org_id": TEST_ORG_ID,
                "provider": "mcp_connector",
                "kind": f"mcp_connector:{key}",
                "config": {
                    "key": key,
                    "name": key.title(),
                    "url": f"https://{key}.example.com/mcp",
                    "auth_kind": "none",
                    "status": status,
                },
            },
        )
    with TestClient(_test_app()) as client:
        response = client.get("/api/agent/capabilities")
    assert response.json()["mcp"] == {
        "available": True,
        "connectors_connected": 2,
    }


async def test_history_selects_newest_first_with_limit_and_reverses(fake_db):
    fake_db.seed(
        "agent_messages",
        {
            "id": "00000000-0000-0000-0000-000000000001",
            "thread_id": "thread-1",
            "org_id": TEST_ORG_ID,
            "sender_type": "user",
            "content": "first",
            "created_at": "2026-08-10T10:00:00+00:00",
        },
        {
            "id": "00000000-0000-0000-0000-000000000002",
            "thread_id": "thread-1",
            "org_id": TEST_ORG_ID,
            "sender_type": "agent",
            "content": "second",
            "created_at": "2026-08-10T10:01:00+00:00",
        },
    )
    history = await threads.load_history("thread-1", TEST_ORG_ID)
    assert history == [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "second"},
    ]
    query = fake_db.log[-1]
    assert query["limit"] == 40
    assert query["orders"] == [("created_at", True), ("id", True)]
    assert ("eq", "thread_id", "thread-1") in query["filters"]
    assert ("eq", "org_id", TEST_ORG_ID) in query["filters"]
    prompt = threads.format_history(history, "third")
    assert prompt.endswith("</conversation_history>\n\nthird")
    assert prompt.index("first") < prompt.index("second")


async def test_message_pages_offset_from_newest_end_and_return_ascending(fake_db):
    fake_db.seed(
        "agent_threads",
        {"id": "thread-1", "org_id": TEST_ORG_ID, "name": "Chat"},
    )
    for index in range(3):
        fake_db.seed(
            "agent_messages",
            {
                "id": f"00000000-0000-0000-0000-00000000000{index + 1}",
                "thread_id": "thread-1",
                "org_id": TEST_ORG_ID,
                "sender_type": "user" if index % 2 == 0 else "agent",
                "content": f"message-{index + 1}",
                "created_at": f"2026-08-10T10:0{index}:00+00:00",
            },
        )
    page, has_more = await threads.list_messages(
        "thread-1", TEST_ORG_ID, limit=2, offset=0
    )
    assert [message["content"] for message in page] == ["message-2", "message-3"]
    assert has_more
    older, has_more = await threads.list_messages(
        "thread-1", TEST_ORG_ID, limit=2, offset=2
    )
    assert [message["content"] for message in older] == ["message-1"]
    assert not has_more


async def test_openai_runtime_uses_stateless_xhigh_streaming_settings(monkeypatch):
    import agents

    from agent import runtime_openai

    captured: dict[str, Any] = {}

    class FakeRun:
        final_output = "Answer"
        context_wrapper = SimpleNamespace(
            usage=SimpleNamespace(input_tokens=8, output_tokens=2, total_tokens=10)
        )

        async def stream_events(self):
            yield SimpleNamespace(
                type="raw_response_event",
                data=SimpleNamespace(type="response.output_text.delta", delta="Answer"),
            )
            yield SimpleNamespace(
                type="raw_response_event",
                data=SimpleNamespace(type="response.output_text.done"),
            )

        def cancel(self):
            return None

    def fake_run_streamed(**kwargs):
        captured.update(kwargs)
        return FakeRun()

    async def no_connectors(_stack, _org_id, _queue):
        return [], None

    monkeypatch.setattr(agents.Runner, "run_streamed", staticmethod(fake_run_streamed))
    monkeypatch.setattr(runtime_openai.mcp_connectors, "openai_tools", no_connectors)
    events = [
        event
        async for event in runtime_openai.stream_response(
            context=_context(), system_prompt="System", full_prompt="Prompt"
        )
    ]
    assert [event["type"] for event in events] == [
        "message_delta",
        "message_complete",
        "runtime_complete",
    ]
    assert captured["max_turns"] == 30
    assert captured["previous_response_id"] is None
    assert captured["conversation_id"] is None
    assert captured["session"] is None
    settings = captured["starting_agent"].model_settings
    assert settings.reasoning.effort == "xhigh"
    assert settings.parallel_tool_calls is True
    assert settings.store is False
    assert settings.include_usage is True
    assert settings.response_include == ["reasoning.encrypted_content"]
    assert all(tool.strict_json_schema is False for tool in captured["starting_agent"].tools)


async def test_anthropic_runtime_streams_same_message_events(monkeypatch):
    import anthropic

    from agent import runtime_anthropic

    captured: dict[str, Any] = {}

    class FakeStream:
        @property
        def text_stream(self):
            async def deltas():
                yield "Twelve submissions."

            return deltas()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get_final_message(self):
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text="Twelve submissions.")],
                usage=SimpleNamespace(input_tokens=7, output_tokens=3),
            )

    class FakeMessages:
        def stream(self, **kwargs):
            captured.update(kwargs)
            return FakeStream()

    class FakeClient:
        def __init__(self, **_kwargs):
            self.messages = FakeMessages()

    async def no_connectors(_stack, _org_id, _queue):
        return [], None

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    monkeypatch.setattr(anthropic, "AsyncAnthropic", FakeClient)
    monkeypatch.setattr(runtime_anthropic.mcp_connectors, "anthropic_tools", no_connectors)
    events = [
        event
        async for event in runtime_anthropic.stream_response(
            context=_context(), system_prompt="System", full_prompt="Prompt"
        )
    ]
    assert [event["type"] for event in events] == [
        "message_delta",
        "message_complete",
        "runtime_complete",
    ]
    assert captured["model"] == assistant.MODEL
    assert captured["system"] == "System"
    assert captured["messages"] == [{"role": "user", "content": "Prompt"}]


def test_mocked_stream_smoke_persists_turn_and_emits_frozen_sequence(
    monkeypatch, seeded_db
):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ASSISTANT_PROVIDER", "openai")
    monkeypatch.setenv("ASSISTANT_ENABLED", "true")

    async def fake_runtime(**_kwargs):
        yield {"type": "progress", "message": "Looking at submissions…"}
        yield {"type": "message_delta", "message": "You have 12 submissions."}
        yield {"type": "message_complete"}
        yield {
            "type": "runtime_complete",
            "usage": {"input_tokens": 10, "output_tokens": 6},
            "model": "gpt-5.6-luna",
        }

    async def no_title(**_kwargs):
        return None

    monkeypatch.setattr("agent.runtime_openai.stream_response", fake_runtime)
    monkeypatch.setattr(titles, "maybe_generate_title", no_title)

    client_turn_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    with TestClient(_test_app()) as client:
        response = client.post(
            "/api/agent/chat/stream",
            json={
                "thread_id": None,
                "message": "How many submissions do we have?",
                "metadata": {
                    "pathname": "/dashboard",
                    "timezone": "America/Toronto",
                    "client_turn_id": client_turn_id,
                },
            },
        )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    events = _sse_events(response.text)
    assert [event["type"] for event in events] == [
        "thread_started",
        "progress",
        "message_delta",
        "message_complete",
        "complete",
    ]
    assert events[0]["turn_id"] == client_turn_id
    assert events[-1] == {
        "type": "complete",
        "message_to_user": "You have 12 submissions.",
    }
    messages = seeded_db.rows("agent_messages")
    assert [message["sender_type"] for message in messages] == ["user", "agent"]
    assert messages[-1]["metadata"]["agent_sdk"] == "openai_agents_sdk"
    assert messages[-1]["reasoning_context"] == {
        "tool_calls": [],
        "provider": "openai",
    }


def test_mcp_tool_definition_tolerates_both_sdk_field_names():
    """mcp 1.x Tool.inputSchema vs 2.x Tool.input_schema — both must map."""
    from types import SimpleNamespace

    from agent.mcp_connectors import _definition

    v1 = SimpleNamespace(
        name="list_events", description="List events", inputSchema={"type": "object"}
    )
    v2 = SimpleNamespace(
        name="list_events", description="List events", input_schema={"type": "object"}
    )
    assert _definition("every", "Every", v1)["input_schema"] == {"type": "object"}
    assert _definition("every", "Every", v2)["input_schema"] == {"type": "object"}
    bare = SimpleNamespace(name="ping", description=None)
    assert _definition("every", "Every", bare)["input_schema"]["type"] == "object"
