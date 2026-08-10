/**
 * Wire layer for the agenda grid: one read for the whole board, one write per
 * drop, one authoritative conflict list.
 *
 * Split from lib/adminApi.ts on purpose — the agenda is the only surface that
 * speaks in *minutes* rather than rows, so the timestamp⇄minute conversions the
 * grid needs live next to the calls that produce and consume them. Everything
 * below the fetchers is pure and unit-tested; the grid does no date maths of
 * its own.
 *
 * TIME: the grid is drawn in the EVENT's timezone, not the browser's and not
 * UTC — the same zone the public schedule (routes/program_routes.py) renders in,
 * so the builder and the published page agree to the minute. A slot at local
 * 09:00 on a conference day is stored as the UTC instant that *is* 09:00 in the
 * event zone (`2026-10-12T16:00:00+00:00` for America/Los_Angeles in October),
 * and read back by converting that instant into the event zone. The zoned
 * conversions live in `zonedMinutes` / `zonedDay` / `buildZonedTimestamp` and are
 * unit-tested; when the event carries no zone they fall back to plain UTC, which
 * is the old behaviour byte for byte. Conflict ordering still uses absolute epoch
 * minutes (timezone-independent) so equal clock times on different days never
 * alias.
 */

import { apiGet, apiPatch, apiPost, unwrapList } from '@/lib/api'

// --- wire shapes ----------------------------------------------------------

export type ConflictType = 'room_overlap' | 'speaker_overlap'

/** Only these three statuses reach the grid (see api/routes/schedule_routes.py). */
export type SchedulableStatus = 'pending' | 'accept_queue' | 'accepted'

export interface AgendaSpeaker {
  contact_id: string
  first_name?: string | null
  last_name?: string | null
}

export interface AgendaSession {
  id: string
  friendly_id?: string | null
  title: string
  status: SchedulableStatus | (string & {})
  /** null = unscheduled; it lives in the tray, not on the grid. */
  starts_at?: string | null
  ends_at?: string | null
  room_id?: string | null
  track_id?: string | null
  /** Derived server-side: the placed length, else the format default, else 30. */
  duration_min: number
  speakers: AgendaSpeaker[]
}

export interface AgendaRoom {
  id: string
  name: string
  capacity?: number | null
  order?: number | null
}

export interface AgendaTrack {
  id: string
  name: string
  color?: string | null
}

export interface AgendaEvent {
  id: string
  name?: string | null
  /** Public event slug, for the /e/{slug}/schedule link. */
  slug?: string | null
  /** IANA name the grid labels + groups days in, e.g. "America/Los_Angeles". */
  timezone?: string | null
  starts_at?: string | null
  ends_at?: string | null
  /** Postgres `time` — "09:00:00". Read as event-local wall clock. */
  day_start?: string | null
  day_end?: string | null
  slot_minutes?: number | null
  /** When the organizer last pressed "Publish schedule". Never gates visibility. */
  program_published_at?: string | null
}

export interface Agenda {
  event: AgendaEvent | null
  rooms: AgendaRoom[]
  tracks: AgendaTrack[]
  sessions: AgendaSession[]
}

export interface ServerConflict {
  type: ConflictType
  session_ids: string[]
  detail: string
}

/** The only three columns a drag may write. All three move together. */
export interface SchedulePatch {
  starts_at: string | null
  ends_at: string | null
  room_id: string | null
}

// --- grid geometry --------------------------------------------------------

/** Fallbacks when an event has no geometry of its own. */
export const DEFAULT_DAY_START_MIN = 9 * 60
export const DEFAULT_DAY_END_MIN = 17 * 60
export const DEFAULT_SLOT_MINUTES = 15

export interface GridGeometry {
  dayStartMin: number
  dayEndMin: number
  slotMinutes: number
  /** Rows in the grid. */
  slotCount: number
}

/** "09:00" / "09:00:00" -> 540. Anything unparseable is null, never NaN. */
export function parseClockMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * The lattice the grid draws, taken from the event's own settings.
 *
 * A day that ends before it starts, or a slot width of zero, would render a
 * grid with no rows and swallow every card — so both fall back rather than
 * propagate.
 */
