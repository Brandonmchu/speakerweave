/**
 * Calendar dates, rendered as calendar dates.
 *
 * A task due date is a *day*, not an instant: "due 1 May 2027" means the same
 * thing in Lisbon and in Los Angeles. The API stores it in a `timestamptz`
 * column (migration 001 — `tasks.due_at`) at UTC midnight, which is the standard
 * trap: `new Date('2027-05-01T00:00:00+00:00')` formatted with the browser's
 * own offset renders "Apr 30" for every organizer west of Greenwich. That is
 * exactly the bug this module exists to remove.
 *
 * The rule here is one line long: a due date is read and written as the UTC
 * calendar date, never the viewer's local one. Nothing in this file consults the
 * browser's timezone except `todayKey`, which asks a genuinely local question —
 * "is this date behind *my* today?".
 */

/** "2027-05-01" — the canonical key form. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
/** "2027-05-01T00:00:00+00:00", "2027-05-01T00:00:00Z", "2027-05-01 00:00:00". */
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The calendar date a stored due value names, as "YYYY-MM-DD".
 *
 * A bare date passes straight through. A timestamp is resolved to the instant it
 * names and then read back in UTC — so the value the organizer typed into
 * `<input type="date">` (written as UTC midnight by `toDueTimestamp`) comes back
 * byte-identical, and an oddly-offset row like "2027-04-30T17:00:00-07:00" still
 * resolves to the 1st, because that IS the instant it stands for.
 */
export function dueDateKey(value: string | null | undefined): string | null {
  if (!value) return null
  const raw = String(value).trim()

  const dateOnly = DATE_ONLY.exec(raw)
  if (dateOnly) return raw

  const match = TIMESTAMP.exec(raw)
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
  const at = new Date(ms)
  if (Number.isNaN(at.getTime())) return null
  return at.toISOString().slice(0, 10)
}

/**
 * "2027-05-01" -> the value to store: UTC midnight on that calendar day.
 *
 * The inverse of `dueDateKey`. Deliberately built from the parts rather than by
 * `new Date(value).toISOString()` — the latter is only correct because of a
 * quirk of the ES date-string grammar, and stops being correct the moment
 * somebody "helpfully" appends a time.
 */
export function toDueTimestamp(value: string | null | undefined): string | null {
  const key = dueDateKey(value)
  if (!key) return null
  return `${key}T00:00:00+00:00`
}

/** Today, in the *viewer's* calendar — the only local question this file asks. */
export function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * "May 1, 2027" (or "May 1" with `{ year: false }`).
 *
 * Formatted from the key's own digits — not via `Intl` on a Date — so no
 * timezone gets a chance to move the day between the store and the screen.
 */
export function formatDueDate(
  value: string | null | undefined,
  options: { year?: boolean } = {}
): string {
  const key = dueDateKey(value)
  if (!key) return ''
  const [year, month, day] = key.split('-').map(Number)
  const name = MONTHS[month - 1] ?? String(month)
  return options.year === false ? `${name} ${day}` : `${name} ${day}, ${year}`
}

/** "Due May 1, 2027" — the whole label, or "" when there is no due date. */
export function dueLabel(
  value: string | null | undefined,
  options: { year?: boolean } = {}
): string {
  const formatted = formatDueDate(value, options)
  return formatted ? `Due ${formatted}` : ''
}

/**
 * Past its day. A task due TODAY is not overdue — the day is not over yet.
 */
export function isOverdue(value: string | null | undefined, now: Date = new Date()): boolean {
  const key = dueDateKey(value)
  if (!key) return false
  return key < todayKey(now)
}

/**
 * Sort key for a due date column: the date itself, with "no due date" last in
 * both directions (an empty cell is not "earliest", it is "not applicable").
 */
export function dueSortKey(value: string | null | undefined): string {
  return dueDateKey(value) ?? '9999-12-31'
}
