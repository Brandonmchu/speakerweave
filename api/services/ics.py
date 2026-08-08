"""RFC 5545 iCalendar generation — stdlib only, no calendar dependency.

Hand-rolled on purpose. The invite is the product's headline feature and its
failure mode is invisible: Gmail/Outlook quietly fall back to "here is a file"
instead of native invite UI when a single byte is off. A small generator we can
golden-test to the byte beats a dependency whose defaults we'd have to audit
anyway.

Deliberate simplifications:
  * Times are always emitted as UTC (``...Z``). No VTIMEZONE blocks — every
    client renders UTC in the viewer's local zone, and a subtly wrong VTIMEZONE
    is worse than none at all. ``timezone_id`` is used only to localize naive
    datetimes on the way in.
  * Only METHOD:REQUEST and METHOD:CANCEL exist. REPLY/COUNTER are inbound
    concerns we don't process.
  * One VEVENT per attendee (one invite per (session, contact)), so there is no
    ATTENDEE list to keep in sync and each recipient gets a stable UID.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

logger = logging.getLogger(__name__)

CRLF = "\r\n"
PRODID = "-//dais//EN"
# RFC 5545 §3.1: content lines SHOULD NOT be longer than 75 octets, CRLF excluded.
MAX_LINE_OCTETS = 75

METHOD_REQUEST = "REQUEST"
METHOD_CANCEL = "CANCEL"
METHODS = (METHOD_REQUEST, METHOD_CANCEL)

GOOGLE_CALENDAR_BASE = "https://calendar.google.com/calendar/render"
OUTLOOK_BASE = "https://outlook.office.com/calendar/0/deeplink/compose"

# Unquoted param values may not contain these (RFC 5545 §3.2).
_PARAM_SPECIALS = ',;:"'
# Both vendors document their date ranges as 20261012T160000Z/... and
# 2026-10-12T16:00:00Z — keep those readable instead of %2F / %3A soup.
_URL_SAFE = "/:"


def zone(timezone_id: str | None) -> ZoneInfo | timezone:
    """IANA zone by name, falling back to UTC rather than raising.

    A bad/absent zone database must never block an invite: UTC output is still
    correct, just displayed in the viewer's own zone.
    """
    if not timezone_id:
        return timezone.utc
    try:
        return ZoneInfo(timezone_id)
    except (ZoneInfoNotFoundError, ValueError):
        logger.warning("ics: unknown timezone %r, falling back to UTC", timezone_id)
        return timezone.utc


def to_utc(value: datetime, timezone_id: str | None = None) -> datetime:
    """Normalize to an aware UTC datetime. Naive input is read as timezone_id."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=zone(timezone_id))
    return value.astimezone(timezone.utc)


def format_utc(value: datetime, timezone_id: str | None = None) -> str:
    """UTC form: 20261012T160000Z."""
    return to_utc(value, timezone_id).strftime("%Y%m%dT%H%M%SZ")


def escape_text(value: object) -> str:
    """Escape a TEXT value (RFC 5545 §3.3.11). Backslash must go first."""
    if value is None:
        return ""
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\r", "\\n")
        .replace("\n", "\\n")
    )


def fold_line(line: str) -> str:
    """Fold one content line at 75 octets; continuations start with one space.

    Folding is measured in octets, not characters, and must never split a
    multi-octet UTF-8 sequence — a continuation line that starts mid-character
    is what turns a valid invite into an unparseable one.
    """
    raw = line.encode("utf-8")
    if len(raw) <= MAX_LINE_OCTETS:
        return line

    chunks: list[bytes] = []
    limit = MAX_LINE_OCTETS
    while raw:
        take = min(limit, len(raw))
        # Walk back off a continuation byte (0b10xxxxxx) so chunks stay decodable.
        while take < len(raw) and raw[take] & 0xC0 == 0x80:
            take -= 1
        chunks.append(raw[:take])
        raw = raw[take:]
        limit = MAX_LINE_OCTETS - 1  # the leading space costs an octet
    return (CRLF + " ").join(chunk.decode("utf-8") for chunk in chunks)


def _param_value(value: object) -> str:
    """A parameter value, quoted only when it has to be."""
    cleaned = str(value or "").replace('"', "'").replace("\r", " ").replace("\n", " ").strip()
    if any(ch in _PARAM_SPECIALS for ch in cleaned):
        return f'"{cleaned}"'
    return cleaned


