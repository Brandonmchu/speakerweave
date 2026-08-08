/**
 * The one door to the backend.
 *
 * Every read and write in dais goes through here — there is no supabase-js in
 * the browser and no direct PostgREST access. That keeps org isolation an
 * application concern the FastAPI layer enforces on every route.
 *
 * Auth today is a dev bearer token pasted into localStorage by /dev-login.
 * `getToken()` is the single indirection point: swapping in Clerk later means
 * replacing that one function's body (and making it async — `request` already
 * awaits it), not touching a single call site.
 */

import type { QuestionRule } from '@/lib/rules'

const TOKEN_STORAGE_KEY = 'dais.token'

/** Base origin for API calls. Empty string = same-origin (Vite proxy in dev, nginx in prod). */
const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '')

// --- token store ----------------------------------------------------------

const tokenListeners = new Set<() => void>()

function notifyTokenChange() {
  tokenListeners.forEach((listener) => listener())
}

/**
 * Auth token source. When Clerk is active (VITE_CLERK_PUBLISHABLE_KEY set),
 * ClerkTokenBridge registers a getter that mints a `supabase`-template JWT;
 * otherwise we fall back to the dev token in localStorage.
 */
let clerkTokenGetter: (() => Promise<string | null>) | null = null

export function registerClerkTokenGetter(getter: (() => Promise<string | null>) | null): void {
  clerkTokenGetter = getter
}

export async function getToken(): Promise<string | null> {
  if (clerkTokenGetter) {
    try {
      const clerkToken = await clerkTokenGetter()
      if (clerkToken) return clerkToken
      // Fall through: a dev/demo token in localStorage lets the one-click demo
      // work even in a Clerk-enabled build where the user isn't Clerk-signed-in.
    } catch {
      // ignore and fall through to the local token
    }
  }
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    // Private-mode Safari and friends.
    return null
  }
}

/** Synchronous peek — for render-time guards that can't await. */
export function peekToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    /* ignore */
  }
  notifyTokenChange()
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  notifyTokenChange()
}

/** Subscribe to token changes (used by the route guard). Returns an unsubscribe. */
export function subscribeToken(listener: () => void): () => void {
  tokenListeners.add(listener)
  return () => {
    tokenListeners.delete(listener)
  }
}

// --- errors ---------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown

  constructor(message: string, status: number, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/**
 * FastAPI puts human-readable errors in `detail` — a string for HTTPException,
 * a list of {loc, msg} for validation failures. Never surface raw JSON to a
 * conference organizer.
 */
function friendlyMessage(payload: unknown, status: number): { message: string; detail: unknown } {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail: unknown }).detail
    if (typeof detail === 'string' && detail.trim()) return { message: detail, detail }
    if (Array.isArray(detail)) {
      const parts = detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : null))
        .filter((m): m is string => Boolean(m))
      if (parts.length) return { message: parts.join('. '), detail }
    }
    return { message: fallbackMessage(status), detail }
  }
  if (typeof payload === 'string' && payload.trim()) return { message: payload, detail: payload }
  return { message: fallbackMessage(status), detail: payload }
}

function fallbackMessage(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again to continue.'
  if (status === 403) return "You don't have access to this."
  if (status === 404) return "We couldn't find that."
  if (status === 429) return 'Too many requests — give it a moment and try again.'
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.'
  return 'That request could not be completed.'
}

// --- request --------------------------------------------------------------

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  /** Skip the Authorization header (public CFP/agenda endpoints). */
  anonymous?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, anonymous = path.startsWith('/public'), headers, ...init } = options

  const finalHeaders = new Headers(headers)
  if (body !== undefined && !finalHeaders.has('Content-Type')) {
    finalHeaders.set('Content-Type', 'application/json')
  }
  if (!anonymous) {
    const token = await getToken()
    // NOTE: Authorization + Content-Type only. Never send an org header — the
    // org is a claim on the token, and a new custom header means updating the
    // backend's CORS allow-list in the same change or preflight 400s.
    if (token) finalHeaders.set('Authorization', `Bearer ${token}`)
  }

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0)
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const { message, detail } = friendlyMessage(payload, response.status)
    // A dead token should bounce the operator to /dev-login rather than
    // leaving every panel stuck on an error.
    if (response.status === 401 && !anonymous) clearToken()
    throw new ApiError(message, response.status, detail)
  }

  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export const apiGet = <T>(path: string, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'GET' })

export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'POST', body })

export const apiPatch = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'PATCH', body })

// --- shared types ---------------------------------------------------------
// Kept here (rather than a types.ts) so the wire contract lives next to the
// only code that speaks it. See PLAN.md §2 for the source-of-truth schema.

export interface EventSummary {
  id: string
  name: string
  slug: string
  starts_at?: string | null
  ends_at?: string | null
  timezone?: string | null
  location?: string | null
}

export type SubmissionStatus =
  | 'draft'
  | 'pending'
  | 'accept_queue'
  | 'accepted'
  | 'decline_queue'
  | 'declined'
  | 'withdrawn'

export interface SubmitterSummary {
  id?: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  company_name?: string | null
}

export interface Submission {
  id: string
  friendly_id?: string | null
  title: string
  description?: string | null
  status: SubmissionStatus
  submitted_at?: string | null
  created_at?: string | null
  source_form_id?: string | null
  submitter?: SubmitterSummary | null
}

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'select'
  | 'checkbox'
  | (string & {})

export interface FormFieldOption {
  value: string
  label?: string | null
}

export interface PublicFormField {
  id: string
  /** Stable machine key when the backend has one (e.g. "title"). */
  key?: string | null
  label: string
  type: FormFieldType
  required?: boolean
  help_text?: string | null
  placeholder?: string | null
  order?: number | null
  options?: Array<FormFieldOption | string> | null
}

