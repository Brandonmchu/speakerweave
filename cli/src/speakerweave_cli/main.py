"""Click command tree for the ``sw`` console script."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import wraps
from pathlib import Path
from typing import Any, TypeVar
from urllib.parse import urljoin
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import click

from speakerweave_cli import __version__
from speakerweave_cli.api import ApiClient, ApiError
from speakerweave_cli.config import (
    CONFIG_PATH,
    DEFAULT_SERVER,
    ConfigError,
    delete_config,
    load_config,
    mask_token,
    resolve_config,
    save_config,
)
from speakerweave_cli.output import (
    clipped,
    heading,
    json_output,
    key_values,
    table,
    text,
)

F = TypeVar("F", bound=Callable[..., Any])


def guarded(function: F) -> F:
    """Map operational failures to Click's exit-code-1 error path."""

    @wraps(function)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return function(*args, **kwargs)
        except (ApiError, ConfigError) as exc:
            raise click.ClickException(str(exc)) from None

    return wrapper  # type: ignore[return-value]


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _active_event(events: list[dict]) -> dict:
    if not events:
        raise ApiError("No events found for this organization.")
    now = datetime.now(UTC)
    active = [
        event
        for event in events
        if (_parse_datetime(event.get("starts_at")) or datetime.min.replace(tzinfo=UTC))
        <= now
        <= (_parse_datetime(event.get("ends_at")) or datetime.max.replace(tzinfo=UTC))
        and (event.get("starts_at") or event.get("ends_at"))
    ]
    if active:
        return min(active, key=lambda event: _parse_datetime(event.get("starts_at")) or now)
    future = [event for event in events if (_parse_datetime(event.get("starts_at")) or now) > now]
    if future:
        return min(future, key=lambda event: _parse_datetime(event.get("starts_at")) or now)
    return events[0]


@dataclass
class State:
    server_override: str | None = None
    token_override: str | None = None
    _client: ApiClient | None = field(default=None, init=False)
    _event: dict | None = field(default=None, init=False)

    def resolved(self, *, require_token: bool = True):
        resolved = resolve_config(
            server_override=self.server_override,
            token_override=self.token_override,
        )
        if require_token and not resolved.token:
            raise ApiError("You are not authenticated. Run 'sw auth login' to get started.")
        return resolved

    def client(self) -> ApiClient:
        if self._client is None:
            resolved = self.resolved()
            self._client = ApiClient(resolved.server, resolved.token or "")
        return self._client

    def event(self) -> dict:
        if self._event is None:
            self._event = _active_event(self.client().get_all("/v1/events"))
        return self._event

    def close(self) -> None:
        if self._client is not None:
            self._client.close()


pass_state = click.make_pass_decorator(State)


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
@click.option("--server", help="Override the configured SpeakerWeave server URL.")
@click.option("--token", help="Override the API token for this invocation.")
@click.version_option(__version__, prog_name="sw")
@click.pass_context
def cli(ctx: click.Context, server: str | None, token: str | None) -> None:
    """SpeakerWeave conference operations from your terminal."""
    state = State(server_override=server, token_override=token)
    ctx.obj = state
    ctx.call_on_close(state.close)


# ── auth ────────────────────────────────────────────────────────────────────


@cli.group()
def auth() -> None:
    """Store and inspect organization API-token credentials."""


@auth.command("login")
@pass_state
@guarded
def auth_login(state: State) -> None:
    """Verify and store a server URL and organization API token."""
    stored = load_config()
    if state.server_override:
        server = state.server_override
    else:
        server = click.prompt("Server URL", default=stored.server or DEFAULT_SERVER, show_default=True)
    supplied = (state.token_override or os.environ.get("SPEAKERWEAVE_TOKEN") or "").strip()
    token = supplied or click.prompt("API token", hide_input=True)
    resolved = resolve_config(server_override=server, token_override=token, environ={})
    client = ApiClient(resolved.server, resolved.token or "")
    try:
        client.verify()
    finally:
        client.close()
    path = save_config(resolved.server, resolved.token or "")
    click.echo(click.style("Authenticated.", fg="green", bold=True))
    click.echo(f"Server  {resolved.server}")
    click.echo(click.style(f"Saved securely to {path}", dim=True))


@auth.command("status")
@pass_state
@guarded
def auth_status(state: State) -> None:
    """Show the active credential source and verify it."""
    resolved = state.resolved()
    state.client().verify()
    click.echo(click.style("Authenticated", fg="green", bold=True))
    key_values(
        [
            ("Server", resolved.server),
            ("Token", mask_token(resolved.token or "")),
            ("Source", resolved.token_source or "unknown"),
        ]
    )


