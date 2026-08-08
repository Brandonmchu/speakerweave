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
 * TIME, for now: a placement is written as an explicit-UTC timestamp built from
 * the event's day and the slot's minute offset — `2026-10-12T09:30:00+00:00` —
 * and read back by its UTC clock. So "09:30 on the grid" round-trips to "09:30
 * on the grid" regardless of where the organizer's browser or the database
 * server happens to be. The event's IANA `timezone` is carried through the
 * payload but is NOT yet applied; doing that properly means a real zoned
 * conversion on both sides, and getting it half-right would move existing
 * sessions by an hour twice a year.
 */

import { apiGet, apiPatch, unwrapList } from '@/lib/api'

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
  timezone?: string | null
  starts_at?: string | null
  ends_at?: string | null
  /** Postgres `time` — "09:00:00". */
  day_start?: string | null
  day_end?: string | null
  slot_minutes?: number | null
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

/** Minutes past midnight (UTC) — the grid's own unit. */
export function timestampMinutes(value: string | null | undefined): number | null {
  const at = toUtcDate(value)
  return at ? at.getUTCHours() * 60 + at.getUTCMinutes() : null
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
