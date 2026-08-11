# The in-app chat agent

SpeakerWeave ships an optional, Every-style agent with two transports. In-app Ask is a right-side panel available on every organizer page, with threads, streaming responses, `@`-mention context tagging, clickable entity badges, agent-driven navigation, and inline Approve/Deny confirmation for sensitive actions. The Slack bot enters the exact same agent turn service, tool registry, MCP connectors, thread store, and permission gate through signed Slack events and interactive buttons.

This document covers how to turn it on, how to turn it off, how to run it on OpenAI or Anthropic, and how to remove it from the codebase entirely.

## The one switch

The agent is **dormant by default**. It activates only when a model provider key is present:

| State | Configuration |
|---|---|
| Off (default) | Set neither `OPENAI_API_KEY` nor `ANTHROPIC_API_KEY`. No chat UI renders, no agent routes mount, no AI SDK code is imported. |
| On, OpenAI (recommended) | Set `OPENAI_API_KEY`. Runs the OpenAI Agents SDK with `gpt-5.6-luna` at `xhigh` reasoning effort (override the model with `ASSISTANT_OPENAI_MODEL`). |
| On, Anthropic | Set `ANTHROPIC_API_KEY` (and no OpenAI key, or `ASSISTANT_PROVIDER=anthropic`). Runs the same event protocol on Claude. |
| Force off | `ASSISTANT_ENABLED=false` disables the agent even when keys exist (keys may still serve AI triage). |

The frontend needs no configuration at all: it asks `GET /api/agent/capabilities` once per session and renders zero chat surface when the answer is no. There is no second flag to keep in sync.

## Architecture (and how it stays deletable)

The agent runtime and in-app UI are concentrated in two directories, with Slack kept as a transport at the service boundary:

- `api/agent/` — the FastAPI module: shared `service.run_turn`, the in-app SSE router, both provider runtimes, event vocabulary, thread persistence, permission gate, context search, and MCP connector framework. The router is mounted from a single guarded `include_router` line in `api/main.py`; the Slack transport calls `service.run_turn` directly.
- `web/src/agent/` — the React module: panel shell, threads, composer with `@` mentions, streaming consumer + pacer, markdown renderer, work trace, permission prompt. Mounted from a single conditional block in `web/src/shell/AppShell.tsx`.

**Don't want it?** Set no keys — it stays dormant, costs nothing, imports nothing.

**Want only the in-app panel gone?** Delete `web/src/agent/` and its conditional mount in `AppShell.tsx`; the Slack transport can continue using the shared API runtime.

**Want the entire agent gone from the codebase?** Remove the Slack bridge and route along with `api/agent/`, its mount line, `web/src/agent/`, and the web mount. New deployments can also omit the agent and Slack thread migrations; existing deployments may leave their empty tables. The SDK entries in `requirements.txt` (`openai`, `openai-agents`) and the markdown packages in `web/package.json` can then be removed.

## OpenAI or Anthropic — the same harness

The runtime follows Every's production pattern: a provider-neutral harness (threads, SSE streaming, permission gate, tool registry, persistence) with the model loop as the only swappable part.

`api/agent/service.py:run_turn` is the shared entry point. It claims the thread, loads history, persists the user message, builds the prompt, drives the selected runtime, emits public events, persists the reply, and releases pending permissions in `finally`. The in-app route only adapts those events to SSE. Slack adapts signed Events API messages to the same call and listens for `permission_request` events so it can render native buttons. `api/services/assistant.py` is a separate legacy boundary used only by `/api/assistant/chat`; Slack does not use it.

- **Tool registry**: one declarative list of `{name, description, input_schema}` in Anthropic schema format, shared by every surface. The OpenAI lane adapts each entry to a hand-built `FunctionTool` (`strict_json_schema=False` so schemas pass through unmodified); the Anthropic lane sends the list natively.
- **Events**: both lanes emit the same SSE vocabulary (`message_delta`, `progress`, `reasoning`, `permission_request`, `navigate`, `entity_update`, `complete`, …). The frontend cannot tell providers apart.
- **History**: stateless on both lanes — conversation history is replayed into the prompt each turn (`<conversation_history>` block), never provider-side session state.

### Adjustments when running on Claude

If you default to the Anthropic lane (or point the OpenAI lane at a different model), the knobs that differ:

1. **Model + effort naming**: OpenAI's `reasoning.effort` tiers (`minimal…xhigh`) don't map one-to-one to Claude. The Anthropic lane uses standard tool-use turns on the configured Claude model; if you want extended thinking, enable it in `api/agent/runtime_anthropic.py` where the `messages.create` call is made (budget-token style rather than an effort label).
2. **Streaming shape**: OpenAI emits `response.output_text.delta` events through the Agents SDK runner; Anthropic emits `content_block_delta`. Both are already normalized to `message_delta` — touch nothing in the frontend.
3. **Stateless multi-turn**: the OpenAI lane sets `store=False` and requests `reasoning.encrypted_content` so reasoning survives across turns without server-side storage. Claude needs no equivalent — history replay is enough.
4. **Parallel tool calls**: on by default for OpenAI (`parallel_tool_calls=True`); Claude decides per turn on its own.
5. **Cost/perf**: `xhigh` is a deliberate quality-first default per Every's production experience. On Claude, the closest analog is choosing a larger model rather than an effort flag.

## Sensitive actions require approval

Tools that send email, record accept/decline decisions, publish the schedule, delete data, or invoke a mutating external MCP tool are permission-gated. The same pending permission is resolved through either transport: in-app Ask renders an Approve/Deny card with a 180-second expiry, while Slack posts native Approve/Deny buttons and waits up to 300 seconds. A denial is returned to the model as a structured refusal so the conversation continues gracefully. The gated list and shared resolver live in `api/agent/permissions.py` — extend them as you add tools.

## MCP connectors (optional layer)

Organizations can connect external tool servers from Settings → Integrations. [Every](https://every.ai) is the first preset: set `EVERY_MCP_URL` (for example, `https://admin-mcp.every.ai/mcp`) and it appears in the catalog ready for OAuth connection. Teams can also add any custom server with OAuth, a static bearer token, or no authentication. Tools are namespaced as `mcp__<connector>__<tool>`, every mutation uses the same Approve/Deny gate, and one unreachable connector never prevents the remaining tools or the chat itself from working.

A compatible custom server exposes MCP over Streamable HTTP and supports either standard MCP OAuth discovery (including dynamic client registration and PKCE) or a static bearer token. Connector definitions, org-scoped credentials, refresh handling, and both runtime bridges live in `api/agent/mcp_connectors.py`.

## Wire protocol (for custom frontends)

`POST /api/agent/chat/stream` returns `text/event-stream` frames of `data: {"type": …}` JSON. The full event inventory, thread CRUD routes, context-search endpoint, and permission-response route are documented in the route docstrings in `api/agent/router.py`, and every event type is exercised in `api/tests/`. Two client-side requirements: buffer partial SSE lines across network chunks, and treat `complete.message_to_user` as the authoritative final text (reconcile if it diverges from your accumulated deltas).
