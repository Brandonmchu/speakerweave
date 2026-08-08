"""Byte-level tests for the invite pipeline.

These are golden-file tests on purpose. An ICS that is 99% right still renders
as "an attachment" instead of Yes/No/Maybe buttons, and nothing else in the
suite would notice — so the expected document is spelled out in full and any
drift has to be an explicit decision.
"""

from __future__ import annotations

import email
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from services import mailer
from services.ics import (
    MAX_LINE_OCTETS,
    build_google_calendar_url,
    build_invite,
    build_outlook_url,
    escape_text,
    fold_line,
    format_utc,
)

PT = ZoneInfo("America/Los_Angeles")
NOW = datetime(2026, 8, 8, 12, 0, 0, tzinfo=timezone.utc)
STARTS = datetime(2026, 10, 12, 9, 0, tzinfo=PT)  # 16:00Z
ENDS = datetime(2026, 10, 12, 9, 30, tzinfo=PT)  # 16:30Z
# Same wall clock, zone stripped — what a naive DB read looks like.
NAIVE_STARTS = STARTS.replace(tzinfo=None)
NAIVE_ENDS = ENDS.replace(tzinfo=None)
UID = "dais-11111111-1111-1111-1111-111111111111-22222222-2222-2222-2222-222222222222@dais.events"

CRLF = "\r\n"


def invite(**overrides) -> str:
    kwargs = {
        "method": "REQUEST",
        "uid": UID,
        "sequence": 0,
        "summary": "Scaling LLM inference",
        "description": "A practical tour.\nBring questions.",
        "starts_at": STARTS,
        "ends_at": ENDS,
        "timezone_id": "America/Los_Angeles",
        "location": "Main Stage, San Francisco",
        "organizer_email": "organizer@dais.events",
        "organizer_name": "AI Builders Summit",
        "attendee_email": "ada@example.com",
        "attendee_name": "Ada Lovelace",
        "url": "https://dais.events/agenda/ai-builders-summit",
        "now": NOW,
    }
    kwargs.update(overrides)
    return build_invite(**kwargs)


GOLDEN_REQUEST = CRLF.join(
    [
        "BEGIN:VCALENDAR",
        "PRODID:-//dais//EN",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:dais-11111111-1111-1111-1111-111111111111-22222222-2222-2222-2222-22222",
        " 2222222@dais.events",
        "SEQUENCE:0",
        "DTSTAMP:20260808T120000Z",
        "DTSTART:20261012T160000Z",
        "DTEND:20261012T163000Z",
        "SUMMARY:Scaling LLM inference",
        "DESCRIPTION:A practical tour.\\nBring questions.",
        "LOCATION:Main Stage\\, San Francisco",
        "URL:https://dais.events/agenda/ai-builders-summit",
        "ORGANIZER;CN=AI Builders Summit:mailto:organizer@dais.events",
        "ATTENDEE;CN=Ada Lovelace;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TR",
        " UE:mailto:ada@example.com",
        "STATUS:CONFIRMED",
        "TRANSP:OPAQUE",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ]
)


# ── the document ───────────────────────────────────────────────────────────


def test_request_matches_golden_document():
    assert invite() == GOLDEN_REQUEST


def test_every_line_ends_with_crlf_and_none_is_bare_lf():
    """A lone LF is the single most common reason a client refuses an invite."""
    document = invite()
    assert document.endswith(CRLF)
    assert "\n" not in document.replace(CRLF, "")
    assert "\r" not in document.replace(CRLF, "")


def test_deterministic_with_injected_now():
    assert invite() == invite()


def test_dtstamp_follows_now():
    later = invite(now=datetime(2026, 8, 9, 1, 2, 3, tzinfo=timezone.utc))
    assert "DTSTAMP:20260809T010203Z" in later


# ── times ──────────────────────────────────────────────────────────────────


def test_local_times_are_emitted_as_utc():
    document = invite()
    assert "DTSTART:20261012T160000Z" in document
    assert "DTEND:20261012T163000Z" in document
    assert "VTIMEZONE" not in document  # UTC-only by design