@auth.command("logout")
@guarded
def auth_logout() -> None:
    """Remove credentials stored on this computer."""
    removed = delete_config()
    if removed:
        click.echo(f"Removed credentials from {CONFIG_PATH}.")
    else:
        click.echo("No stored credentials found.")
    if os.environ.get("SPEAKERWEAVE_TOKEN"):
        click.echo(click.style("SPEAKERWEAVE_TOKEN is still set in this shell.", dim=True))


# ── events ──────────────────────────────────────────────────────────────────


@cli.group()
def events() -> None:
    """Inspect conference events."""


@events.command("list")
@click.option("--json", "as_json", is_flag=True, help="Print machine-readable JSON.")
@pass_state
@guarded
def events_list(state: State, as_json: bool) -> None:
    """List events in the authenticated organization."""
    rows = state.client().get_all("/v1/events")
    if as_json:
        json_output(rows)
        return
    table(
        ("NAME", "START", "END", "TIMEZONE", "ID"),
        (
            (
                event.get("name"),
                _date_value(event.get("starts_at")),
                _date_value(event.get("ends_at")),
                event.get("timezone"),
                event.get("id"),
            )
            for event in rows
        ),
    )


# ── submissions ─────────────────────────────────────────────────────────────


@cli.group()
def submissions() -> None:
    """Review and decide submissions for the active event."""


@submissions.command("list")
@click.option("--status", help="Filter by submission status.")
@click.option("--track", help="Filter by track id or name.")
@click.option("--json", "as_json", is_flag=True, help="Print machine-readable JSON.")
@pass_state
@guarded
def submissions_list(state: State, status: str | None, track: str | None, as_json: bool) -> None:
    """List submissions for the active or next event."""
    event = state.event()
    params = {key: value for key, value in {"status": status, "track": track}.items() if value}
    rows = state.client().get_all(f"/v1/events/{event['id']}/submissions", params=params)
    if as_json:
        json_output(rows)
        return
    _event_heading(event)
    table(
        ("REF", "TITLE", "STATUS", "TRACK", "SPEAKERS", "ID"),
        (
            (
                row.get("friendly_id"),
                row.get("title"),
                row.get("status"),
                _nested_name(row.get("track")),
                _speaker_names(row.get("speakers")),
                row.get("id"),
            )
            for row in rows
        ),
    )


@submissions.command("get")
@click.argument("submission_id")
@click.option("--json", "as_json", is_flag=True, help="Print machine-readable JSON.")
@pass_state
@guarded
def submissions_get(state: State, submission_id: str, as_json: bool) -> None:
    """Get one submission by its API id."""
    payload = state.client().get(f"/v1/submissions/{submission_id}")
    row = payload.get("data", {})
    if as_json:
        json_output(row)
        return
    heading(text(row.get("title"), "Untitled submission"))
    key_values(
        [
            ("ID", row.get("id")),
            ("Reference", row.get("friendly_id")),
            ("Status", row.get("status")),
            ("Track", _nested_name(row.get("track"))),
            ("Format", _nested_name(row.get("format"))),
            ("Speakers", _speaker_names(row.get("speakers"))),
            ("Scheduled", _date_time_value(row.get("starts_at"))),
            ("Room", _nested_name(row.get("room"))),
        ]
    )
    if row.get("description"):
        click.echo()
        click.echo(str(row["description"]))


def _submission_action(state: State, submission_id: str, status: str, feedback: str | None) -> None:
    body: dict[str, Any] = {"status": status}
    if feedback is not None:
        body["feedback"] = feedback
    payload = state.client().patch(f"/v1/submissions/{submission_id}", json=body)
    row = payload.get("data", {})
    click.echo(
        f"{click.style('Updated', fg='green', bold=True)}  "
        f"{text(row.get('friendly_id') or row.get('id'))} → {text(row.get('status'))}"
    )


@submissions.command("accept")
@click.argument("submission_id")
@click.option("--feedback", help="Decision feedback to store with the submission.")
@pass_state
@guarded
def submissions_accept(state: State, submission_id: str, feedback: str | None) -> None:
    """Accept a submission."""
    _submission_action(state, submission_id, "accepted", feedback)