export function gridGeometry(event: AgendaEvent | null | undefined): GridGeometry {
  const dayStartMin = parseClockMinutes(event?.day_start) ?? DEFAULT_DAY_START_MIN
  const slotMinutes =
    event?.slot_minutes && event.slot_minutes > 0 ? event.slot_minutes : DEFAULT_SLOT_MINUTES

  const parsedEnd = parseClockMinutes(event?.day_end) ?? DEFAULT_DAY_END_MIN
  const dayEndMin =
    parsedEnd > dayStartMin ? parsedEnd : dayStartMin + (DEFAULT_DAY_END_MIN - DEFAULT_DAY_START_MIN)

  return {
    dayStartMin,
    dayEndMin,
    slotMinutes,
    slotCount: Math.max(1, Math.ceil((dayEndMin - dayStartMin) / slotMinutes)),
  }
}

// --- timestamps -----------------------------------------------------------

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * ISO text -> the instant it names, as a Date.
 *
 * Parsed by hand rather than with `new Date(...)` because a zoneless value out
 * of Postgres must mean UTC here, not "whatever the operator's laptop is set
 * to" — otherwise the same schedule reads differently in two offices.
 */
export function toUtcDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const match = TIMESTAMP.exec(String(value).trim())
  if (!match) return null

  const [, year, month, day, hours, minutes, seconds, zone] = match
  let ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds ?? 0)
  )
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const offset = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))
    ms -= sign * offset * 60_000
  }
  return new Date(ms)
}

/** Minutes past midnight (UTC) — for positioning a card on the clock grid. */
export function timestampMinutes(value: string | null | undefined): number | null {
  const at = toUtcDate(value)
  return at ? at.getUTCHours() * 60 + at.getUTCMinutes() : null
}

/**
 * Epoch minutes (UTC) — for comparisons that must preserve the conference day.
 *
 * The room grid positions cards by clock time, but conflict detection cannot:
 * 16:00 on Monday and 16:00 on Tuesday are different intervals. This is the
 * browser equivalent of `services.scheduling.minutes_from_timestamp`.
 */
export function timestampEpochMinutes(value: string | null | undefined): number | null {
  const at = toUtcDate(value)
  return at ? Math.floor(at.getTime() / 60_000) : null
}

/** "YYYY-MM-DD" (UTC) — which day of the conference a placement belongs to. */
export function timestampDay(value: string | null | undefined): string | null {
  const at = toUtcDate(value)
  return at ? at.toISOString().slice(0, 10) : null
}

/** (day, minutes) -> the timestamp a placement is stored as. */
export function buildTimestamp(day: string, minutes: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const at = new Date(Date.UTC(year, (month ?? 1) - 1, date ?? 1, 0, minutes))
  return `${at.toISOString().slice(0, 19)}+00:00`
}

// --- event-timezone conversions -------------------------------------------
//
// The grid is drawn in the event's zone. These turn an absolute instant into
// the event-local clock/day the grid positions by, and back again, using the
// browser's own Intl database — no extra dependency. A null/blank zone means
// "just use UTC", which is exactly the old behaviour.

/**
 * The zone's offset (local − UTC), in minutes, at a given instant. Computed by
 * formatting the instant in the zone and diffing — the standard trick, and the
 * one place DST is accounted for.
 */
export function zoneOffsetMinutes(at: Date, tz: string | null | undefined): number {
  if (!tz) return 0
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at)
    const map: Record<string, number> = {}
    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = Number(part.value)
    }
    const asUtc = Date.UTC(
      map.year,
      (map.month ?? 1) - 1,
      map.day ?? 1,
      (map.hour ?? 0) % 24,
      map.minute ?? 0,
      map.second ?? 0
    )
    return Math.round((asUtc - at.getTime()) / 60_000)
  } catch {
    return 0
  }
}

