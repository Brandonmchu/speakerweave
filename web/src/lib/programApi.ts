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

/** GET /public/program/{slug}/schedule?tz= — the published, day-grouped agenda. */
export function getProgramSchedule(slug: string, tz?: string): Promise<ProgramSchedule> {
  const query = tz ? `?tz=${encodeURIComponent(tz)}` : ''
  return apiGet<ProgramSchedule>(`/public/program/${encodeURIComponent(slug)}/schedule${query}`)
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
  event: { name: string | null }
  speakers: ProgramSpeaker[]
}

/** GET /public/program/{slug}/speakers — the speaker gallery, alpha by last name. */
export function getProgramSpeakers(slug: string): Promise<ProgramSpeakers> {
  return apiGet<ProgramSpeakers>(`/public/program/${encodeURIComponent(slug)}/speakers`)
}

// ── formatting helpers (shared by both pages) ────────────────────────────────

/** The viewer's IANA zone, sent as ?tz so day grouping matches their clock. */
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