@submissions.command("decline")
@click.argument("submission_id")
@click.option("--feedback", help="Decision feedback to store with the submission.")
@pass_state
@guarded
def submissions_decline(state: State, submission_id: str, feedback: str | None) -> None:
    """Decline a submission."""
    _submission_action(state, submission_id, "declined", feedback)


@submissions.command("queue")
@click.argument("submission_id")
@click.option("--feedback", help="Decision feedback to store with the submission.")
@pass_state
@guarded
def submissions_queue(state: State, submission_id: str, feedback: str | None) -> None:
    """Move a submission into the acceptance queue."""
    _submission_action(state, submission_id, "accept_queue", feedback)


# ── speakers ────────────────────────────────────────────────────────────────


@cli.group()
def speakers() -> None:
    """Inspect and import the active event's speakers."""


@speakers.command("list")
@click.option("--filter", "filter_text", help="Search name, email, company, or title.")
@click.option("--json", "as_json", is_flag=True, help="Print machine-readable JSON.")
@pass_state
@guarded
def speakers_list(state: State, filter_text: str | None, as_json: bool) -> None:
    """List speakers for the active or next event."""
    event = state.event()
    params = {"filter": filter_text} if filter_text else None
    rows = state.client().get_all(f"/v1/events/{event['id']}/speakers", params=params)
    if as_json:
        json_output(rows)
        return
    _event_heading(event)
    table(
        ("NAME", "EMAIL", "COMPANY", "TITLE", "STATUS", "ID"),
        (
            (
                row.get("full_name"),
                row.get("email"),
                row.get("company_name"),
                row.get("title"),
                row.get("speaker_status"),
                row.get("id"),
            )
            for row in rows
        ),
    )


@speakers.command("get")
@click.argument("speaker_id")
@click.option("--json", "as_json", is_flag=True, help="Print machine-readable JSON.")
@pass_state
@guarded
def speakers_get(state: State, speaker_id: str, as_json: bool) -> None:
    """Get one speaker by their API id."""
    payload = state.client().get(f"/v1/speakers/{speaker_id}")
    row = payload.get("data", {})
    if as_json:
        json_output(row)
        return
    heading(text(row.get("full_name"), "Speaker"))
    key_values(
        [
            ("ID", row.get("id")),
            ("Email", row.get("email")),
            ("Company", row.get("company_name")),
            ("Title", row.get("title")),
            ("Status", row.get("speaker_status")),
            ("Portal invited", "yes" if row.get("invited_to_portal") else "no"),
            ("LinkedIn", row.get("linkedin_url")),
            ("Phone", row.get("phone")),
            ("Logistics", row.get("logistics_notes")),
        ]
    )
    if row.get("about"):
        click.echo()
        click.echo(str(row["about"]))