def test_naive_times_are_read_in_the_event_timezone():
    document = invite(starts_at=NAIVE_STARTS, ends_at=NAIVE_ENDS)
    assert "DTSTART:20261012T160000Z" in document


def test_unknown_timezone_falls_back_to_utc_instead_of_raising():
    document = invite(
        timezone_id="Mars/Olympus_Mons",
        starts_at=NAIVE_STARTS,
        ends_at=NAIVE_ENDS,
    )
    assert "DTSTART:20261012T090000Z" in document


def test_format_utc_shape():
    assert format_utc(STARTS) == "20261012T160000Z"


# ── folding ────────────────────────────────────────────────────────────────


def test_long_summary_folds_at_75_octets_with_a_single_space():
    summary = "Scaling LLM inference to a million tokens per second without setting the datacenter on fire"
    document = invite(summary=summary)
    lines = document.split(CRLF)
    start = next(i for i, line in enumerate(lines) if line.startswith("SUMMARY:"))

    assert len(lines[start].encode("utf-8")) == MAX_LINE_OCTETS
    continuation = lines[start + 1]
    assert continuation.startswith(" ")
    assert not continuation.startswith("  ")
    # Unfolding (strip CRLF + one space) must return the original value.
    unfolded = (lines[start] + continuation[1:]).removeprefix("SUMMARY:")
    assert unfolded == summary


def test_no_line_exceeds_75_octets():
    document = invite(summary="x" * 400, description="y" * 400, location="z" * 200)
    for line in document.split(CRLF):
        assert len(line.encode("utf-8")) <= MAX_LINE_OCTETS


def test_folding_never_splits_a_multibyte_character():
    """Fold at 75 *octets*: a chunk that ends mid-sequence is unparseable."""
    line = "SUMMARY:" + "é" * 60
    folded = fold_line(line)
    for chunk in folded.split(CRLF):
        assert len(chunk.encode("utf-8")) <= MAX_LINE_OCTETS
    assert folded.replace(CRLF + " ", "") == line


def test_short_lines_are_not_folded():
    assert fold_line("SUMMARY:short") == "SUMMARY:short"


# ── escaping ───────────────────────────────────────────────────────────────


def test_text_escaping_of_semicolon_comma_and_newline():
    assert escape_text("Panel; AI, LLMs\nfuture") == "Panel\\; AI\\, LLMs\\nfuture"
    assert escape_text("back\\slash") == "back\\\\slash"


def test_escaped_summary_lands_in_the_document():
    document = invite(summary="Panel; AI, LLMs\nfuture")
    assert "SUMMARY:Panel\\; AI\\, LLMs\\nfuture" in document
    # The escaped newline must not become a real line break.
    assert len(document.split(CRLF)) == len(GOLDEN_REQUEST.split(CRLF))


def test_cn_with_a_comma_is_quoted():
    document = invite(attendee_name="Lovelace, Ada")
    assert 'ATTENDEE;CN="Lovelace, Ada";ROLE=REQ-PARTICIPANT' in document.replace(CRLF + " ", "")


# ── cancel ─────────────────────────────────────────────────────────────────


def test_cancel_variant():
    document = invite(method="CANCEL", sequence=3)
    assert "METHOD:CANCEL" in document
    assert "STATUS:CANCELLED" in document
    assert "TRANSP:TRANSPARENT" in document
    assert "STATUS:CONFIRMED" not in document
    assert "SEQUENCE:3" in document
    assert f"UID:{UID[:66]}" in document  # same UID as the REQUEST it cancels


def test_cancel_survives_an_unscheduled_session():
    """Unschedule-then-cancel still has to reach the calendar; UID+SEQUENCE match."""
    document = invite(method="CANCEL", sequence=1, starts_at=None, ends_at=None)
    assert "DTSTART" not in document
    assert "STATUS:CANCELLED" in document


