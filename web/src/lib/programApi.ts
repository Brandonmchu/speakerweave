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
  format: string | null
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
  format: string | null
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
  id: string | null
  title: string
  starts_at: string | null
  room: string | null
  format: string | null
}

export interface ProgramSpeaker {
  /** The contact id — one stable identity per person. Absent on older payloads. */
  id?: string | null
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

// ── speaker identity + de-duplication ────────────────────────────────────────
// The gallery renders whatever the organizer's roster contains, and a real
// roster picks up duplicates: the same person added by hand and again by CSV,
// under two contact rows. The page must survive that without ever showing one
// contact twice or letting a count disagree with the cards on screen.

/** Trimmed, case-folded, single-spaced — the shape names are compared in. */
function normText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** "same human" identity: normalized display name + company. */
function identityKey(speaker: ProgramSpeaker): string {
  return `${normText(speaker.name)}|${normText(speaker.company)}`
}

/** A unique, stable React key for a de-duplicated speaker. */
export function speakerKey(speaker: ProgramSpeaker): string {
  return speaker.id || identityKey(speaker)
}

/** Session identity, so a merge never lists the same talk twice. */
function sessionKey(session: SpeakerSessionRef): string {
  return session.id || `${normText(session.title)}|${session.starts_at ?? ''}`
}

/** Unscheduled last, then chronological, then by title — the server's order. */
function bySessionOrder(a: SpeakerSessionRef, b: SpeakerSessionRef): number {
  if (!a.starts_at !== !b.starts_at) return a.starts_at ? -1 : 1
  const when = (a.starts_at ?? '').localeCompare(b.starts_at ?? '')
  return when !== 0 ? when : normText(a.title).localeCompare(normText(b.title))
}

/** Fold `extra` into `base`: union the sessions, fill any blank profile field. */
function mergeSpeakers(base: ProgramSpeaker, extra: ProgramSpeaker): ProgramSpeaker {
  const sessions = [...base.sessions]
  const seen = new Set(sessions.map(sessionKey))
  for (const session of extra.sessions) {
    const key = sessionKey(session)
    if (seen.has(key)) continue
    seen.add(key)
    sessions.push(session)
  }
  return {
    ...base,
    title: base.title || extra.title,
    company: base.company || extra.company,
    photo_url: base.photo_url || extra.photo_url,
    bio: base.bio || extra.bio,
    linkedin_url: base.linkedin_url || extra.linkedin_url,
    twitter_url: base.twitter_url || extra.twitter_url,
    sessions: sessions.sort(bySessionOrder),
  }
}

/**
 * The list the gallery actually renders — the ONE source both the cards and the
 * result count read, so the two can never disagree.
 *
 * Two guarantees:
 *
 *  1. **One card per contact id.** A repeated id is the same record arriving
 *     twice; it is dropped, never rendered again and never a duplicate React
 *     key (which is how a stale card survives a filter in the first place).
 *  2. **One card per person.** Two *different* contacts sharing a normalized
 *     name AND company are one human entered twice — a manual add plus a CSV
 *     import, say. They merge into a single card owning both their sessions,
 *     with the richer of the two profiles winning each blank field.
 *
 * Speakers who share a name but not a company stay separate cards: they are
 * probably different people, and the card always shows title and company, so
 * the two read as distinct on sight.
 *
 * Input order (the server's alphabetical-by-surname) is preserved.
 */
export function dedupeProgramSpeakers(speakers: ProgramSpeaker[]): ProgramSpeaker[] {
  const byIdentity = new Map<string, ProgramSpeaker>()
  const seenIds = new Set<string>()

  for (const speaker of speakers) {
    if (speaker.id) {
      if (seenIds.has(speaker.id)) continue
      seenIds.add(speaker.id)
    }
    const key = identityKey(speaker)
    const existing = byIdentity.get(key)
    byIdentity.set(
      key,
      existing ? mergeSpeakers(existing, speaker) : { ...speaker, sessions: [...speaker.sessions] }
    )
  }

  return [...byIdentity.values()]
}

// ── public links + embed snippets (organizer-facing) ─────────────────────────
// What Settings shows an organizer so they can share the programme or drop it
// into their own marketing site.
//
// ONE origin is correct for everything here: the origin the organizer is
// looking at. nginx serves the /e/ pages as the SPA *and* proxies /public/* to
// the API from that same host (web/nginx/default.conf), and the loader script
// derives the iframe origin from its own `script.src` — so a snippet built
// against `window.location.origin` resolves to the same place either way.

export type EmbedWidget = 'schedule' | 'speakers'

/** The origin public pages are served from ('' when there's no DOM). */
export function publicProgramOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

/** `/e/{slug}/schedule` | `/e/{slug}/speakers` — the public page routes. */
export function publicProgramPath(slug: string, widget: EmbedWidget = 'schedule'): string {
  return `/e/${encodeURIComponent(slug)}/${widget}`
}

/** The absolute, shareable URL of a public program page. */
export function publicProgramUrl(slug: string, widget: EmbedWidget = 'schedule'): string {
  return `${publicProgramOrigin()}${publicProgramPath(slug, widget)}`
}

/** The loader served by `GET /public/program/{slug}/embed.js`. */
export function embedScriptUrl(slug: string): string {
  return `${publicProgramOrigin()}/public/program/${encodeURIComponent(slug)}/embed.js`
}

/**
 * The public, read-only JSON behind a widget — the same endpoint the page
 * itself fetches. Offered beside the HTML snippets as a third output format,
 * for organizers who want to render the programme themselves.
 */
export function publicProgramFeedUrl(slug: string, widget: EmbedWidget = 'schedule'): string {
  return `${publicProgramOrigin()}/public/program/${encodeURIComponent(slug)}/${widget}`
}

/**
 * The `<script>` embed — the recommended one, because the loader listens for
 * the page's `dais-embed-height` postMessage and resizes the iframe to fit.
 *
 * The loader reads `data-dais-event` / `data-dais-widget` off its OWN tag via
 * `document.currentScript`, so the snippet must carry neither `async` nor
 * `defer`: `currentScript` is null for those and the widget would never mount.
 */
/**
 * HTML-attribute escape for values interpolated into snippet markup. Slugs are
 * server-validated, but the snippet is copy-pasteable HTML — a quote or angle
 * bracket smuggled into one must never be able to break out of the attribute.
 */
function attrEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function embedScriptSnippet(slug: string, widget: EmbedWidget = 'schedule'): string {
  return [
    `<script src="${embedScriptUrl(slug)}"`,
    `        data-dais-event="${attrEscape(slug)}"`,
    `        data-dais-widget="${widget}"></script>`,
  ].join('\n')
}

/** The no-JavaScript fallback: the same page in a plain, fixed-height iframe. */
export function embedIframeSnippet(slug: string, widget: EmbedWidget = 'schedule'): string {
  return [
    `<iframe src="${publicProgramUrl(slug, widget)}?embed=1"`,
    `        title="dais ${widget}" loading="lazy" scrolling="no"`,
    `        style="width:100%;height:600px;border:0"></iframe>`,
  ].join('\n')
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

const ICS_HEADER = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//dais//EN', 'CALSCALE:GREGORIAN']

/** The VEVENT lines for one session, or null when it has no valid start. */
function veventLines(session: IcsSessionInput, now: Date): string[] | null {
  if (!session.starts_at) return null
  const start = icsUtc(session.starts_at)
  if (!start) return null
  // Fall back to a 1-hour block when no end is set, so DTEND is always valid.
  const end = session.ends_at
    ? icsUtc(session.ends_at)
    : icsUtc(new Date(new Date(session.starts_at).getTime() + 60 * 60 * 1000).toISOString())
  const uid = `${session.friendly_id || session.id}@dais`
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(now.toISOString())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(session.title || 'Session')}`,
  ]
  if (session.description) lines.push(`DESCRIPTION:${icsEscape(session.description)}`)
  if (session.location) lines.push(`LOCATION:${icsEscape(session.location)}`)
  lines.push('END:VEVENT')
  return lines
}

/**
 * A single-VEVENT iCalendar document for one session. Returns '' when the
 * session has no start (nothing to put on a calendar). Description is passed as
 * plain text — strip any HTML before calling.
 */
export function buildSessionIcs(session: IcsSessionInput, now: Date = new Date()): string {
  const vevent = veventLines(session, now)
  if (!vevent) return ''
  return [...ICS_HEADER, ...vevent, 'END:VCALENDAR'].join('\r\n')
}

/**
 * A multi-VEVENT iCalendar document for a personal ("my schedule") selection.
 * Sessions without a valid start are skipped; returns '' when none remain, so a
 * caller can avoid a download when nothing is starred.
 */
export function buildScheduleIcs(sessions: IcsSessionInput[], now: Date = new Date()): string {
  const vevents = sessions
    .map((session) => veventLines(session, now))
    .filter((lines): lines is string[] => lines !== null)
  if (vevents.length === 0) return ''
  return [...ICS_HEADER, ...vevents.flat(), 'END:VCALENDAR'].join('\r\n')
}

// ── personal schedule (starred sessions, localStorage) ───────────────────────
// A reader's "my schedule" is anonymous and device-local: no login, no server
// round-trip. Stars are keyed per event slug so two events on the same browser
// never share a selection. Every access is guarded — private mode, disabled
// storage, or SSR must degrade to "nothing starred", never throw.

const MY_SCHEDULE_PREFIX = 'dais.mySchedule.'

function myScheduleKey(slug: string): string {
  return `${MY_SCHEDULE_PREFIX}${slug}`
}

/** The starred session ids for `slug`, or [] when storage is empty/unavailable. */
export function readStarredIds(slug: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(myScheduleKey(slug))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Persist `ids` (de-duplicated) as the starred set for `slug`. No-op if it throws. */
export function writeStarredIds(slug: string, ids: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(myScheduleKey(slug), JSON.stringify([...new Set(ids)]))
  } catch {
    // Quota exceeded or storage disabled — a personal schedule is best-effort.
  }
}

/** Add or remove `id` from `slug`'s starred set, returning the new id list. */
export function toggleStarredId(slug: string, id: string): string[] {
  const current = new Set(readStarredIds(slug))
  if (current.has(id)) current.delete(id)
  else current.add(id)
  const next = [...current]
  writeStarredIds(slug, next)
  return next
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