@speakers.command("import")
@click.argument("csv_file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@pass_state
@guarded
def speakers_import(state: State, csv_file: Path) -> None:
    """Import speakers from a CSV file."""
    try:
        csv_text = csv_file.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise click.ClickException(f"Could not read {csv_file}: {exc}") from None
    event = state.event()
    result = state.client().post(
        f"/api/events/{event['id']}/speakers/import",
        json={"csv": csv_text},
    )
    _event_heading(event)
    table(
        ("CREATED", "UPDATED", "SKIPPED", "ERRORS", "TOTAL"),
        [
            (
                result.get("created", 0),
                result.get("updated", 0),
                result.get("skipped", 0),
                len(result.get("errors") or []),
                result.get("total", 0),
            )
        ],
    )
    ignored = result.get("ignored_columns") or []
    click.echo(
        click.style(
            f"Ignored columns: {', '.join(map(str, ignored)) if ignored else 'none'}",
            dim=True,
        )
    )
    errors = result.get("errors") or []
    if errors:
        click.echo()
        heading("Row errors")
        table(
            ("LINE", "EMAIL", "MESSAGE"),
            ((error.get("line"), error.get("email"), error.get("message")) for error in errors),
        )


# ── schedule ────────────────────────────────────────────────────────────────


@cli.group()
def schedule() -> None:
    """Inspect and manage the active event's schedule."""


@schedule.command("show")
@click.option("--json", "as_json", is_flag=True, help="Print machine-readable JSON.")
@pass_state
@guarded
def schedule_show(state: State, as_json: bool) -> None:
    """Show sessions grouped by day in the event timezone."""
    event = state.event()
    payload = state.client().get(f"/v1/events/{event['id']}/schedule").get("data", {})
    if as_json:
        json_output(payload)
        return
    schedule_event = payload.get("event") or event
    timezone_name = schedule_event.get("timezone") or "UTC"
    try:
        event_tz = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        event_tz = ZoneInfo("UTC")
        timezone_name = "UTC"
    _event_heading(schedule_event, suffix=timezone_name)
    sessions_by_day: dict[str, list[dict]] = {}
    unscheduled: list[dict] = []
    for session in payload.get("sessions") or []:
        starts_at = _parse_datetime(session.get("starts_at"))
        if not starts_at:
            unscheduled.append(session)
            continue
        local = starts_at.astimezone(event_tz)
        sessions_by_day.setdefault(local.strftime("%A, %B %-d"), []).append(session)
    for day, day_sessions in sessions_by_day.items():
        click.echo()
        heading(day)
        table(
            ("TIME", "SESSION", "ROOM", "TRACK", "SPEAKERS"),
            (
                (
                    _time_range(row, event_tz),
                    row.get("title"),
                    _nested_name(row.get("room")),
                    _nested_name(row.get("track")),
                    _speaker_names(row.get("speakers")),
                )
                for row in day_sessions
            ),
        )
    if unscheduled:
        click.echo()
        heading("Unscheduled")
        table(
            ("SESSION", "STATUS", "TRACK", "SPEAKERS"),
            (
                (
                    row.get("title"),
                    row.get("status"),
                    _nested_name(row.get("track")),
                    _speaker_names(row.get("speakers")),
                )
                for row in unscheduled
            ),
        )
    if not sessions_by_day and not unscheduled:
        click.echo(click.style("No sessions on this event yet.", dim=True))


@schedule.command("auto-place")
@pass_state
@guarded
def schedule_auto_place(state: State) -> None:
    """Place unscheduled sessions into conflict-free slots."""
    event = state.event()
    result = state.client().post(f"/api/events/{event['id']}/schedule/auto-place", json={})
    _event_heading(event)
    placed = result.get("placed") or []
    skipped = result.get("skipped") or []
    click.echo(f"Placed {len(placed)} session(s); skipped {len(skipped)}.")
    if skipped:
        table(
            ("SESSION", "REASON"),
            ((row.get("title") or row.get("id"), row.get("reason")) for row in skipped),
        )


@schedule.command("publish")
@pass_state
@guarded
def schedule_publish(state: State) -> None:
    """Publish the active event's schedule and print its public URL."""
    event = state.event()
    result = state.client().post(f"/api/events/{event['id']}/schedule/publish", json={})
    relative = result.get("public_url")
    public_url = urljoin(f"{state.resolved().server}/", str(relative).lstrip("/")) if relative else "—"
    click.echo(click.style("Schedule published.", fg="green", bold=True))
    click.echo(public_url)


# ── content ─────────────────────────────────────────────────────────────────


@cli.group()
def content() -> None:
    """Track and remind speakers about content deliverables."""


@content.command("status")
@click.option("--missing-only", is_flag=True, help="Show only missing deliverables.")
@click.option("--json", "as_json", is_flag=True, help="Print machine-readable JSON.")
@pass_state
@guarded
def content_status(state: State, missing_only: bool, as_json: bool) -> None:
    """Show content collection status for the active event."""
    event = state.event()
    params = {"status": "missing"} if missing_only else None
    rows = state.client().get_all(f"/v1/events/{event['id']}/content-items", params=params)
    if as_json:
        json_output(rows)
        return
    _event_heading(event)
    table(
        ("SPEAKER", "ITEM", "TYPE", "STATUS", "REQUIRED", "DUE"),
        (
            (
                _nested_name(row.get("speaker")),
                row.get("title"),
                row.get("type"),
                row.get("status"),
                "yes" if row.get("required") else "no",
                _date_value(row.get("due_at")),
            )
            for row in rows
        ),
    )


@content.command("remind")
@pass_state
@guarded
def content_remind(state: State) -> None:
    """Queue deduplicated reminders for required missing content."""
    event = state.event()
    result = state.client().post(
        f"/api/events/{event['id']}/content/remind",
        json={"required_only": True},
    )
    click.echo(
        f"Queued {result.get('reminded', 0)} reminder(s) across "
        f"{result.get('outstanding', 0)} outstanding speaker(s)."
    )


# ── AI triage and assistant ─────────────────────────────────────────────────


@cli.command("triage")
@click.option("--json", "as_json", is_flag=True, help="Print machine-readable JSON.")
@pass_state
@guarded
def triage(state: State, as_json: bool) -> None:
    """Run AI triage for the active event's open evaluation plan."""
    event = state.event()
    plans = state.client().get_all(f"/v1/events/{event['id']}/evaluation-plans")
    plan = next((candidate for candidate in plans if candidate.get("status") == "open"), None)
    if not plan:
        raise ApiError("No open evaluation plan was found for the active event.")
    result = state.client().post(f"/api/evaluation-plans/{plan['id']}/ai-triage", json={})
    if as_json:
        json_output(result)
        return
    triage_result = result.get("triage") or {}
    _event_heading(event, suffix=f"plan: {plan.get('name') or plan.get('id')}")
    source = triage_result.get("source") or "unknown"
    model = triage_result.get("model")
    click.echo(click.style(f"Source: {source}{f' · {model}' if model else ''}", dim=True))
    table(
        ("RANK", "SUBMISSION", "SCORE", "SUGGESTION", "RATIONALE"),
        (
            (
                index,
                row.get("title") or row.get("session_id"),
                row.get("override_score") if row.get("override_score") is not None else row.get("score"),
                row.get("suggestion"),
                clipped(row.get("rationale"), 48),
            )
            for index, row in enumerate(triage_result.get("items") or [], start=1)
        ),
    )


@cli.command("ask")
@click.argument("question", required=False)
@click.option("-i", "--interactive", is_flag=True, help="Keep a conversation open in a REPL.")
@pass_state
@guarded
def ask(state: State, question: str | None, interactive: bool) -> None:
    """Ask the organization-scoped conference assistant a question."""
    if not question and not interactive:
        raise click.UsageError("Provide a question or use --interactive.")
    history: list[dict[str, str]] = []
    if question:
        _ask_once(state, history, question)
    if not interactive:
        return
    click.echo(click.style("Ask SpeakerWeave · type 'exit' to leave", dim=True))
    while True:
        try:
            prompt = click.prompt(click.style("you", bold=True), prompt_suffix="> ")
        except (click.Abort, EOFError):
            click.echo()
            return
        if prompt.strip().lower() in {"exit", "quit", ":q"}:
            return
        if prompt.strip():
            _ask_once(state, history, prompt)


def _ask_once(state: State, history: list[dict[str, str]], question: str) -> None:
    history.append({"role": "user", "content": question.strip()})
    _trim_history(history)
    result = state.client().post("/api/assistant/chat", json={"messages": history})
    reply = str(result.get("reply") or "")
    click.echo(reply)
    tools = result.get("tool_calls") or []
    rendered_tools = ", ".join(str(tool.get("name")) for tool in tools if tool.get("name")) or "none"
    click.echo(click.style(f"used tools: {rendered_tools}", dim=True))
    if reply:
        history.append({"role": "assistant", "content": reply})


def _trim_history(history: list[dict[str, str]]) -> None:
    while len(history) > 29 or sum(len(item["content"]) for item in history) > 30_000:
        history.pop(0)


# ── shared display helpers ──────────────────────────────────────────────────


def _event_heading(event: dict, *, suffix: str | None = None) -> None:
    label = text(event.get("name"), "Event")
    if suffix:
        label = f"{label} · {suffix}"
    heading(label)


def _nested_name(value: Any) -> str:
    if isinstance(value, dict):
        return text(value.get("name") or value.get("full_name") or value.get("email"))
    return text(value)


def _speaker_names(value: Any) -> str:
    if not isinstance(value, list):
        return "—"
    names = [
        text(item.get("full_name") or item.get("name") or item.get("email"))
        for item in value
        if isinstance(item, dict)
    ]
    return ", ".join(name for name in names if name != "—") or "—"


def _date_value(value: Any) -> str:
    parsed = _parse_datetime(value)
    return parsed.strftime("%Y-%m-%d") if parsed else text(value)


def _date_time_value(value: Any) -> str:
    parsed = _parse_datetime(value)
    return parsed.strftime("%Y-%m-%d %H:%M %Z") if parsed else text(value)


def _time_range(session: dict, event_tz: ZoneInfo) -> str:
    start = _parse_datetime(session.get("starts_at"))
    end = _parse_datetime(session.get("ends_at"))
    if not start:
        return "—"
    rendered = start.astimezone(event_tz).strftime("%-I:%M %p").lstrip("0")
    if end:
        rendered = f"{rendered}–{end.astimezone(event_tz).strftime('%-I:%M %p').lstrip('0')}"
    return rendered


if __name__ == "__main__":  # pragma: no cover
    cli()