def _cal_address(prop: str, email: str, name: str | None, *params: str) -> str:
    parts = [prop]
    if name:
        parts.append(f";CN={_param_value(name)}")
    for param in params:
        parts.append(f";{param}")
    parts.append(f":mailto:{email}")
    return "".join(parts)


def build_invite(
    method: str,
    uid: str,
    sequence: int,
    summary: str,
    description: str,
    starts_at: datetime | None,
    ends_at: datetime | None,
    timezone_id: str,
    location: str,
    organizer_email: str,
    organizer_name: str,
    attendee_email: str,
    attendee_name: str,
    url: str | None = None,
    now: datetime | None = None,
) -> str:
    """Render one VCALENDAR/VEVENT as an RFC 5545 document (CRLF throughout).

    ``now`` is injectable so DTSTAMP is deterministic in tests. For CANCEL the
    times may be None — a cancellation is matched on UID + SEQUENCE, so a
    session that has since been unscheduled can still be cancelled.
    """
    method = (method or "").upper()
    if method not in METHODS:
        raise ValueError(f"Unsupported METHOD {method!r}; expected one of {METHODS}")

    is_cancel = method == METHOD_CANCEL
    if not is_cancel and (starts_at is None or ends_at is None):
        raise ValueError("METHOD:REQUEST needs both starts_at and ends_at")

    stamp = to_utc(now or datetime.now(timezone.utc))

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        f"PRODID:{PRODID}",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        f"METHOD:{method}",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"SEQUENCE:{max(0, int(sequence))}",
        f"DTSTAMP:{format_utc(stamp)}",
    ]
    if starts_at is not None:
        lines.append(f"DTSTART:{format_utc(starts_at, timezone_id)}")
    if ends_at is not None:
        lines.append(f"DTEND:{format_utc(ends_at, timezone_id)}")

    lines.append(f"SUMMARY:{escape_text(summary)}")
    if description:
        lines.append(f"DESCRIPTION:{escape_text(description)}")
    if location:
        lines.append(f"LOCATION:{escape_text(location)}")
    if url:
        # URI value type: not TEXT, so no escaping — only folding.
        lines.append(f"URL:{url}")

    lines.append(_cal_address("ORGANIZER", organizer_email, organizer_name))
    lines.append(
        _cal_address(
            "ATTENDEE",
            attendee_email,
            attendee_name,
            "ROLE=REQ-PARTICIPANT",
            "PARTSTAT=NEEDS-ACTION",
            "RSVP=TRUE",
        )
    )

    if is_cancel:
        # TRANSPARENT so the dead slot stops blocking free/busy lookups.
        lines.extend(["STATUS:CANCELLED", "TRANSP:TRANSPARENT"])
    else:
        lines.extend(["STATUS:CONFIRMED", "TRANSP:OPAQUE"])

    lines.extend(["END:VEVENT", "END:VCALENDAR"])
    return "".join(fold_line(line) + CRLF for line in lines)


def build_google_calendar_url(
    summary: str,
    description: str,
    starts_at: datetime,
    ends_at: datetime,
    timezone_id: str = "UTC",
    location: str = "",
) -> str:
    """Add-to-calendar link for Google Calendar (no email round trip)."""
    params = {
        "action": "TEMPLATE",
        "text": summary or "",
        "dates": f"{format_utc(starts_at, timezone_id)}/{format_utc(ends_at, timezone_id)}",
        "details": description or "",
        "location": location or "",
        "ctz": timezone_id or "UTC",
    }
    return f"{GOOGLE_CALENDAR_BASE}?{urlencode(params, quote_via=quote, safe=_URL_SAFE)}"


def build_outlook_url(
    summary: str,
    description: str,
    starts_at: datetime,
    ends_at: datetime,
    timezone_id: str = "UTC",
    location: str = "",
) -> str:
    """Add-to-calendar link for Outlook on the web (personal + work accounts)."""
    params = {
        "path": "/calendar/action/compose",
        "rru": "addevent",
        "subject": summary or "",
        "startdt": to_utc(starts_at, timezone_id).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "enddt": to_utc(ends_at, timezone_id).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "body": description or "",
        "location": location or "",
    }
    return f"{OUTLOOK_BASE}?{urlencode(params, quote_via=quote, safe=_URL_SAFE)}"
