"""Public, embeddable program surface: the published schedule + speaker gallery.

No JWT here — the event *slug* is the only credential, and org/event context is
derived from the ``events`` row it resolves to, never from the request. So a
reader can only ever see the programme of the event whose slug they hold.

Everything served here is deliberately public data:

  * the *published* programme — sessions that are ``accepted`` AND scheduled
    (``starts_at`` is set). There is no ``is_public`` column on ``sessions``
    (see migration 001); a session becomes public by being accepted and placed
    on the grid, so accepted+scheduled *is* the public criterion.
  * public-facing speaker fields only — name, title, company, headshot, bio and
    social links. Email and phone are never selected, let alone returned.
"""

from __future__ import annotations

import html
import logging
import re
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request, Response

from security.rate_limiting import RATE_PUBLIC_DEFAULT, limiter
from services.branding import resolve_branding
from services.ics import escape_text, format_utc
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

router = APIRouter(prefix="/public/program", tags=["public-program"])
logger = logging.getLogger(__name__)

SPEAKER_ROLE = "speaker"
SUBMITTER_ROLE = "submitter"
PUBLIC_READ_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300"

# The tiny, dependency-free embed loader. Generic across events: it reads the
# slug and widget from its own <script> tag's data-* attributes rather than
# having them injected server-side, so this response carries no untrusted data.
# The <iframe> is the isolation boundary; the parent only ever learns a height.
EMBED_JS = """\
(function () {
  var script = document.currentScript;
  if (!script) return;
  var slug = script.getAttribute('data-dais-event');
  var widget = script.getAttribute('data-dais-widget') || 'schedule';
  var track = script.getAttribute('data-dais-track');
  var accent = script.getAttribute('data-dais-accent');
  var compact = script.getAttribute('data-dais-compact');
  if (!slug) return;
  if (widget !== 'schedule' && widget !== 'speakers') widget = 'schedule';
  var origin = '';
  try { origin = new URL(script.src).origin; } catch (e) { origin = ''; }
  var iframe = document.createElement('iframe');
  var params = [];
  if (track) params.push('track=' + encodeURIComponent(track));
  if (accent && /^[0-9a-fA-F]{6}$/.test(accent)) params.push('accent=' + accent);
  if (compact === '1') params.push('compact=1');
  iframe.src = origin + '/e/' + encodeURIComponent(slug) + '/' + widget + '?embed=1' +
    (params.length ? '&' + params.join('&') : '');
  iframe.title = 'dais ' + widget;
  iframe.loading = 'lazy';
  iframe.scrolling = 'no';
  iframe.style.width = '100%';
  iframe.style.border = '0';
  iframe.style.display = 'block';
  iframe.style.overflow = 'hidden';
  iframe.style.height = '600px';
  script.parentNode.insertBefore(iframe, script);
  window.addEventListener('message', function (event) {
    if (event.source !== iframe.contentWindow) return;
    var data = event.data;
    if (!data || data.type !== 'dais-embed-height') return;
    var h = parseInt(data.height, 10);
    if (h > 0) iframe.style.height = h + 'px';
  });
})();
"""


# ── helpers ──────────────────────────────────────────────────────────────────


