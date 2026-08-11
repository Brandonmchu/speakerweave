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
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData

  const finalHeaders = new Headers(headers)
  if (body !== undefined && !isFormData && !finalHeaders.has('Content-Type')) {
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
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
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

export type SessionContentApproval = 'draft' | 'in_review' | 'approved'

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
  /** Public-program content readiness; old payloads are treated as approved. */
  content_approval?: SessionContentApproval
  submitted_at?: string | null
  created_at?: string | null
  source_form_id?: string | null
  track_id?: string | null
  format_id?: string | null
  submitter?: SubmitterSummary | null
  /** Average reviewer score across completed reviews (null = none yet). */
  review_score?: number | null
  /** How many completed reviews the average is drawn from. */
  review_count?: number | null
}

export type SubmissionDecision = 'approve' | 'maybe' | 'deny'

export interface SubmissionDecisionInput {
  decision: SubmissionDecision
  feedback?: string
  email_speaker?: boolean
}

export interface SubmissionDecisionResult {
  session: Submission
  onboarding: { tasks_assigned: number }
  emailed: boolean
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
  /** Raw submission deadline (ISO), so the form can show it and count down. */
  close_at?: string | null
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
  /**
   * The submitter's OWN magic-link token, minted server-side at submit time
   * (they proved ownership by submitting from that email). Present so the
   * confirmation screen can offer an in-app manage link — clickable + copyable —
   * with no email round-trip. Absent only if the server couldn't mint it, in
   * which case the confirmation falls back to the "email me the link" prompt.
   */
  manage_token?: string | null
  /** A ready absolute manage URL for that same token (server-built convenience). */
  manage_url?: string | null
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
    close_at: settings.close_at ?? null,
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

/**
 * A co-presenter named on the public CFP form. Email is the identity: the
 * backend upserts a contact on (event, email), so a co-speaker the organizer
 * already knows resolves to their existing record.
 */
export interface CoSpeakerInput {
  first_name: string
  last_name: string
  email: string
}

export interface SubmissionInput {
  first_name: string
  last_name: string
  email: string
  title: string
  description?: string
  answers: Record<string, string | boolean>
  /** Optional co-presenters (max 3, enforced both sides). */
  co_speakers?: CoSpeakerInput[]
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

/**
 * One reviewer's verdict on a submission, resolved for the organizer. The
 * `reviewer` label is already anonymized server-side ("Reviewer 1") when the
 * plan hides identity, so the UI never has to decide what to reveal.
 */
export interface SessionReviewVerdict {
  reviewer: string
  anonymized: boolean
  overall: number | null
  comment?: string | null
  /** A reviewer's organizer-only note, shown alongside the public comment. */
  internal_comment?: string | null
  scores?: Record<string, number>
  abstained: boolean
  abstain_reason?: string | null
}

export interface SessionReviewCriterion {
  name: string
  weight?: number | null
  average: number | null
}

/** The aggregate of what reviewers scored and wrote about one submission. */
export interface SessionReviewAggregate {
  review_count: number
  completed_count: number
  abstained_count: number
  any_abstained: boolean
  avg_overall: number | null
  scale: string
  criteria: SessionReviewCriterion[]
  reviews: SessionReviewVerdict[]
}

const EMPTY_REVIEW_AGGREGATE: SessionReviewAggregate = {
  review_count: 0,
  completed_count: 0,
  abstained_count: 0,
  any_abstained: false,
  avg_overall: null,
  scale: '1_5',
  criteria: [],
  reviews: [],
}

export interface SessionDetail {
  session: Submission
  answers: SessionAnswer[]
  participants: SessionParticipant[]
  reviews: SessionReviewAggregate
}

export interface SessionRevision {
  id: string
  session_id: string
  field: 'title' | 'description'
  old_value: string | null
  new_value: string | null
  actor: string
  created_at: string | null
}

/** GET /api/sessions/{id} → {session, answers, participants, reviews}. */
export async function getSessionDetail(id: string): Promise<SessionDetail> {
  const wire = await apiGet<Partial<SessionDetail>>(`/api/sessions/${encodeURIComponent(id)}`)
  return {
    session: (wire.session ?? { id, title: '', status: 'pending' }) as Submission,
    answers: Array.isArray(wire.answers) ? wire.answers : [],
    participants: Array.isArray(wire.participants) ? wire.participants : [],
    reviews: wire.reviews ?? EMPTY_REVIEW_AGGREGATE,
  }
}

/** GET /api/sessions/{id}/revisions — optional, newest-first edit history. */
export async function listSessionRevisions(id: string): Promise<SessionRevision[]> {
  const wire = await apiGet<{ revisions?: SessionRevision[] }>(
    `/api/sessions/${encodeURIComponent(id)}/revisions`
  )
  return Array.isArray(wire.revisions) ? wire.revisions : []
}

/** POST restore — the server records this pointer-back as a fresh revision. */
export async function restoreSessionRevision(
  sessionId: string,
  revisionId: string
): Promise<Submission> {
  const wire = await apiPost<{ session?: Submission } | Submission>(
    `/api/sessions/${encodeURIComponent(sessionId)}/revisions/${encodeURIComponent(revisionId)}/restore`
  )
  return (wire as { session?: Submission }).session ?? (wire as Submission)
}

/* ── participants, after submission (ABS-11) ────────────────────────────────
 * A co-speaker named on the CFP form isn't the end of the story: people join a
 * talk, drop off it, and swap who leads it after the call closes. All three
 * writes return the session's participants as the server now holds them, so
 * the drawer re-renders from the source of truth rather than guessing. */

export interface SessionParticipantsResponse {
  participants: SessionParticipant[]
}

/** POST /api/sessions/{id}/participants — add a co-speaker (contact upserted). */
export function addSessionParticipant(
  sessionId: string,
  input: { name: string; email: string; role?: ParticipantRole }
): Promise<SessionParticipant[]> {
  return apiPost<SessionParticipantsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/participants`,
    { name: input.name, email: input.email, role: input.role ?? 'speaker' }
  ).then((response) => response.participants ?? [])
}

/** DELETE /api/sessions/{id}/participants/{contactId} — non-primary only. */
export function removeSessionParticipant(
  sessionId: string,
  contactId: string
): Promise<SessionParticipant[]> {
  return request<SessionParticipantsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(contactId)}`,
    { method: 'DELETE' }
  ).then((response) => response?.participants ?? [])
}

/** POST /api/sessions/{id}/participants/{contactId}/primary — hand over the lead. */
export function setPrimaryParticipant(
  sessionId: string,
  contactId: string
): Promise<SessionParticipant[]> {
  return apiPost<SessionParticipantsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(
      contactId
    )}/primary`
  ).then((response) => response.participants ?? [])
}

export interface ManualSubmissionInput {
  title: string
  submitter_name?: string
  submitter_email: string
  abstract?: string
  track_id?: string | null
  format_id?: string | null
}

/** POST /api/events/{eventId}/sessions → the new pending submission. */
export async function createSubmission(
  eventId: string,
  input: ManualSubmissionInput
): Promise<Submission> {
  const wire = await apiPost<{ session?: Submission } | Submission>(
    `/api/events/${encodeURIComponent(eventId)}/sessions`,
    {
      title: input.title,
      submitter_name: input.submitter_name ?? '',
      submitter_email: input.submitter_email,
      abstract: input.abstract ?? '',
      track_id: input.track_id || undefined,
      format_id: input.format_id || undefined,
    }
  )
  const session = (wire as { session?: Submission })?.session
  return session ?? (wire as Submission)
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

/** What an organizer may rewrite on a session from the inbox drawer (CNT-09). */
export interface SessionEditInput {
  title?: string
  /** The abstract. Sent as `description`, the column's real name. */
  description?: string
  content_approval?: SessionContentApproval
}

/**
 * PATCH /api/sessions/{id} {title, description} → {session}.
 *
 * The same endpoint as the status move, and deliberately so: one session, one
 * place to change it. Only the keys present are written, so editing a title
 * never blanks the abstract.
 */
export async function updateSession(id: string, input: SessionEditInput): Promise<Submission> {
  const body: Record<string, string> = {}
  if (input.title !== undefined) body.title = input.title
  if (input.description !== undefined) body.description = input.description
  if (input.content_approval !== undefined) body.content_approval = input.content_approval
  const wire = await apiPatch<{ session?: Submission } | Submission>(
    `/api/sessions/${encodeURIComponent(id)}`,
    body
  )
  const session = (wire as { session?: Submission })?.session
  return session ?? (wire as Submission)
}

/** POST the minimum review decision and receive any acceptance provisioning count. */
export function decideSubmission(
  id: string,
  input: SubmissionDecisionInput
): Promise<SubmissionDecisionResult> {
  return apiPost<SubmissionDecisionResult>(`/api/sessions/${encodeURIComponent(id)}/decision`, input)
}

export function submitPublicForm(slug: string, input: SubmissionInput): Promise<SubmissionReceipt> {
  return apiPost<SubmissionReceipt>(`/public/forms/${encodeURIComponent(slug)}/submissions`, {
    email: input.email,
    first_name: input.first_name,
    last_name: input.last_name,
    title: input.title,
    description: input.description ?? '',
    answers: input.answers,
    co_speakers: input.co_speakers ?? [],
  })
}

// ── Submitter self-service (magic-link, no Clerk) ────────────────────────────
// After submitting, a speaker asks for a link to their email, then views /
// edits / withdraws their own submissions while the CFP is open. The token is
// the bearer credential every call carries; /public paths never send Authorization.

export interface SubmitterSubmission {
  id: string
  friendly_id?: string | null
  title: string
  abstract: string
  track?: string | null
  track_id?: string | null
  format?: string | null
  format_id?: string | null
  status: SubmissionStatus
  submitted_at?: string | null
  /** The CFP is still open AND the submission is still pending. */
  editable: boolean
  /** A final accept/decline has been made. */
  decided: boolean
  decision?: string | null
  feedback?: string | null
  participants: SubmitterParticipant[]
}

export interface SubmitterParticipant {
  contact_id: string
  name: string
  first_name: string
  last_name: string
  email: string | null
  role: string | null
  roles: string[]
  is_primary: boolean
}

export interface SubmitterTaxonomyItem {
  id: string
  name: string
}

export interface SubmitterEventInfo {
  id?: string | null
  name?: string | null
  close_at?: string | null
  closed?: boolean
}

export interface SubmitterDashboardData {
  email: string | null
  event: SubmitterEventInfo | null
  tracks: SubmitterTaxonomyItem[]
  formats: SubmitterTaxonomyItem[]
  submissions: SubmitterSubmission[]
}

export interface SubmitterEditInput {
  title?: string
  abstract?: string
  track_id?: string | null
  format_id?: string | null
}

/** Ask the backend to email a manage link. Always resolves 200 with a generic
 * message — it never reveals whether the address has any submissions. */
export function requestManageLink(
  slug: string,
  email: string
): Promise<{ ok: boolean; message: string }> {
  return apiPost<{ ok: boolean; message: string }>(
    `/public/forms/${encodeURIComponent(slug)}/manage-link`,
    { email }
  )
}

/**
 * One submission, with every field the edit form binds to guaranteed present.
 *
 * The edit form initialises its inputs from this object, so a missing or
 * differently-named key does not degrade — it renders an empty box over a
 * stored value and then SAVES that emptiness. `description` is accepted as an
 * alias for `abstract` for exactly that reason: the column behind it is
 * `sessions.description`, and the two names have drifted before.
 */
function normalizeSubmitterSubmission(wire: unknown): SubmitterSubmission {
  const row = (wire ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const id = (value: unknown): string | null =>
    typeof value === 'string' && value ? value : null
  return {
    ...(row as unknown as SubmitterSubmission),
    id: text(row.id),
    title: text(row.title),
    abstract: text(row.abstract) || text(row.description),
    track: text(row.track) || null,
    track_id: id(row.track_id),
    format: text(row.format) || null,
    format_id: id(row.format_id),
    editable: Boolean(row.editable),
    decided: Boolean(row.decided),
    participants: Array.isArray(row.participants)
      ? (row.participants as SubmitterParticipant[])
      : [],
  }
}

/** GET this submitter's submissions + the event's editable taxonomy. */
export async function getSubmitterSubmissions(token: string): Promise<SubmitterDashboardData> {
  const wire = await apiGet<Partial<SubmitterDashboardData>>(
    `/public/submissions?token=${encodeURIComponent(token)}`
  )
  return {
    email: typeof wire.email === 'string' ? wire.email : null,
    event: wire.event ?? null,
    tracks: Array.isArray(wire.tracks) ? wire.tracks : [],
    formats: Array.isArray(wire.formats) ? wire.formats : [],
    submissions: Array.isArray(wire.submissions)
      ? wire.submissions.map(normalizeSubmitterSubmission)
      : [],
  }
}

export async function editSubmitterSubmission(
  id: string,
  token: string,
  input: SubmitterEditInput
): Promise<SubmitterSubmission> {
  const wire = await apiPatch<{ submission?: SubmitterSubmission } | SubmitterSubmission>(
    `/public/submissions/${encodeURIComponent(id)}`,
    { token, ...input }
  )
  const submission = (wire as { submission?: SubmitterSubmission })?.submission
  return normalizeSubmitterSubmission(submission ?? wire)
}

export async function withdrawSubmitterSubmission(
  id: string,
  token: string
): Promise<SubmitterSubmission> {
  const wire = await apiPost<{ submission?: SubmitterSubmission } | SubmitterSubmission>(
    `/public/submissions/${encodeURIComponent(id)}/withdraw`,
    { token }
  )
  const submission = (wire as { submission?: SubmitterSubmission })?.submission
  return normalizeSubmitterSubmission(submission ?? wire)
}

/** Token-scoped co-speaker add; returns the de-duplicated participant roster. */
export async function addSubmitterParticipant(
  id: string,
  token: string,
  input: { name: string; email: string }
): Promise<SubmitterParticipant[]> {
  const wire = await apiPost<{ participants?: SubmitterParticipant[] }>(
    `/public/submissions/${encodeURIComponent(id)}/participants`,
    { token, name: input.name, email: input.email }
  )
  return Array.isArray(wire.participants) ? wire.participants : []
}

// ── Speaker CRM (organizer) ──────────────────────────────────────────────────
// The roster list + invite + task authoring live in lib/speakersApi.ts. This is
// the CRM layer on top: the per-speaker profile drawer, bulk CSV import, and
// profile edit — every call JWT-authed and org/event scoped by the backend.

/**
 * The organizer's manual speaker workflow status (migration 010). Null/absent
 * means "not set" — the state most of a roster is in on day one.
 *
 * Deliberately separate from the DERIVED signals the roster already shows:
 * `invited` there means "a portal magic link was minted", and the onboarding
 * counts mean "their paperwork is in". This one means "have they said yes".
 */
export type SpeakerStatus = 'invited' | 'confirmed' | 'declined'

export const SPEAKER_STATUSES: SpeakerStatus[] = ['invited', 'confirmed', 'declined']

export function isSpeakerStatus(value: unknown): value is SpeakerStatus {
  return SPEAKER_STATUSES.includes(value as SpeakerStatus)
}

/** The identity block of a speaker profile — everything the drawer header shows. */
export interface SpeakerProfileContact {
  contact_id: string
  name: string
  first_name: string
  last_name: string
  email: string | null
  company_name: string | null
  title: string | null
  about: string | null
  /**
   * Travel & logistics for this speaker — flights, hotel, arrival/departure,
   * ground transport, dietary/accessibility needs. Null on a backend that
   * predates migration 009, which the drawer renders as "nothing recorded".
   */
  logistics_notes?: string | null
  /** Organizer-set workflow status; null on a backend that predates 010. */
  speaker_status?: SpeakerStatus | null
  photo_url: string | null
  pronouns: string | null
  linkedin_url: string | null
  twitter_url: string | null
  phone: string | null
  last_portal_access_at: string | null
  invited: boolean
  session_count: number
  submission_count: number
  tasks_total: number
  tasks_done: number
  tasks_outstanding: number
}

export interface SpeakerProfileSubmission {
  id: string
  friendly_id?: string | null
  title: string | null
  status: SubmissionStatus
  submitted_at?: string | null
}

export interface SpeakerProfileSession {
  id: string
  friendly_id?: string | null
  title: string | null
  status: SubmissionStatus
  starts_at: string | null
  ends_at: string | null
  room: string | null
  role: string | null
  is_primary: boolean
  scheduled: boolean
}

export interface SpeakerOnboardingItem {
  assignment_id: string
  task_id: string
  name: string | null
  kind: string | null
  status: string | null
  due_at: string | null
  required: boolean
  completed_at: string | null
}

export interface SpeakerCommunication {
  id: string
  template_key: string | null
  subject: string | null
  status: string | null
  sent_at: string | null
  created_at: string | null
  error: string | null
}

export interface SpeakerProfile {
  event: { id: string; name: string | null }
  speaker: SpeakerProfileContact
  submissions: SpeakerProfileSubmission[]
  sessions: SpeakerProfileSession[]
  onboarding: SpeakerOnboardingItem[]
  communications: SpeakerCommunication[]
}

/** GET /api/events/{id}/speakers/{contactId} — the full profile aggregate. */
export async function getSpeakerProfile(eventId: string, contactId: string): Promise<SpeakerProfile> {
  const wire = await apiGet<Partial<SpeakerProfile>>(
    `/api/events/${encodeURIComponent(eventId)}/speakers/${encodeURIComponent(contactId)}`
  )
  return {
    event: wire.event ?? { id: eventId, name: null },
    speaker: wire.speaker as SpeakerProfileContact,
    submissions: Array.isArray(wire.submissions) ? wire.submissions : [],
    sessions: Array.isArray(wire.sessions) ? wire.sessions : [],
    onboarding: Array.isArray(wire.onboarding) ? wire.onboarding : [],
    communications: Array.isArray(wire.communications) ? wire.communications : [],
  }
}

/**
 * GET /api/events/{id}/speaker-statuses — every workflow status set on this
 * event, as {contact_id: status}.
 *
 * One flat call that rides alongside the roster, so the list can badge and
 * filter by status without a request per row. Contacts with nothing set are
 * absent from the map and read as "not set".
 */
export async function listSpeakerStatuses(
  eventId: string
): Promise<Record<string, SpeakerStatus>> {
  const wire = await apiGet<{ statuses?: Array<{ contact_id?: string; speaker_status?: string }> }>(
    `/api/events/${encodeURIComponent(eventId)}/speaker-statuses`
  )
  const byContact: Record<string, SpeakerStatus> = {}
  for (const row of wire.statuses ?? []) {
    if (row?.contact_id && isSpeakerStatus(row.speaker_status)) {
      byContact[row.contact_id] = row.speaker_status
    }
  }
  return byContact
}

export interface SpeakerImportRow {
  first_name?: string
  last_name?: string
  email: string
  company?: string
  title?: string
}

export interface SpeakerImportError {
  line?: number | null
  email?: string
  message: string
}

export interface SpeakerImportResult {
  created: number
  updated: number
  skipped: number
  errors: SpeakerImportError[]
  /** Headings in the file the importer did not understand and therefore dropped. */
  ignored_columns: string[]
  total: number
}

/**
 * POST /api/events/{id}/speakers/import — bulk add by upserting on
 * (event_id, email). Pass raw `csv` text (paste/upload) OR a structured `rows`
 * list (the manual single-add path). Returns per-bucket counts + row errors.
 */
export async function importSpeakers(
  eventId: string,
  input: { csv?: string; rows?: SpeakerImportRow[] }
): Promise<SpeakerImportResult> {
  const wire = await apiPost<Partial<SpeakerImportResult>>(
    `/api/events/${encodeURIComponent(eventId)}/speakers/import`,
    input
  )
  return {
    created: wire.created ?? 0,
    updated: wire.updated ?? 0,
    skipped: wire.skipped ?? 0,
    errors: Array.isArray(wire.errors) ? wire.errors : [],
    ignored_columns: Array.isArray(wire.ignored_columns) ? wire.ignored_columns : [],
    total: wire.total ?? 0,
  }
}

export interface SpeakerEditInput {
  first_name?: string
  last_name?: string
  email?: string
  company_name?: string
  title?: string
  about?: string
  logistics_notes?: string
  /** '' or null clears the status back to "not set". */
  speaker_status?: SpeakerStatus | '' | null
}

/** PATCH /api/events/{id}/speakers/{contactId} — edit profile fields. */
export async function updateSpeaker(
  eventId: string,
  contactId: string,
  input: SpeakerEditInput
): Promise<SpeakerProfileContact> {
  const wire = await apiPatch<{ speaker?: SpeakerProfileContact } | SpeakerProfileContact>(
    `/api/events/${encodeURIComponent(eventId)}/speakers/${encodeURIComponent(contactId)}`,
    input
  )
  const speaker = (wire as { speaker?: SpeakerProfileContact })?.speaker
  return (speaker ?? wire) as SpeakerProfileContact
}

/** Organizer-side photo replacement; validation and versioning happen server-side. */
export async function uploadSpeakerPhoto(
  eventId: string,
  contactId: string,
  file: File
): Promise<{ photo_url: string; version: number | null }> {
  const form = new FormData()
  form.append('file', file)
  return request<{ photo_url: string; version: number | null }>(
    `/api/events/${encodeURIComponent(eventId)}/speakers/${encodeURIComponent(contactId)}/photo`,
    { method: 'POST', body: form }
  )
}
