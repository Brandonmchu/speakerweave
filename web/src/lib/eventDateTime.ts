import { buildZonedTimestamp, zonedDay } from '@/lib/scheduleApi'

/** A short, opinionated list—enough for a conference, not an IANA browser. */
const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
]

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function timezoneOptions(current?: string | null): string[] {
  const list = [localTimezone(), ...COMMON_TIMEZONES]
  if (current) list.unshift(current)
  const seen: string[] = []
  for (const tz of list) if (tz && seen.indexOf(tz) === -1) seen.push(tz)
  return seen
}

/** `<input type="date">` shows the calendar day in the event's own timezone. */
export function toDateInput(iso?: string | null, timezone?: string | null): string {
  return zonedDay(iso, timezone) ?? ''
}

/** A date input -> event-local start/end boundary, stored as an absolute instant. */
export function fromDateInput(
  value: string,
  timezone?: string | null,
  endOfDay = false,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const boundary = buildZonedTimestamp(value, endOfDay ? 24 * 60 : 0, timezone)
  const instant = new Date(boundary)
  if (Number.isNaN(instant.getTime())) return null
  if (!endOfDay) return boundary
  // Store the inclusive local end-of-day. The agenda treats ends_at as an
  // exclusive range boundary, so its existing "one minute before end" logic
  // still lands on the organizer's final date.
  return `${new Date(instant.getTime() - 1).toISOString().slice(0, -1)}+00:00`
}