export interface PublicForm {
  id: string
  slug: string
  name: string
  event_name?: string | null
  welcome_html?: string | null
  confirmation_html?: string | null
  closed?: boolean
  submission_limit?: number | null
  fields: PublicFormField[]
  /**
   * Conditional logic, evaluated live in the renderer by lib/rules.ts and again
   * on submit by the server. Always an array — an older backend that doesn't
   * send the key yields a form with no conditions rather than a crash.
   */
  question_rules: QuestionRule[]
}

export interface SubmissionReceipt {
  id: string
  friendly_id?: string | null
  title?: string | null
  status?: SubmissionStatus
}

/**
 * Lists may arrive bare (`[...]`) or wrapped (`{items: [...]}`) depending on how
 * the route ends up shaped. Tolerate both so a backend tweak can't blank a page.
 */
export function unwrapList<T>(payload: T[] | Record<string, unknown> | null | undefined): T[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    if (Array.isArray((payload as { items?: T[] }).items)) return (payload as { items: T[] }).items
    // Envelope like {events: [...]} or {event, submissions: [...], count} —
    // exactly one array-valued key means that key is the list.
    const arrays = Object.values(payload).filter(Array.isArray)
    if (arrays.length === 1) return arrays[0] as T[]
  }
  return []
}

// ── Public form wire adapters ────────────────────────────────────────────────
// The backend returns {form, event, fields} with fields[].options as a JSONB
// object ({choices, help, max_length}) and field_type 'dropdown'. The view
// layer wants the flattened PublicForm shape. Adapt here, in one place.

interface PublicFormWire {
  form: {
    id: string
    slug: string
    name: string
    welcome_html?: string | null
    settings?: {
      close_at?: string | null
      confirmation_html?: string | null
      submission_limit?: number | null
    } | null
  }
  event: { name?: string | null } | null
  fields: Array<{
    id: string
    label: string
    type: string
    options?: { choices?: string[]; help?: string | null } | null
    required?: boolean
    help_text?: string | null
    page?: number
    order?: number
  }>
  question_rules?: QuestionRule[] | null
}

const WIRE_TYPE_MAP: Record<string, FormFieldType> = {
  dropdown: 'select',
  multi_select: 'select',
  url: 'text',
  wysiwyg: 'textarea',
}

export async function getPublicForm(slug: string): Promise<PublicForm> {
  const wire = await apiGet<PublicFormWire>(`/public/forms/${encodeURIComponent(slug)}`)
  const settings = wire.form.settings ?? {}
  const closeAt = settings.close_at ? new Date(settings.close_at) : null
  return {
    id: wire.form.id,
    slug: wire.form.slug,
    name: wire.form.name,
    event_name: wire.event?.name ?? null,
    welcome_html: wire.form.welcome_html ?? null,
    confirmation_html: settings.confirmation_html ?? null,
    closed: closeAt !== null && closeAt.getTime() < Date.now(),
    submission_limit: settings.submission_limit ?? null,
    fields: wire.fields.map((f) => ({
      id: f.id,
      label: f.label,
      type: WIRE_TYPE_MAP[f.type] ?? f.type,
      required: f.required,
      help_text: f.help_text ?? f.options?.help ?? null,
      order: f.order,
      options: f.options?.choices ?? null,
    })),
    // Rules key off field ids, which is exactly what `fields[].id` above is —
    // so they pass through untouched and lib/rules.ts can read them directly.
    question_rules: wire.question_rules ?? [],
  }
}

export interface SubmissionInput {
  first_name: string
  last_name: string
  email: string
  title: string
  description?: string
  answers: Record<string, string | boolean>
}

// ── Submission detail (organizer inbox) ─────────────────────────────────────

/**
 * One answer, already resolved against the form that collected it. The backend
 * joins `sessions.form_answers` (keyed by field id) to the field definitions so
 * the inbox never has to fetch a form to render a label — and so answers to
 * fields that were later deleted still read as something.
 */
export interface SessionAnswer {
  field_id: string
  label: string
  field_type: FormFieldType
  value: unknown
}

export type ParticipantRole = 'speaker' | 'chairperson' | 'moderator' | 'submitter' | (string & {})

export interface SessionParticipant {
  contact_id: string
  role: ParticipantRole
  is_primary?: boolean
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}

export interface SessionDetail {
  session: Submission
  answers: SessionAnswer[]
  participants: SessionParticipant[]
}

/** GET /api/sessions/{id} → {session, answers, participants}. */
export async function getSessionDetail(id: string): Promise<SessionDetail> {
  const wire = await apiGet<Partial<SessionDetail>>(`/api/sessions/${encodeURIComponent(id)}`)
  return {
    session: (wire.session ?? { id, title: '', status: 'pending' }) as Submission,
    answers: Array.isArray(wire.answers) ? wire.answers : [],
    participants: Array.isArray(wire.participants) ? wire.participants : [],
  }
}

/** PATCH /api/sessions/{id} {status} → {session}. Bare rows tolerated. */
export async function updateSessionStatus(id: string, status: SubmissionStatus): Promise<Submission> {
  const wire = await apiPatch<{ session?: Submission } | Submission>(
    `/api/sessions/${encodeURIComponent(id)}`,
    { status }
  )
  const session = (wire as { session?: Submission })?.session
  return session ?? (wire as Submission)
}

export function submitPublicForm(slug: string, input: SubmissionInput): Promise<SubmissionReceipt> {
  return apiPost<SubmissionReceipt>(`/public/forms/${encodeURIComponent(slug)}/submissions`, {
    email: input.email,
    first_name: input.first_name,
    last_name: input.last_name,
    title: input.title,
    description: input.description ?? '',
    answers: input.answers,
  })
}