def _parse_dt(value: object) -> datetime | None:
    """An aware datetime from the ISO text PostgREST returns. Naive is read UTC."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _resolve_timezone(tz: str | None, fallback: str | None) -> tuple[ZoneInfo, str]:
    """The IANA zone to group/label by: caller's ?tz, else the event's, else UTC.

    A bad or unknown name never 500s the page — it just falls through to the
    next candidate.
    """
    for candidate in (tz, fallback, "UTC"):
        if not candidate:
            continue
        try:
            return ZoneInfo(candidate), candidate
        except Exception:  # noqa: BLE001, S112 — a bad ?tz is user input, not an error
            continue
    return ZoneInfo("UTC"), "UTC"


def _speaker_name(contact: dict) -> str:
    return f"{contact.get('first_name') or ''} {contact.get('last_name') or ''}".strip()


def _plain_text(value: object) -> str:
    """Match the browser schedule export: strip tags and collapse whitespace."""
    without_tags = re.sub(r"<[^>]+>", " ", str(value or ""))
    return " ".join(html.unescape(without_tags).replace("\xa0", " ").split())


def _event_day_window(event: dict) -> tuple[str, str] | None:
    """The event's configured run of days, as ("YYYY-MM-DD", "YYYY-MM-DD").

    Read in the EVENT's own zone — the zone the organizer configured the span in
    and the one the builder draws its day tabs from — never the caller's ``?tz``,
    which would let a query parameter change which sessions are part of the
    conference. ``None`` when the event has no configured span: there is nothing
    to clamp to, so nothing is clamped.
    """
    start_instant = _parse_dt(event.get("starts_at"))
    if not start_instant:
        return None
    zone, _key = _resolve_timezone(None, event.get("timezone"))
    first = start_instant.astimezone(zone).date()

    end_instant = _parse_dt(event.get("ends_at"))
    # The end is exclusive: an event ending exactly at local midnight belongs to
    # the previous day, so read the day of the minute before it.
    last = (
        (end_instant - timedelta(minutes=1)).astimezone(zone).date()
        if end_instant
        else first
    )
    # A span that ends before it starts is nonsense data, not a reason to publish
    # nothing: treat it as the single opening day.
    last = max(last, first)
    return first.isoformat(), last.isoformat()


def _within_event_days(session: dict, event: dict, window: tuple[str, str] | None) -> bool:
    """Is this placement on a real conference day?

    The public programme is a list of what happens AT the conference. A session
    left on a date outside the event's span (a date change moved the event out
    from under it, say) is not on a conference day at all, so it does not belong
    on the public page — exactly the clamp the builder applies to its day tabs.
    """
    if not window:
        return True
    at = _parse_dt(session.get("starts_at"))
    if not at:
        return False
    zone, _key = _resolve_timezone(None, event.get("timezone"))
    day = at.astimezone(zone).date().isoformat()
    return window[0] <= day <= window[1]


async def _load_event(slug: str) -> dict:
    """The public event row for ``slug``, or 404. Org context comes from here."""
    event = first(
        await db(
            lambda: supabase.table("events")
            .select(
                "id, org_id, name, slug, starts_at, ends_at, timezone, location, branding"
            )
            .eq("slug", slug)
            .limit(1)
            .execute(),
            "program_event_by_slug",
        )
    )
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


async def _accepted_sessions(org_id: str, event_id: str) -> list[dict]:
    """Every accepted session for the event. `starts_at` may be null — the
    schedule endpoint drops the unscheduled ones; the gallery keeps them."""
    accepted = rows(
        await db(
            lambda: supabase.table("sessions")
            .select(
                "id, friendly_id, title, description, content_approval, starts_at, ends_at, "
                "room_id, track_id, format_id"
            )
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("status", "accepted")
            .execute(),
            "program_accepted_sessions",
        )
    )
    # Missing means a pre-migration/fake row and has the migration's approved
    # default semantics. The field is deliberately not returned publicly, so an
    # untouched programme's payload stays byte-for-byte identical.
    return [
        session
        for session in accepted
        if session.get("content_approval") not in ("draft", "in_review")
    ]


async def _name_maps(
    org_id: str, event_id: str
) -> tuple[dict[str, str], dict[str, dict], dict[str, str]]:
    """({room_id: name}, {track_id: {name, color}}, {format_id: name}) for the event."""
    rooms = rows(
        await db(
            lambda: supabase.table("rooms")
            .select("id, name")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "program_rooms",
        )
    )
    tracks = rows(
        await db(
            lambda: supabase.table("tracks")
            .select("id, name, color")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "program_tracks",
        )
    )
    formats = rows(
        await db(
            lambda: supabase.table("formats")
            .select("id, name")
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .execute(),
            "program_formats",
        )
    )
    room_names = {str(r["id"]): r.get("name") or "" for r in rooms if r.get("id")}
    track_meta = {
        str(t["id"]): {"name": t.get("name") or "", "color": t.get("color") or None}
        for t in tracks
        if t.get("id")
    }
    format_names = {str(f["id"]): f.get("name") or "" for f in formats if f.get("id")}
    return room_names, track_meta, format_names


async def _speakers_by_session(
    session_ids: list[str], org_id: str
) -> tuple[dict[str, list[dict]], dict[str, dict]]:
    """Resolve the on-stage humans for each session.

    Returns ({session_id: [contact, ...ordered]}, {contact_id: contact}). The
    chosen role is ``speaker``, falling back to ``submitter`` when no speaker has
    been assigned — an accepted talk has one known human on it either way. Two
    queries rather than a PostgREST embed, so the org predicate rides every hop.
    Only public contact fields are selected: never email or phone.
    """
    if not session_ids:
        return {}, {}

    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("session_id, contact_id, role, is_primary")
            .in_("session_id", session_ids)
            .eq("org_id", org_id)
            .execute(),
            "program_participants",
        )
    )

    by_session: dict[str, list[dict]] = {}
    for participant in participants:
        if not participant.get("contact_id"):
            continue
        by_session.setdefault(str(participant["session_id"]), []).append(participant)

    chosen: dict[str, list[dict]] = {}
    for session_id, group in by_session.items():
        speakers = [p for p in group if p.get("role") == SPEAKER_ROLE]
        if not speakers:
            speakers = [p for p in group if p.get("role") == SUBMITTER_ROLE]
        if speakers:
            chosen[session_id] = speakers

    contact_ids = sorted({str(p["contact_id"]) for group in chosen.values() for p in group})
    if not contact_ids:
        return {}, {}

    contacts = rows(
        await db(
            lambda: supabase.table("contacts")
            .select(
                "id, first_name, last_name, title, company_name, "
                "photo_url, about, linkedin_url, twitter_url"
            )
            .in_("id", contact_ids)
            .eq("org_id", org_id)
            .execute(),
            "program_speaker_contacts",
        )
    )
    contacts_by_id = {str(c["id"]): c for c in contacts}

    resolved: dict[str, list[dict]] = {}
    for session_id, group in chosen.items():
        people = [
            (bool(p.get("is_primary")), contacts_by_id[str(p["contact_id"])])
            for p in group
            if str(p.get("contact_id")) in contacts_by_id
        ]
        # Primary first, then alphabetical by last then first name.
        people.sort(
            key=lambda t: (
                not t[0],
                str(t[1].get("last_name") or "").casefold(),
                str(t[1].get("first_name") or "").casefold(),
                str(t[1].get("id")),
            )
        )
        if people:
            resolved[session_id] = [contact for _primary, contact in people]
    return resolved, contacts_by_id


# ── endpoints ────────────────────────────────────────────────────────────────


@router.get("/{event_slug}/schedule")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def get_schedule(
    request: Request, response: Response, event_slug: str, tz: str | None = None
):
    """The published programme, grouped by day and ordered by time then room.

    Only ``accepted`` sessions that are scheduled (``starts_at`` set) *and placed
    on one of the event's own days* appear — the same clamp the builder puts on
    its day tabs. A session stranded outside the event's date span is not on a
    conference day, so publishing it would invent one. Days and times are grouped
    in ``tz`` (an IANA name) when given, else the event's own timezone.
    """
    response.headers["Cache-Control"] = PUBLIC_READ_CACHE_CONTROL
    event = await _load_event(event_slug)
    org_id, event_id = event["org_id"], event["id"]

    zone, zone_key = _resolve_timezone(tz, event.get("timezone"))
    sessions = await _accepted_sessions(org_id, event_id)
    room_names, track_meta, format_names = await _name_maps(org_id, event_id)

    window = _event_day_window(event)
    scheduled = [
        s for s in sessions if s.get("starts_at") and _within_event_days(s, event, window)
    ]
    speakers_by_session, _contacts = await _speakers_by_session(
        [str(s["id"]) for s in scheduled], org_id
    )

    # Time first, then room name — the reading order of a printed programme.
    scheduled.sort(
        key=lambda s: (
            _parse_dt(s.get("starts_at")) or datetime.max.replace(tzinfo=timezone.utc),
            room_names.get(str(s.get("room_id")), "").casefold(),
        )
    )

    days: OrderedDict[str, list[dict]] = OrderedDict()
    for session in scheduled:
        local = _parse_dt(session["starts_at"]).astimezone(zone)
        day_key = local.date().isoformat()
        track = track_meta.get(str(session.get("track_id")))
        days.setdefault(day_key, []).append(
            {
                "id": str(session["id"]),
                "friendly_id": session.get("friendly_id"),
                "title": session.get("title") or "",
                "description": session.get("description") or "",
                "starts_at": session.get("starts_at"),
                "ends_at": session.get("ends_at"),
                "room": room_names.get(str(session.get("room_id"))) or None,
                "track": track,
                "format": format_names.get(str(session.get("format_id"))) or None,
                "speakers": [
                    {
                        "name": _speaker_name(contact),
                        "title": contact.get("title") or None,
                        "company": contact.get("company_name") or None,
                        "photo_url": contact.get("photo_url") or None,
                    }
                    for contact in speakers_by_session.get(str(session["id"]), [])
                ],
            }
        )

    return {
        "event": {
            "name": event.get("name"),
            "starts_at": event.get("starts_at"),
            "ends_at": event.get("ends_at"),
            "timezone": zone_key,
            "location": event.get("location"),
            "branding": resolve_branding(event),
        },
        "days": [{"date": date, "sessions": items} for date, items in days.items()],
    }


@router.get("/{event_slug}/speakers")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def get_speakers(request: Request, response: Response, event_slug: str):
    """The speaker gallery: every distinct speaker on an accepted session,
    alphabetical by last name, each with their sessions and public bio."""
    response.headers["Cache-Control"] = PUBLIC_READ_CACHE_CONTROL
    event = await _load_event(event_slug)
    org_id, event_id = event["org_id"], event["id"]

    sessions = await _accepted_sessions(org_id, event_id)
    room_names, track_meta, format_names = await _name_maps(org_id, event_id)
    sessions_by_id = {str(s["id"]): s for s in sessions}
    speakers_by_session, contacts_by_id = await _speakers_by_session(
        [str(s["id"]) for s in sessions], org_id
    )

    # contact_id -> the accepted sessions they speak on.
    sessions_for_contact: dict[str, list[dict]] = {}
    for session_id, contacts in speakers_by_session.items():
        session = sessions_by_id.get(session_id)
        if not session:
            continue
        for contact in contacts:
            sessions_for_contact.setdefault(str(contact["id"]), []).append(session)

    # Alphabetical by last name (then first), read off the contact row rather
    # than a split of the display name.
    ordered_ids = sorted(
        sessions_for_contact,
        key=lambda cid: (
            str(contacts_by_id[cid].get("last_name") or "").casefold(),
            str(contacts_by_id[cid].get("first_name") or "").casefold(),
            cid,
        ),
    )

    speakers = []
    for contact_id in ordered_ids:
        contact = contacts_by_id[contact_id]
        sess_list = sessions_for_contact[contact_id]
        sess_list.sort(
            key=lambda s: (
                s.get("starts_at") is None,
                str(s.get("starts_at") or ""),
                str(s.get("title") or "").casefold(),
            )
        )
        speakers.append(
            {
                # The contact id, so the gallery has ONE stable identity per
                # person: its React key, its de-duplication key, and the reason
                # two different people who happen to share a display name can
                # never collapse into — or double-render as — one card.
                "id": contact_id,
                "name": _speaker_name(contact),
                "title": contact.get("title") or None,
                "company": contact.get("company_name") or None,
                "photo_url": contact.get("photo_url") or None,
                "bio": contact.get("about") or None,
                "linkedin_url": contact.get("linkedin_url") or None,
                "twitter_url": contact.get("twitter_url") or None,
                "sessions": [
                    {
                        "id": str(s["id"]),
                        "title": s.get("title") or "",
                        "starts_at": s.get("starts_at"),
                        "room": room_names.get(str(s.get("room_id"))) or None,
                        "track": track_meta.get(str(s.get("track_id"))),
                        "format": format_names.get(str(s.get("format_id"))) or None,
                    }
                    for s in sess_list
                ],
            }
        )

    return {
        "event": {
            "name": event.get("name"),
            "timezone": event.get("timezone"),
            "branding": resolve_branding(event),
        },
        "speakers": speakers,
    }


@router.get("/{event_slug}/calendar.ics")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def get_calendar_feed(request: Request, event_slug: str):
    """A cacheable iCalendar feed of the accepted, published schedule."""
    event = await _load_event(event_slug)
    org_id, event_id = event["org_id"], event["id"]
    sessions = await _accepted_sessions(org_id, event_id)
    room_names, _track_meta, _format_names = await _name_maps(org_id, event_id)
    window = _event_day_window(event)
    scheduled = [
        session
        for session in sessions
        if session.get("starts_at") and _within_event_days(session, event, window)
    ]
    scheduled.sort(
        key=lambda session: _parse_dt(session.get("starts_at"))
        or datetime.max.replace(tzinfo=timezone.utc)
    )

    stamp = format_utc(datetime.now(timezone.utc))
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//dais//EN", "CALSCALE:GREGORIAN"]
    for session in scheduled:
        starts_at = _parse_dt(session.get("starts_at"))
        if starts_at is None:
            continue
        ends_at = _parse_dt(session.get("ends_at")) or starts_at + timedelta(hours=1)
        uid = session.get("friendly_id") or session["id"]
        location = ", ".join(
            value
            for value in (
                room_names.get(str(session.get("room_id"))),
                event.get("location"),
            )
            if value
        )
        description = _plain_text(session.get("description"))
        lines.extend(
            [
                "BEGIN:VEVENT",
                f"UID:{uid}@dais",
                f"DTSTAMP:{stamp}",
                f"DTSTART:{format_utc(starts_at)}",
                f"DTEND:{format_utc(ends_at)}",
                f"SUMMARY:{escape_text(session.get('title') or 'Session')}",
            ]
        )
        if description:
            lines.append(f"DESCRIPTION:{escape_text(description)}")
        if location:
            lines.append(f"LOCATION:{escape_text(location)}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")

    return Response(
        content="\r\n".join(lines),
        media_type="text/calendar",
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/{event_slug}/session/{session_id}")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def get_session_detail(
    request: Request, response: Response, event_slug: str, session_id: str
):
    """One accepted session's public detail, for the schedule's detail modal.

    The schedule list clamps its cards; this returns the *full* description plus
    the speakers' bios and social links, which the list omits. Only ``accepted``
    sessions of this event resolve — anything else (wrong org, pending, unknown
    id) is a 404, never a peek at another event's programme.
    """
    response.headers["Cache-Control"] = PUBLIC_READ_CACHE_CONTROL
    event = await _load_event(event_slug)
    org_id, event_id = event["org_id"], event["id"]

    session = first(
        await db(
            lambda: supabase.table("sessions")
            .select(
                "id, friendly_id, title, description, content_approval, starts_at, ends_at, "
                "room_id, track_id, format_id"
            )
            .eq("org_id", org_id)
            .eq("event_id", event_id)
            .eq("id", session_id)
            .eq("status", "accepted")
            .limit(1)
            .execute(),
            "program_session_detail",
        )
    )
    if not session or session.get("content_approval") in ("draft", "in_review"):
        raise HTTPException(status_code=404, detail="Session not found")

    _zone, zone_key = _resolve_timezone(None, event.get("timezone"))
    room_names, track_meta, format_names = await _name_maps(org_id, event_id)
    speakers_by_session, _contacts = await _speakers_by_session([str(session["id"])], org_id)

    speakers = [
        {
            "name": _speaker_name(contact),
            "title": contact.get("title") or None,
            "company": contact.get("company_name") or None,
            "photo_url": contact.get("photo_url") or None,
            "bio": contact.get("about") or None,
            "linkedin_url": contact.get("linkedin_url") or None,
            "twitter_url": contact.get("twitter_url") or None,
        }
        for contact in speakers_by_session.get(str(session["id"]), [])
    ]

    return {
        "event": {
            "name": event.get("name"),
            "timezone": zone_key,
            "location": event.get("location"),
            "branding": resolve_branding(event),
        },
        "session": {
            "id": str(session["id"]),
            "friendly_id": session.get("friendly_id"),
            "title": session.get("title") or "",
            "description": session.get("description") or "",
            "starts_at": session.get("starts_at"),
            "ends_at": session.get("ends_at"),
            "room": room_names.get(str(session.get("room_id"))) or None,
            "track": track_meta.get(str(session.get("track_id"))),
            "format": format_names.get(str(session.get("format_id"))) or None,
            "speakers": speakers,
        },
    }


@router.get("/{event_slug}/embed.js")
@limiter.limit(RATE_PUBLIC_DEFAULT)
async def get_embed_js(request: Request, event_slug: str):
    """The embed loader script. Generic across events and widgets; it reads the
    slug/widget from its own <script data-dais-event=… data-dais-widget=…> tag
    and injects a sized <iframe> pointing at /e/{slug}/{widget}?embed=1."""
    return Response(
        content=EMBED_JS,
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=3600"},
    )