/** Minutes past local midnight in the event zone — where a card sits vertically. */
export function zonedMinutes(
  value: string | null | undefined,
  tz: string | null | undefined
): number | null {
  const at = toUtcDate(value)
  if (!at) return null
  if (!tz) return at.getUTCHours() * 60 + at.getUTCMinutes()
  const local = new Date(at.getTime() + zoneOffsetMinutes(at, tz) * 60_000)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

/** "YYYY-MM-DD" of the instant's *local* date in the event zone — which day tab. */
export function zonedDay(
  value: string | null | undefined,
  tz: string | null | undefined
): string | null {
  const at = toUtcDate(value)
  if (!at) return null
  if (!tz) return at.toISOString().slice(0, 10)
  const local = new Date(at.getTime() + zoneOffsetMinutes(at, tz) * 60_000)
  return local.toISOString().slice(0, 10)
}

/**
 * (local day, local minutes, zone) -> the UTC instant to store. The inverse of
 * `zonedMinutes`/`zonedDay`: the clock the organizer dropped the card at, in the
 * event's zone, resolved to the one instant that reads back to it. Refined once
 * so a DST-boundary drop lands on the right side.
 */
export function buildZonedTimestamp(
  day: string,
  minutes: number,
  tz: string | null | undefined
): string {
  if (!tz) return buildTimestamp(day, minutes)
  const [year, month, date] = day.split('-').map(Number)
  const naiveUtc = Date.UTC(year, (month ?? 1) - 1, date ?? 1, 0, minutes)
  let offset = zoneOffsetMinutes(new Date(naiveUtc), tz)
  let utcMs = naiveUtc - offset * 60_000
  offset = zoneOffsetMinutes(new Date(utcMs), tz)
  utcMs = naiveUtc - offset * 60_000
  return `${new Date(utcMs).toISOString().slice(0, 19)}+00:00`
}

/**
 * Add whole minutes to an explicit-UTC timestamp, preserving the `+00:00` form.
 *
 * Used to derive `ends_at` from a single start *instant* rather than converting
 * the end wall-time separately: a session that spans a DST transition must keep
 * its real duration, and adding minutes to the start instant does exactly that —
 * a 60-minute talk stays 60 real minutes even across the LA fall-back.
 */
export function addMinutesToIso(value: string, minutes: number): string {
  const at = toUtcDate(value)
  if (!at) return value
  const shifted = new Date(at.getTime() + minutes * 60_000)
  return `${shifted.toISOString().slice(0, 19)}+00:00`
}

/**
 * Epoch minutes shifted into the event's local wall clock.
 *
 * Conflict detection compares differences, so a constant shift never changes
 * which sessions collide (any pair that actually overlaps shares one instant and
 * thus one offset). Shifting means the `detail` string — built from the shared
 * overlap minute via `format_minutes` — prints in the event zone too, so the
 * conflict banner reads the same clock as the grid. Without a zone this is plain
 * epoch minutes (UTC), the old behaviour.
 */
export function localEpochMinutes(
  value: string | null | undefined,
  tz: string | null | undefined
): number | null {
  const at = toUtcDate(value)
  if (!at) return null
  const epoch = Math.floor(at.getTime() / 60_000)
  return tz ? epoch + zoneOffsetMinutes(at, tz) : epoch
}

/** A short zone abbreviation at a reference instant — "PDT", "GMT+9", "". */
export function zoneAbbrev(
  tz: string | null | undefined,
  referenceIso?: string | null
): string {
  if (!tz) return ''
  const ref = referenceIso ? new Date(referenceIso) : new Date()
  const at = Number.isNaN(ref.getTime()) ? new Date() : ref
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    }).formatToParts(at)
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** "America/Los_Angeles (PDT)" — the small tz hint next to the grid's times. */
export function zoneHint(
  tz: string | null | undefined,
  referenceIso?: string | null
): string {
  if (!tz) return ''
  const abbrev = zoneAbbrev(tz, referenceIso)
  return abbrev ? `${tz} (${abbrev})` : tz
}

