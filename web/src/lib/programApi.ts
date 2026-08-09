/**
 * Wire layer for the public, embeddable program surface (published schedule +
 * speaker gallery). These endpoints live under `/public/program`, so `request`
 * sends them anonymously — no bearer token, org/event derived from the slug.
 */

import { apiGet } from '@/lib/api'

// ── schedule ─────────────────────────────────────────────────────────────────

export interface ProgramSpeakerRef {
  name: string
  title: string | null
  company: string | null
  photo_url: string | null
}

export interface ProgramTrack {
  name: string
  color: string | null
}

export interface ProgramSession {
  id: string
  friendly_id: string | null
  title: string
  description: string
  starts_at: string | null
  ends_at: string | null
  room: string | null
  track: ProgramTrack | null
  speakers: ProgramSpeakerRef[]
}

export interface ProgramDay {
  date: string
  sessions: ProgramSession[]
}

export interface ProgramEvent {
  name: string | null
  starts_at: string | null
  ends_at: string | null
  timezone: string | null
  location: string | null
}

export interface ProgramSchedule {
  event: ProgramEvent
  days: ProgramDay[]
}

/**
 * GET /public/program/{slug}/schedule — the published, day-grouped agenda.
 *
 * No `tz` is sent: the public page must render in the EVENT's timezone (the one
 * the organizer published against), not the visitor's browser zone, so a Tokyo
 * reader sees the same day/time as the organizer. Omitting `tz` makes the API
 * group and label in the event's own zone. The optional `tz` argument remains
 * for callers that genuinely want a viewer-local rendering.
 */
export function getProgramSchedule(slug: string, tz?: string): Promise<ProgramSchedule> {
  const query = tz ? `?tz=${encodeURIComponent(tz)}` : ''
  return apiGet<ProgramSchedule>(`/public/program/${encodeURIComponent(slug)}/schedule${query}`)
}

// ── session detail ───────────────────────────────────────────────────────────

export interface ProgramSessionSpeaker {
  name: string
  title: string | null
  company: string | null
  photo_url: string | null
  bio: string | null
  linkedin_url: string | null
  twitter_url: string | null
}

export interface ProgramSessionDetail {
  id: string
  friendly_id: string | null
  title: string
  description: string
  starts_at: string | null
  ends_at: string | null
  room: string | null
  track: ProgramTrack | null
  speakers: ProgramSessionSpeaker[]
}

export interface ProgramSessionResponse {
  event: { name: string | null; timezone: string | null; location: string | null }
  session: ProgramSessionDetail
}

/** GET /public/program/{slug}/session/{id} — one session's full public detail. */
export function getProgramSession(slug: string, sessionId: string): Promise<ProgramSessionResponse> {
  return apiGet<ProgramSessionResponse>(
    `/public/program/${encodeURIComponent(slug)}/session/${encodeURIComponent(sessionId)}`
  )
}

// ── speakers ─────────────────────────────────────────────────────────────────

export interface SpeakerSessionRef {
  title: string
  starts_at: string | null
  room: string | null
}

export interface ProgramSpeaker {
  name: string
  title: string | null
  company: string | null
  photo_url: string | null
  bio: string | null
  linkedin_url: string | null
  twitter_url: string | null
  sessions: SpeakerSessionRef[]
}

export interface ProgramSpeakers {
  event: { name: string | null; timezone?: string | null }
  speakers: ProgramSpeaker[]
}

/** GET /public/program/{slug}/speakers — the speaker gallery, alpha by last name. */
export function getProgramSpeakers(slug: string): Promise<ProgramSpeakers> {
  return apiGet<ProgramSpeakers>(`/public/program/${encodeURIComponent(slug)}/speakers`)
}

// ── formatting helpers (shared by both pages) ────────────────────────────────

/**
 * The viewer's IANA zone. NOT used by the public schedule page — which renders
 * in the EVENT's zone on purpose — but kept for any surface that genuinely wants
 * a viewer-local rendering (it can pass this as `getProgramSchedule`'s `tz`).
 */
