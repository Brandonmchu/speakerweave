"""Dependency-free, terminal-friendly formatting."""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from typing import Any

import click


def json_output(value: Any) -> None:
    click.echo(json.dumps(value, indent=2, ensure_ascii=False, default=str))


def text(value: Any, fallback: str = "—") -> str:
    if value is None or value == "":
        return fallback
    return str(value).replace("\n", " ").strip() or fallback


def clipped(value: Any, width: int = 48) -> str:
    rendered = text(value)
    if len(rendered) <= width:
        return rendered
    return f"{rendered[: width - 1].rstrip()}…"


def table(headers: Sequence[str], rows: Iterable[Sequence[Any]]) -> None:
    materialized = [[clipped(cell) for cell in row] for row in rows]
    if not materialized:
        click.echo(click.style("No results.", dim=True))
        return
    widths = [len(header) for header in headers]
    for row in materialized:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))
    header_line = "  ".join(header.ljust(widths[index]) for index, header in enumerate(headers))
    rule = "  ".join("─" * width for width in widths)
    click.echo(click.style(header_line, bold=True))
    click.echo(click.style(rule, dim=True))
    for row in materialized:
        click.echo("  ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)))


def key_values(items: Iterable[tuple[str, Any]]) -> None:
    materialized = [(label, text(value)) for label, value in items]
    width = max((len(label) for label, _value in materialized), default=0)
    for label, value in materialized:
        click.echo(f"{click.style(label.ljust(width), bold=True)}  {value}")


def heading(value: str) -> None:
    click.echo(click.style(value, bold=True))
