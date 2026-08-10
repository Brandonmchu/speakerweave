/**
 * Wire layer for the onboarding dashboard (requirement #6).
 *
 * Split out of adminApi.ts for the same reason adminApi was split out of
 * api.ts: one screen, one contract, one file to read when the payload changes.
 * `apiGet` is imported rather than re-implemented — one fetch, one auth header,
 * one error class.
 */

import { apiGet, unwrapList, type EventSummary } from '@/lib/api'

/** Counts across the six review queues. `total` is every session on the event,
 * drafts included — the denominator, not the sum of the six. */
export interface SubmissionFunnel {
  pending: number
  accept_queue: number
  accepted: number
  decline_queue: number
  declined: number
  withdrawn: number
  total: number
}

export interface LastEmail {
  template_key: string | null
  status: string | null
  sent_at: string | null
  last_error: string | null
}

export interface SpeakerOnboarding {
  contact_id: string
  name: string
  email: string | null
  session_count: number
  /** {session status: count} across the sessions this person is on. */
  status_summary: Record<string, number>
  tasks_total: number
  tasks_done: number
  tasks_outstanding: number
  last_portal_access_at: string | null
  last_email: LastEmail | null
  /**
   * Visited the portal, has tasks, owes nothing back. Tasks the organizer
   * hasn't created yet read as not-started rather than complete — see
   * api/routes/dashboard_routes.py for the full rule.
   */
  onboarding_complete: boolean
}

export interface DashboardTotals {
  speakers: number
  onboarded: number
  outstanding_tasks: number
}

export interface EventDashboard {
  submission_funnel: SubmissionFunnel
  speakers: SpeakerOnboarding[]
  totals: DashboardTotals
}

const EMPTY_FUNNEL: SubmissionFunnel = {
  pending: 0,
  accept_queue: 0,
  accepted: 0,
  decline_queue: 0,
  declined: 0,
  withdrawn: 0,
  total: 0,
}

const EMPTY_TOTALS: DashboardTotals = { speakers: 0, onboarded: 0, outstanding_tasks: 0 }

/**
 * GET /api/events/{id}/dashboard.
 *
 * Defaults are filled in here rather than guarded at every render site: this
 * response is polled, and a half-shaped payload from an older backend should
 * degrade to zeroes, not blank the page mid-refresh.
 */
export async function getEventDashboard(eventId: string): Promise<EventDashboard> {
  const wire = await apiGet<Partial<EventDashboard>>(
    `/api/events/${encodeURIComponent(eventId)}/dashboard`
  )
  return {
    submission_funnel: { ...EMPTY_FUNNEL, ...(wire.submission_funnel ?? {}) },
    speakers: Array.isArray(wire.speakers) ? wire.speakers : [],
    totals: { ...EMPTY_TOTALS, ...(wire.totals ?? {}) },
  }
}

/** The org's events, newest first — the dashboard reads the first one, as the inbox does. */
export function listDashboardEvents(): Promise<EventSummary[]> {
  return apiGet<unknown>('/api/events').then((payload) => unwrapList<EventSummary>(payload as never))
}
