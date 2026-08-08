/**
 * Wire layer for the public speaker portal (requirement #2).
 *
 * Every call is cookie-authenticated (`credentials: 'include'`) and anonymous —
 * there is no bearer token on this surface, only the `dais_portal` HttpOnly
 * cookie minted when the speaker redeemed their magic link. JSON reads/writes go
 * through the shared `request` helper; the two uploads use a bare `fetch` because
 * `request` always JSON-encodes its body, which would corrupt multipart form
 * data.
 */

import { ApiError, request } from '@/lib/api'

/** Same base-origin rule as lib/api.ts — empty string means same-origin. */
const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '')

export type PortalTaskKind = 'todo' | 'file_request' | 'form' | (string & {})

export type PortalTaskStatus =
  | 'todo'
  | 'submitted'
  | 'approved'
  | 'denied'
  | 'done'
  | (string & {})

export interface PortalContact {
  id: string
  first_name: string
  last_name: string
  email: string | null
  about: string
  company_name: string
  title: string
  pronouns: string
  photo_url: string | null
  linkedin_url: string
  twitter_url: string
  phone: string
}

export interface PortalBranding {
  name: string
  welcome_html: string
  accent_color: string
  logo_url: string | null
}

export interface PortalSession {
  id: string
  title: string | null
  status: string | null
  friendly_id: string | null
  starts_at: string | null
  ends_at: string | null
  role: string | null
  is_primary: boolean
}

export interface PortalTaskFile {
  filename: string
  url: string | null
}

export interface PortalTask {
  assignment_id: string
  status: PortalTaskStatus
  completed_at: string | null
  task: {
    id: string
    name: string
    description: string | null
    kind: PortalTaskKind
    link_url: string | null
    due_at: string | null
    required: boolean
  }
  file: PortalTaskFile | null
}

export interface PortalMe {
  contact: PortalContact
  event: { name: string | null }
  portal: PortalBranding
  sessions: PortalSession[]
  tasks: PortalTask[]
}

/** GET /public/portal/me — profile, event, sessions, tasks. Stamps last access. */
export function fetchPortalMe(): Promise<PortalMe> {
  return request<PortalMe>('/public/portal/me', {
    method: 'GET',
    anonymous: true,
    credentials: 'include',
  })
}

export interface ProfileInput {
  first_name?: string
  last_name?: string
  about?: string
  company_name?: string
  title?: string
  pronouns?: string
  linkedin_url?: string
  twitter_url?: string
  phone?: string
}

/** PATCH /public/portal/profile — updates the signed-in speaker only. */
export function updatePortalProfile(patch: ProfileInput): Promise<{ contact: PortalContact }> {
  return request<{ contact: PortalContact }>('/public/portal/profile', {
    method: 'PATCH',
    anonymous: true,
    credentials: 'include',
    body: patch,
  })
}

/** POST /public/portal/tasks/{id}/complete — check off a todo. */
export function completePortalTask(assignmentId: string): Promise<{ status: string }> {
  return request<{ status: string }>(
    `/public/portal/tasks/${encodeURIComponent(assignmentId)}/complete`,
    { method: 'POST', anonymous: true, credentials: 'include' }
  )
}

export interface UploadResult {
  status: string
  file: PortalTaskFile
}

/** POST /public/portal/tasks/{id}/upload — attach a file to a file_request task. */
export function uploadPortalTaskFile(assignmentId: string, file: File): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', file)
  return portalUpload<UploadResult>(
    `/public/portal/tasks/${encodeURIComponent(assignmentId)}/upload`,
    form
  )
}

/** POST /public/portal/headshot — replace the speaker's photo. */
export function uploadPortalHeadshot(file: File): Promise<{ photo_url: string }> {
  const form = new FormData()
  form.append('file', file)
  return portalUpload<{ photo_url: string }>('/public/portal/headshot', form)
}

/**
 * Multipart POST with the cookie attached. Kept out of `request` on purpose:
 * setting Content-Type or JSON-encoding a FormData body both break the upload.
 */
async function portalUpload<T>(path: string, form: FormData): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      body: form,
      credentials: 'include',
    })
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0)
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const detail = (payload as { detail?: unknown } | null)?.detail
    const message =
      typeof detail === 'string' && detail.trim() ? detail : 'That upload could not be completed.'
    throw new ApiError(message, response.status, detail)
  }

  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}