/**
 * The day new placements are written into: the event's own start, else the
 * earliest day something is already scheduled on, else today. A single-day
 * grid needs exactly one answer, and it must not drift between two drags.
 */
export function agendaDay(agenda: Agenda | null | undefined): string {
  const fromEvent = timestampDay(agenda?.event?.starts_at)
  if (fromEvent) return fromEvent

  const days = (agenda?.sessions ?? [])
    .map((session) => timestampDay(session.starts_at))
    .filter((day): day is string => Boolean(day))
    .sort()
  if (days.length) return days[0]

  return new Date().toISOString().slice(0, 10)
}

/**
 * Every conference day the builder can show, as sorted "YYYY-MM-DD" keys in the
 * event zone — and ONLY those: the event's own configured start→end span.
 *
 * It used to also union in whichever days sessions happened to sit on, which
 * made the day switcher a mirror of the data's mistakes: one stale placement in
 * a month the conference does not run and the builder grew a tab for it, as
 * though the event had a fourth day. A conference day is a fact about the EVENT,
 * not about a row, so the span is the whole answer. Placements that fall outside
 * it are not hidden — they are collected by `outsideEventDays` and shown as an
 * explicit problem to resolve (see `Agenda.tsx`).
 *
 * An event with no configured span has NO span to clamp to, so it keeps the old
 * union-of-placed-days behaviour rather than declaring every placement stray —
 * the same "no window, no clamp" rule the public schedule and the auto-placer
 * apply.
 */
export function agendaDays(
  agenda: Agenda | null | undefined,
  tz: string | null | undefined
): string[] {
  const days = new Set<string>()

  const start = zonedDay(agenda?.event?.starts_at, tz)
  if (start) {
    days.add(start)
    // The event's end is exclusive: an event ending exactly at local midnight
    // belongs to the previous day, so read the calendar day of the instant just
    // before the end rather than of the end itself (which would add a stray tab).
    const endInstant = toUtcDate(agenda?.event?.ends_at)
    const end = endInstant
      ? zonedDay(new Date(endInstant.getTime() - 60_000).toISOString(), tz)
      : null
    if (end && end > start) {
      // Walk calendar days start→end inclusive. Dates are tz-independent once
      // we hold the local day strings, so step through UTC midnights.
      const [ys, ms, ds] = start.split('-').map(Number)
      const [ye, me, de] = end.split('-').map(Number)
      let cursor = Date.UTC(ys, (ms ?? 1) - 1, ds ?? 1)
      const last = Date.UTC(ye, (me ?? 1) - 1, de ?? 1)
      // Guard against a pathological span so the loop is always bounded.
      let guard = 0
      while (cursor < last && guard < 366) {
        cursor += 24 * 60 * 60 * 1000
        days.add(new Date(cursor).toISOString().slice(0, 10))
        guard += 1
      }
    }
    return [...days].sort()
  }

  // No span configured. Every day something sits on is a day, because there is
  // no better answer — and calling them all "outside the event dates" would be
  // a lie about an event that has no dates.
  for (const session of agenda?.sessions ?? []) {
    const day = zonedDay(session.starts_at, tz)
    if (day) days.add(day)
  }
  if (days.size === 0) days.add(agendaDay(agenda))
  return [...days].sort()
}

/**
 * Scheduled sessions that sit on a calendar day the event does not run on.
 *
 * These are real rows with a real placement — a talk left behind by a date
 * change, or one placed before the span was set — and they cannot be drawn on
 * any legitimate day tab. Rather than inventing a tab for them (which reads as
 * "the conference has a day in March") the builder gathers them here, warns, and
 * offers to send each one back to the tray.
 */
export function outsideEventDays(
  agenda: Agenda | null | undefined,
  tz: string | null | undefined
): AgendaSession[] {
  const inRange = new Set(agendaDays(agenda, tz))
  return (agenda?.sessions ?? []).filter((session) => {
    const day = zonedDay(session.starts_at, tz)
    return Boolean(day) && !inRange.has(day as string)
  })
}

