# The in-app chat agent

SpeakerWeave ships an optional, Every-style chat agent: a right-side panel available on every organizer page, with threads, streaming responses, `@`-mention context tagging, clickable entity badges, agent-driven navigation, and inline Approve/Deny confirmation for sensitive actions. It shares one org-scoped tool layer with the Slack bot, the hosted MCP server, the REST assistant endpoint, and the `sw` CLI — one brain, many surfaces.

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

All chat-agent code is quarantined in two directories:

- `api/agent/` — the FastAPI module: router, both provider runtimes, SSE event vocabulary, thread persistence, permission gate, context search, Every MCP client. Mounted from a single guarded `include_router` line in `api/main.py`.
- `web/src/agent/` — the React module: panel shell, threads, composer with `@` mentions, streaming consumer + pacer, markdown renderer, work trace, permission prompt. Mounted from a single conditional block in `web/src/shell/AppShell.tsx`.

**Don't want it?** Set no keys — it stays dormant, costs nothing, imports nothing.

**Want it gone from the codebase?** Delete `api/agent/` and its one mount line in `main.py`; delete `web/src/agent/` and the one conditional in `AppShell.tsx`; drop migration `016_agent_chat.sql` from new deployments (or leave the two empty tables — nothing else references them). The SDK entries in `requirements.txt` (`openai`, `openai-agents`) and the markdown packages in `web/package.json` can then be removed too. Nothing else in the app touches the module in either direction.

## OpenAI or Anthropic — the same harness

The runtime follows Every's production pattern: a provider-neutral harness (threads, SSE streaming, permission gate, tool registry, persistence) with the model loop as the only swappable part.

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

Tools that send email, record accept/decline decisions, publish the schedule, delete data, or invoke a mutating Every tool are permission-gated: the run pauses, the composer becomes an Approve/Deny card (180-second expiry), and a denial is returned to the model as a structured refusal so the conversation continues gracefully. The gated list lives in `api/agent/permissions.py` — extend it as you add tools.

## Connect Every (optional layer)

If your organization runs its business on [Every](https://every.ai), set `EVERY_MCP_URL` (e.g. `https://admin-mcp.every.ai/mcp`) and connect an account from the chat panel or Settings → Integrations. SpeakerWeave performs the standard MCP OAuth flow (discovery, dynamic client registration, PKCE) and the agent gains `every_*` tools — drafting proposals for confirmed speakers, checking a sponsor's invoice status — with all mutations behind the same Approve/Deny gate. Disconnecting removes the tokens; the agent degrades gracefully if Every is unreachable.

The same pattern works for any MCP server that implements the standard OAuth flow — `api/agent/every_mcp.py` is deliberately a generic client with one configured endpoint.

## Wire protocol (for custom frontends)

`POST /api/agent/chat/stream` returns `text/event-stream` frames of `data: {"type": …}` JSON. The full event inventory, thread CRUD routes, context-search endpoint, and permission-response route are documented in the route docstrings in `api/agent/router.py`, and every event type is exercised in `api/tests/`. Two client-side requirements: buffer partial SSE lines across network chunks, and treat `complete.message_to_user` as the authoritative final text (reconcile if it diverges from your accumulated deltas).
