/**
 * Organizer-side wire layer for the speaker portal (requirement #2, admin).
 *
 * The mirror of lib/portalApi.ts: this surface is JWT-authed and org-scoped, so
 * everything rides the shared `request` transport (bearer header, error class).
 */

import { apiGet, apiPatch, apiPost } from '@/lib/api'

export interface EventSpeaker {
  contact_id: string
  name: string
  email: string | null
  company_name?: string | null
  title?: string | null
  photo_url: string | null
  session_count: number
  last_portal_access_at: string | null
  tasks_total: number
  tasks_done: number
  tasks_outstanding: number
  tasks?: EventSpeakerTask[]
  invited: boolean
}

export interface EventSpeakerTask {
  assignment_id: string
  task_id: string
  name: string
  status: string | null
  done: boolean
  due_at: string | null
  required: boolean
}

export interface EventSpeakers {
  event: { id: string; name: string | null }
  speakers: EventSpeaker[]
}

/** GET /api/events/{id}/speakers — the roster with onboarding progress. */
export function listEventSpeakers(eventId: string): Promise<EventSpeakers> {
  return apiGet<EventSpeakers>(`/api/events/${encodeURIComponent(eventId)}/speakers`)
}

export interface PortalInviteResult {
  ok: boolean
  invited?: boolean
  /** The full portal magic-link URL just minted — shareable directly while
   * email delivery is pending a mail provider. */
  invite_url: string
}

/** POST /api/contacts/{id}/portal-invite — mint a link + queue the invite email. */
export function sendPortalInvite(contactId: string): Promise<PortalInviteResult> {
  return apiPost<PortalInviteResult>(`/api/contacts/${encodeURIComponent(contactId)}/portal-invite`)
}

export type TaskKind = 'todo' | 'file_request'

export interface CreateTaskInput {
  name: string
  description?: string
  kind: TaskKind
  link_url?: string | null
  due_at?: string | null
  required?: boolean
  contact_ids: string[]
}

export interface CreatedTask {
  task: { id: string; name: string; kind: string }
  assignments_created: number
}

/** POST /api/events/{id}/tasks — author a task and assign it to speakers. */
export function createSpeakerTask(eventId: string, input: CreateTaskInput): Promise<CreatedTask> {
  return apiPost<CreatedTask>(`/api/events/${encodeURIComponent(eventId)}/tasks`, input)
}

export type ReviewDecision = 'approved' | 'denied'

/** PATCH /api/task-assignments/{id}/review — approve/deny and notify the speaker. */
export function reviewTaskAssignment(
  assignmentId: string,
  decision: ReviewDecision
): Promise<{ assignment: { id: string; status: string } }> {
  return apiPatch<{ assignment: { id: string; status: string } }>(
    `/api/task-assignments/${encodeURIComponent(assignmentId)}/review`,
    { decision }
  )
}