// --- calls ----------------------------------------------------------------

function normalize(payload: Partial<Agenda> | null | undefined): Agenda {
  return {
    event: payload?.event ?? null,
    rooms: Array.isArray(payload?.rooms) ? payload.rooms : [],
    tracks: Array.isArray(payload?.tracks) ? payload.tracks : [],
    sessions: Array.isArray(payload?.sessions) ? payload.sessions : [],
  }
}

/** GET /api/events/{id}/agenda — the whole board in one request. */
export async function getAgenda(eventId: string): Promise<Agenda> {
  return normalize(
    await apiGet<Partial<Agenda>>(`/api/events/${encodeURIComponent(eventId)}/agenda`)
  )
}

/**
 * GET /api/events/{id}/agenda/conflicts — the server's own sweep.
 *
 * The browser flags conflicts live while a card is dragged; this is what it
 * reconciles against, and it is the copy that has seen every row.
 */
export async function getAgendaConflicts(eventId: string): Promise<ServerConflict[]> {
  const payload = await apiGet<unknown>(
    `/api/events/${encodeURIComponent(eventId)}/agenda/conflicts`
  )
  return unwrapList<ServerConflict>(payload as never)
}

/**
 * PATCH /api/sessions/{id}/schedule — place, move or unschedule one session.
 *
 * A 409 means Postgres refused a room double-book; the caller rolls its
 * optimistic move back on exactly that status.
 */
export async function scheduleSession(
  sessionId: string,
  patch: SchedulePatch
): Promise<AgendaSession> {
  const wire = await apiPatch<{ session?: AgendaSession } | AgendaSession>(
    `/api/sessions/${encodeURIComponent(sessionId)}/schedule`,
    patch
  )
  const session = (wire as { session?: AgendaSession })?.session
  return session ?? (wire as AgendaSession)
}

/** A session the auto-placer found a home for, with the slot it chose. */
export interface AutoPlacedSession {
  id: string
  title?: string | null
  room_id: string
  starts_at: string
  ends_at: string
}

/** A session the auto-placer deliberately left in the tray, and why. */
export interface AutoPlaceSkip {
  id: string
  title?: string | null
  reason: string
}

export interface AutoPlaceResult {
  placed: AutoPlacedSession[]
  skipped: AutoPlaceSkip[]
}

/**
 * POST /api/events/{id}/schedule/auto-place — fill the unscheduled tray in one
 * action.
 *
 * The server picks the slots (services/auto_place.py), validating every
 * candidate against the same conflict engine this module's grid reconciles
 * with, so nothing it writes can land red. Anything that cannot fit comes back
 * in `skipped` with a reason rather than being forced somewhere.
 *
 * The caller refetches the board afterwards: auto-placed sessions are ordinary
 * placements, indistinguishable from dragged ones once they are on the grid.
 */
export async function autoPlaceSchedule(eventId: string): Promise<AutoPlaceResult> {
  const wire = await apiPost<Partial<AutoPlaceResult>>(
    `/api/events/${encodeURIComponent(eventId)}/schedule/auto-place`
  )
  return {
    placed: Array.isArray(wire?.placed) ? wire.placed : [],
    skipped: Array.isArray(wire?.skipped) ? wire.skipped : [],
  }
}

/** The result of pressing "Publish schedule": the stamp + the public link. */
export interface PublishResult {
  event: { id: string; slug: string | null; program_published_at: string | null }
  /** "/e/{slug}/schedule", or null when the event somehow has no slug. */
  public_url: string | null
}

/**
 * POST /api/events/{id}/schedule/publish — record that the programme is
 * published and get the public schedule URL back.
 *
 * This does NOT gate public visibility: the published schedule already serves
 * accepted+scheduled sessions. Publishing is an explicit affirmation + a
 * timestamp + the link to share.
 */
export async function publishSchedule(eventId: string): Promise<PublishResult> {
  return apiPost<PublishResult>(
    `/api/events/${encodeURIComponent(eventId)}/schedule/publish`
  )
}
