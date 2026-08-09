/**
 * Wire layer for the content-collection pipeline.
 *
 * A SEPARATE module from lib/api.ts and lib/portalApi.ts on purpose: it speaks
 * to BOTH surfaces. The organizer library calls are JWT-authed and org-scoped
 * (they ride the shared `apiGet`/`apiPost` transport); the single speaker call
 * (`postPortalComment`) is cookie-authed and anonymous, so it goes through
 * `request` with `credentials: 'include'` and no bearer — exactly like
 * lib/portalApi.ts.
 */

import { ApiError, apiGet, apiPost, getToken, request } from '@/lib/api'

const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '')

export type ContentType = 'slides' | 'headshot' | 'bio' | 'other' | (string & {})
export type ContentStatus = 'received' | 'missing' | 'needs_changes' | (string & {})
export type CommentAuthor = 'organizer' | 'speaker' | (string & {})

export interface ContentVersion {
  file_id: string
  version: number
  filename: string | null
  url: string | null
  created_at: string | null
  is_current: boolean
}

export interface ContentComment {
  id: string
  author_role: CommentAuthor
  author_label: string | null
  body: string
  created_at: string | null
}

export interface ContentSpeaker {
  contact_id: string
  name: string
  email: string | null
  photo_url: string | null
}

export interface ContentItem {
  item_id: string
  type: ContentType
  title: string
  required: boolean
  due_at: string | null
  assignment_status: string
  status: ContentStatus
  current_version: number
  versions_count: number
  current_file: ContentVersion | null
  comment_count: number
  updated_at: string | null
  speaker: ContentSpeaker
}

export interface OutstandingSpeaker {
  contact_id: string
  name: string
  email: string | null
  missing: string[]
}

export interface ContentLibrary {
  event: { id: string; name: string | null }
  items: ContentItem[]
  counts: Record<ContentStatus, number>
  outstanding: OutstandingSpeaker[]
}

export interface ContentItemDetail {
  item: {
    item_id: string
    type: ContentType
    title: string
    required: boolean
    assignment_status: string
    status: ContentStatus
    current_version: number
    speaker: ContentSpeaker
  }
  versions: ContentVersion[]
  comments: ContentComment[]
}

export interface RemindResult {
  reminded: number
  contacts: string[]
}

export interface ContentFilters {
  type?: ContentType | 'all'
  status?: ContentStatus | 'all'
}

/** GET /api/events/{id}/content — the cross-speaker library, filtered. */
export function listContent(eventId: string, filters: ContentFilters = {}): Promise<ContentLibrary> {
  const params = new URLSearchParams()
  if (filters.type && filters.type !== 'all') params.set('type', filters.type)
  if (filters.status && filters.status !== 'all') params.set('status', filters.status)
  const qs = params.toString()
  return apiGet<ContentLibrary>(
    `/api/events/${encodeURIComponent(eventId)}/content${qs ? `?${qs}` : ''}`
  )
}

/** GET /api/task-assignments/{id}/content — one item's versions + comment thread. */
export function getContentItem(assignmentId: string): Promise<ContentItemDetail> {
  return apiGet<ContentItemDetail>(
    `/api/task-assignments/${encodeURIComponent(assignmentId)}/content`
  )
}

export interface RestoreResult extends ContentItemDetail {
  restored: { version: number; file_id: string; changed: boolean }
}

/**
 * POST /api/task-assignments/{id}/restore — make a prior version current again.
 *
 * The server moves a pointer rather than deleting anything, and answers with
 * the item's refreshed detail, so the caller re-renders history + thread from
 * this one response.
 */
export function restoreContentVersion(
  assignmentId: string,
  version: number
): Promise<RestoreResult> {
  return apiPost<RestoreResult>(
    `/api/task-assignments/${encodeURIComponent(assignmentId)}/restore`,
    { version }
  )
}

/** POST /api/task-assignments/{id}/comments — organizer leaves feedback. */
export function addContentComment(
  assignmentId: string,
  body: string,
  notify = true
): Promise<{ comment: ContentComment }> {
  return apiPost<{ comment: ContentComment }>(
    `/api/task-assignments/${encodeURIComponent(assignmentId)}/comments`,
    { body, notify }
  )
}

export interface RemindInput {
  required_only?: boolean
  item_type?: ContentType | null
}

/** POST /api/events/{id}/content/remind — queue reminders to outstanding speakers. */
export function remindOutstanding(eventId: string, input: RemindInput = {}): Promise<RemindResult> {
  return apiPost<RemindResult>(`/api/events/${encodeURIComponent(eventId)}/content/remind`, input)
}

/**
 * The authed path to the ZIP bundle export.
 *
 * With no ids it exports the whole event; pass the ids an organizer ticked in
 * the library and the server bundles only those items' current versions.
 */
export function contentExportPath(eventId: string, assignmentIds?: string[]): string {
  const base = `/api/events/${encodeURIComponent(eventId)}/content/export`
  const picked = (assignmentIds ?? []).filter(Boolean)
  return picked.length ? `${base}?assignment_ids=${encodeURIComponent(picked.join(','))}` : base
}

/**
 * Fetch the ZIP bundle as a Blob with the bearer token attached. Kept out of the
 * shared `request` helper because that one parses the body as text/JSON, which
 * would corrupt binary.
 */
export async function fetchContentBundle(eventId: string, assignmentIds?: string[]): Promise<Blob> {
  const token = await getToken()
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${contentExportPath(eventId, assignmentIds)}`, { headers })
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0)
  }
  if (!response.ok) {
    throw new ApiError('That export could not be completed.', response.status)
  }
  return response.blob()
}

/** Fetch the bundle and trigger a browser download. */
export async function downloadContentBundle(
  eventId: string,
  filename = 'content.zip',
  assignmentIds?: string[]
): Promise<void> {
  const blob = await fetchContentBundle(eventId, assignmentIds)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * POST /public/portal/tasks/{id}/comments — the SPEAKER reply from the portal.
 * Cookie-authed, anonymous (no bearer), like the rest of lib/portalApi.ts.
 */
export function postPortalComment(
  assignmentId: string,
  body: string
): Promise<{ comment: ContentComment }> {
  return request<{ comment: ContentComment }>(
    `/public/portal/tasks/${encodeURIComponent(assignmentId)}/comments`,
    { method: 'POST', anonymous: true, credentials: 'include', body: { body } }
  )
}
