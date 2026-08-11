"""Convert GitHub-flavored Markdown replies into Slack mrkdwn."""

from __future__ import annotations

import re


class _Protector:
    """Protect literal/final text with tokens unique to this protector."""

    def __init__(self, tag: str = "P") -> None:
        self._tag = tag
        self._blocks: list[str] = []

    def _token(self, index: int) -> str:
        return f"\x00{self._tag}{index}\x00"

    def protect(self, content: str) -> str:
        token = self._token(len(self._blocks))
        self._blocks.append(content)
        return token

    def restore(self, text: str) -> str:
        for index, content in enumerate(self._blocks):
            text = text.replace(self._token(index), content)
        return text


_FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")

_HR_RE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
_BULLET_RE = re.compile(r"^(\s*)[-*+]\s+(.+)$")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")

_TABLE_SEPARATOR_CELL_RE = re.compile(r"^:?-+:?$")

_BOLD_RE = re.compile(r"(\*\*|__)(\S(?:[^\n]*?\S)?)\1")
_ASTERISK_ITALIC_RE = re.compile(r"\*(\S(?:[^*\n]*?\S)?)\*")
_UNDERSCORE_ITALIC_RE = re.compile(r"(?<![\w])_(\S(?:[^_\n]*?\S)?)_(?![\w])")

_LINK_RE = re.compile(r"\[([^\]\n]+)\]\((\S+?)\)")


def _strip_and_bullet_lines(lines: list[str]) -> list[str]:
    output: list[str] = []
    for line in lines:
        if _HR_RE.match(line):
            continue
        bullet_match = _BULLET_RE.match(line)
        if bullet_match:
            indent, content = bullet_match.groups()
            output.append(f"{indent}• {content}")
            continue
        output.append(line)
    return output


def _parse_table_row(line: str) -> list[str]:
    stripped = line.strip().strip("|")
    return [cell.strip() for cell in stripped.split("|")]


def _is_table_separator(line: str) -> bool:
    if "|" not in line or "-" not in line:
        return False
    cells = _parse_table_row(line)
    return bool(cells) and all(_TABLE_SEPARATOR_CELL_RE.match(cell) for cell in cells)


def _render_aligned_table(header: list[str], rows: list[list[str]]) -> str:
    column_count = len(header)
    widths = [len(cell) for cell in header]
    for row in rows:
        for index in range(min(column_count, len(row))):
            widths[index] = max(widths[index], len(row[index]))

    def render_row(cells: list[str]) -> str:
        padded = [
            (cells[index] if index < len(cells) else "").ljust(widths[index])
            for index in range(column_count)
        ]
        return " | ".join(padded)

    lines = [render_row(header), "-+-".join("-" * width for width in widths)]
    lines.extend(render_row(row) for row in rows)
    return "```\n" + "\n".join(lines) + "\n```"


def _render_key_value_list(rows: list[list[str]]) -> str:
    lines = []
    for row in rows:
        key = row[0] if len(row) > 0 else ""
        value = row[1] if len(row) > 1 else ""
        lines.append(f"*{key}:* {value}")
    return "\n".join(lines)


def _convert_tables(lines: list[str], protector: _Protector) -> list[str]:
    output: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if (
            "|" in line
            and line.strip()
            and index + 1 < len(lines)
            and _is_table_separator(lines[index + 1])
        ):
            header = _parse_table_row(line)
            next_index = index + 2
            rows: list[list[str]] = []
            while (
                next_index < len(lines)
                and "|" in lines[next_index]
                and lines[next_index].strip()
            ):
                rows.append(_parse_table_row(lines[next_index]))
                next_index += 1

            rendered = (
                _render_key_value_list(rows)
                if len(header) == 2
                else _render_aligned_table(header, rows)
            )
            output.append(protector.protect(rendered))
            index = next_index
            continue
        output.append(line)
        index += 1
    return output


def _convert_headings(lines: list[str], protector: _Protector) -> list[str]:
    output: list[str] = []
    for line in lines:
        match = _HEADING_RE.match(line)
        if match:
            output.append(protector.protect(f"*{match.group(1)}*"))
        else:
            output.append(line)
    return output


def _convert_emphasis_and_links(text: str) -> str:
    bold_protector = _Protector(tag="B")

    def stash_bold(match: re.Match[str]) -> str:
        return bold_protector.protect(f"*{match.group(2)}*")

    text = _BOLD_RE.sub(stash_bold, text)
    text = _ASTERISK_ITALIC_RE.sub(lambda match: f"_{match.group(1)}_", text)
    text = _UNDERSCORE_ITALIC_RE.sub(lambda match: f"_{match.group(1)}_", text)
    text = bold_protector.restore(text)
    return _LINK_RE.sub(lambda match: f"<{match.group(2)}|{match.group(1)}>", text)


_ENTITY_SPAN_RE = re.compile(
    r"<span\s+data-entity=(['\"]).*?\1\s*>(.*?)</span>", re.DOTALL
)
# The agent's in-app entity token: a bare inline JSON object carrying a
# context_type/id/display triple. Slack renders it as noise; keep the display.
_ENTITY_JSON_RE = re.compile(
    r"\{\s*\"context_type\"\s*:\s*\"[^\"]*\"\s*,\s*\"id\"\s*:\s*\"[^\"]*\"\s*,"
    r"\s*\"display\"\s*:\s*\"([^\"]*)\"\s*\}"
)


def _strip_entity_markup(text: str) -> str:
    text = _ENTITY_SPAN_RE.sub(lambda match: match.group(2), text)
    return _ENTITY_JSON_RE.sub(lambda match: match.group(1), text)


def markdown_to_slack_mrkdwn(text: str) -> str:
    """Apply the ordered, conservative Markdown-to-mrkdwn conversion."""
    if not text:
        return text

    text = _strip_entity_markup(text)
    protector = _Protector()
    text = _FENCED_CODE_RE.sub(lambda match: protector.protect(match.group(0)), text)
    text = _INLINE_CODE_RE.sub(lambda match: protector.protect(match.group(0)), text)

    lines = _strip_and_bullet_lines(text.split("\n"))
    lines = _convert_tables(lines, protector)
    lines = _convert_headings(lines, protector)
    text = _convert_emphasis_and_links("\n".join(lines))
    return protector.restore(text)


def to_mrkdwn(text: str) -> str:
    """Concise transport-facing alias."""
    return markdown_to_slack_mrkdwn(text)