def test_request_without_times_is_refused():
    with pytest.raises(ValueError):
        invite(starts_at=None, ends_at=None)


def test_unknown_method_is_refused():
    with pytest.raises(ValueError):
        invite(method="PUBLISH")


def test_sequence_is_rendered():
    assert "SEQUENCE:7" in invite(sequence=7)


# ── add-to-calendar links ──────────────────────────────────────────────────


def test_google_calendar_url():
    url = build_google_calendar_url(
        "Panel; AI, LLMs", "details", STARTS, ENDS, "America/Los_Angeles", "Main Stage"
    )
    assert url.startswith("https://calendar.google.com/calendar/render?action=TEMPLATE")
    assert "dates=20261012T160000Z/20261012T163000Z" in url
    assert "text=Panel%3B%20AI%2C%20LLMs" in url
    assert "ctz=America/Los_Angeles" in url


def test_outlook_url():
    url = build_outlook_url("Talk", "details", STARTS, ENDS, "America/Los_Angeles", "Main Stage")
    assert url.startswith("https://outlook.office.com/calendar/0/deeplink/compose")
    assert "startdt=2026-10-12T16:00:00Z" in url
    assert "enddt=2026-10-12T16:30:00Z" in url
    assert "rru=addevent" in url


# ── mailer MIME ────────────────────────────────────────────────────────────


@pytest.fixture
def dev_outbox(tmp_path, monkeypatch):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.setenv("OUTBOX_DIR", str(tmp_path))
    return tmp_path


async def test_dev_send_writes_an_eml_with_a_method_request_calendar_part(dev_outbox):
    ics = invite()
    receipt = await mailer.send_email(
        to="ada@example.com",
        subject="Invite: Scaling LLM inference",
        html="<p>You're confirmed.</p>",
        ics_content=ics,
        ics_method="REQUEST",
    )

    assert receipt["dev"] is True
    written = list(dev_outbox.glob("*.eml"))
    assert len(written) == 1
    raw = written[0].read_text(encoding="utf-8")

    # The parameter mail clients key off. Unquoted, exactly as documented.
    assert "Content-Type: text/calendar; charset=\"utf-8\"; method=REQUEST" in raw

    message = email.message_from_string(raw)
    parts = {part.get_content_type() for part in message.walk()}
    assert {"multipart/mixed", "multipart/alternative", "text/plain", "text/html"} <= parts

    calendar = next(p for p in message.walk() if p.get_content_type() == "text/calendar")
    assert calendar.get_param("method") == "REQUEST"
    # It must be an ALTERNATIVE, not just an attachment — that is what makes
    # Gmail/Outlook draw the native Yes/No/Maybe UI.
    assert calendar.get("Content-Disposition") is None
    # CRLF must survive transport encoding.
    assert calendar.get_payload(decode=True).decode("utf-8") == ics

    attachment = next(p for p in message.walk() if p.get_filename() == "invite.ics")
    assert attachment.get_payload(decode=True).decode("utf-8") == ics


async def test_dev_send_cancel_carries_method_cancel(dev_outbox):
    await mailer.send_email(
        to="ada@example.com",
        subject="Cancelled",
        html="<p>Cancelled.</p>",
        ics_content=invite(method="CANCEL", sequence=1),
        ics_method="CANCEL",
    )
    raw = next(iter(dev_outbox.glob("*.eml"))).read_text(encoding="utf-8")
    assert "method=CANCEL" in raw


async def test_plaintext_alternative_is_derived_from_the_html(dev_outbox):
    await mailer.send_email(
        to="ada@example.com",
        subject="Invite",
        html="<p>You&#39;re confirmed.</p><p>Main Stage</p>",
    )
    raw = next(iter(dev_outbox.glob("*.eml"))).read_text(encoding="utf-8")
    message = email.message_from_string(raw)
    plain = next(p for p in message.walk() if p.get_content_type() == "text/plain")
    body = plain.get_payload(decode=True).decode("utf-8")
    assert "You're confirmed." in body
    assert "<p>" not in body