export function getBrowserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

function timeIn(iso: string, tz?: string | null): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz || undefined,
  }).format(date)
}

/** "9:00 AM – 9:45 AM" in the event's zone; just the start if there's no end. */
export function formatTimeRange(
  startsAt: string | null,
  endsAt: string | null,
  tz?: string | null
): string {
  if (!startsAt) return ''
  const start = timeIn(startsAt, tz)
  const end = endsAt ? timeIn(endsAt, tz) : ''
  return end ? `${start} – ${end}` : start
}

/** "Monday, October 12" from a YYYY-MM-DD key, parsed as a local date so the
 * label never shifts a day under timezone conversion. */
export function formatDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map((part) => Number(part))
  if (!y || !m || !d) return dateKey
  const date = new Date(y, m - 1, d)
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

/**
 * A short, human label for the event's zone at a reference moment — e.g. "PDT",
 * "GMT+9". Used for the "times shown in <zone>" note so a reader knows the grid
 * is in the event's timezone, not their own.
 */
export function formatTimeZoneAbbrev(
  zone: string | null | undefined,
  referenceIso?: string | null
): string {
  if (!zone) return ''
  const ref = referenceIso ? new Date(referenceIso) : new Date()
  const at = Number.isNaN(ref.getTime()) ? new Date() : ref
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'short',
    }).formatToParts(at)
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** "Times shown in America/Los_Angeles (PDT)" — the schedule's timezone note. */
export function formatTimeZoneNote(
  zone: string | null | undefined,
  referenceIso?: string | null
): string {
  if (!zone) return ''
  const abbrev = formatTimeZoneAbbrev(zone, referenceIso)
  return abbrev ? `Times shown in ${zone} (${abbrev})` : `Times shown in ${zone}`
}

/** "Mon, Oct 12 · 9:00 AM" for a speaker's session line. */
export function formatSessionMoment(startsAt: string | null, tz?: string | null): string {
  if (!startsAt) return 'Time to be announced'
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return ''
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz || undefined,
  }).format(date)
  return `${day} · ${timeIn(startsAt, tz)}`
}

/** Initials for a headshot fallback: first + last, at most two letters. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// ── add-to-calendar (.ics) ───────────────────────────────────────────────────
// Generated client-side so the public "Add to calendar" needs no authenticated
// endpoint. Times are emitted in UTC (…Z), which every calendar client renders
// back in the viewer's own zone — the same convention the server's ICS uses.

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** An ISO instant as RFC 5545 UTC form: 20261012T160000Z. */
function icsUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  )
}

/** Escape a TEXT value per RFC 5545 §3.3.11 (backslash first). */
function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

export interface IcsSessionInput {
  id: string
  friendly_id?: string | null
  title: string
  description?: string
  starts_at: string | null
  ends_at: string | null
  location?: string | null
}

/**
 * A single-VEVENT iCalendar document for one session. Returns '' when the
 * session has no start (nothing to put on a calendar). Description is passed as
 * plain text — strip any HTML before calling.
 */
export function buildSessionIcs(session: IcsSessionInput, now: Date = new Date()): string {
  if (!session.starts_at) return ''
  const start = icsUtc(session.starts_at)
  if (!start) return ''
  // Fall back to a 1-hour block when no end is set, so DTEND is always valid.
  const end = session.ends_at
    ? icsUtc(session.ends_at)
    : icsUtc(new Date(new Date(session.starts_at).getTime() + 60 * 60 * 1000).toISOString())
  const uid = `${session.friendly_id || session.id}@dais`
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dais//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(now.toISOString())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(session.title || 'Session')}`,
  ]
  if (session.description) lines.push(`DESCRIPTION:${icsEscape(session.description)}`)
  if (session.location) lines.push(`LOCATION:${icsEscape(session.location)}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n')
}

/** Trigger a browser download of `ics` as `<name>.ics`. No-op without a DOM. */
export function downloadIcs(ics: string, filename: string): void {
  if (!ics || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith('.ics') ? filename : `${filename}.ics`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
