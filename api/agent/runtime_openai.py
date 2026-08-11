"""Stateless OpenAI Agents SDK runtime translated to semantic events."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from typing import Any

from agent import mcp_connectors
from agent.events import semantic_event
from agent.permissions import with_permission_guidance
from agent.tools import TurnContext, invoke_tool, registered_tools

DEFAULT_MODEL = "gpt-5.6-luna"
MAX_TURNS = 30
_QUEUE_DONE = object()


def model_name() -> str:
    return (os.getenv("ASSISTANT_OPENAI_MODEL") or DEFAULT_MODEL).strip()


def _value(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _usage_dict(result: Any) -> dict[str, Any]:
    usage = _value(_value(result, "context_wrapper"), "usage")
    if usage is None:
        return {}
    if hasattr(usage, "model_dump"):
        return usage.model_dump(mode="json")
    fields = (
        "requests",
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "input_tokens_details",
        "output_tokens_details",
    )
    return {
        field: _json_safe(_value(usage, field))
        for field in fields
        if _value(usage, field) is not None
    }


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "__dict__"):
        return {
            str(key): _json_safe(item)
            for key, item in vars(value).items()
            if not str(key).startswith("_")
        }
    return str(value)


async def stream_response(
    *,
    context: TurnContext,
    system_prompt: str,
    full_prompt: str,
) -> AsyncIterator[dict[str, Any]]:
    """Run a producer task and expose only SpeakerWeave semantic events."""
    queue: asyncio.Queue[dict[str, Any] | object] = asyncio.Queue()

    async def producer() -> None:
        result = None
        emitted_text = False
        emitted_boundary = False
        try:
            # All SDK imports stay inside the selected/keyed runtime.
            from agents import Agent, FunctionTool, ModelSettings, RunConfig, Runner
            from openai.types.shared.reasoning import Reasoning

            async with AsyncExitStack() as stack:
                external_definitions, external_handler = await mcp_connectors.openai_tools(
                    stack, context.org_id, context.progress_queue
                )
                definitions = [
                    *registered_tools(),
                    *(with_permission_guidance(item) for item in external_definitions),
                ]
                function_tools = []
                for definition in definitions:
                    tool_name = str(definition["name"])
                    connector_name = definition.get("connector_name")

                    async def on_invoke_tool(
                        _tool_context: Any,
                        arguments_json: str,
                        *,
                        _tool_name: str = tool_name,
                        _connector_name: Any = connector_name,
                    ) -> str:
                        try:
                            arguments = json.loads(arguments_json or "{}")
                        except (TypeError, ValueError):
                            arguments = {}
                        if not isinstance(arguments, dict):
                            arguments = {}
                        if _connector_name:
                            arguments["_connector_name"] = str(_connector_name)
                        return await invoke_tool(
                            context,
                            _tool_name,
                            arguments,
                            external_handler=external_handler,
                        )

                    function_tools.append(
                        FunctionTool(
                            name=tool_name,
                            description=str(definition.get("description") or ""),
                            params_json_schema=dict(definition.get("input_schema") or {}),
                            on_invoke_tool=on_invoke_tool,
                            strict_json_schema=False,
                        )
                    )

                agent = Agent(
                    name="SpeakerWeave Agent",
                    instructions=system_prompt,
                    model=model_name(),
                    model_settings=ModelSettings(
                        reasoning=Reasoning(effort="xhigh"),
                        parallel_tool_calls=True,
                        store=False,
                        include_usage=True,
                        response_include=["reasoning.encrypted_content"],
                    ),
                    tools=function_tools,
                )
                result = Runner.run_streamed(
                    starting_agent=agent,
                    input=full_prompt,
                    context=context,
                    max_turns=MAX_TURNS,
                    run_config=RunConfig(
                        tracing_disabled=True,
                        trace_include_sensitive_data=False,
                        workflow_name="SpeakerWeave interactive agent",
                    ),
                    previous_response_id=None,
                    conversation_id=None,
                    session=None,
                )
                async for event in result.stream_events():
                    if context.cancel_event.is_set():
                        result.cancel()
                        raise asyncio.CancelledError
                    if _value(event, "type") != "raw_response_event":
                        continue
                    data = _value(event, "data")
                    event_type = str(_value(data, "type", ""))
                    if event_type == "response.output_text.delta":
                        delta = str(_value(data, "delta", "") or "")
                        if delta:
                            emitted_text = True
                            await queue.put(semantic_event("message_delta", message=delta))
                    elif event_type == "response.output_text.done":
                        emitted_boundary = True
                        await queue.put(semantic_event("message_complete"))

                final_output = _value(result, "final_output", "")
                final_text = (
                    final_output
                    if isinstance(final_output, str)
                    else str(final_output or "")
                )
                if final_text and not emitted_text:
                    await queue.put(semantic_event("message_delta", message=final_text))
                    emitted_text = True
                if emitted_text and not emitted_boundary:
                    await queue.put(semantic_event("message_complete"))
                await queue.put(
                    semantic_event(
                        "runtime_complete",
                        usage=_usage_dict(result),
                        model=model_name(),
                    )
                )
        except asyncio.CancelledError:
            if result is not None:
                result.cancel()
            await queue.put(semantic_event("runtime_cancelled"))
        except Exception as exc:  # noqa: BLE001 - provider boundary becomes SSE error
            await queue.put(
                semantic_event(
                    "error",
                    message="The conference assistant could not finish this turn.",
                    detail=str(exc),
                )
            )
        finally:
            await queue.put(_QUEUE_DONE)

    producer_task = asyncio.create_task(producer())
    context.producer_task = producer_task
    try:
        while True:
            event = await queue.get()
            if event is _QUEUE_DONE:
                break
            yield event  # type: ignore[misc]
    finally:
        if not producer_task.done():
            producer_task.cancel()
        try:
            await producer_task
        except asyncio.CancelledError:
            pass
