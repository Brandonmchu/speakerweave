/**
 * Organizer-side wire layer: forms, the field library, question rules,
 * taxonomy and event settings.
 *
 * Split out of lib/api.ts on purpose — api.ts is the shared transport (token,
 * error shaping, `request`) plus the public CFP contract. Everything an
 * *organizer* touches lives here so the admin surface can grow without the
 * public form's module growing with it.
 *
 * `request` is imported rather than re-implemented: one fetch, one auth header,
 * one error class. api.ts doesn't ship PUT/DELETE helpers (nothing needed them
 * until now), so those two are defined here in the same shape as apiPost.
 */

import { apiGet, apiPatch, apiPost, request, unwrapList, type RequestOptions } from '@/lib/api'

// --- verbs api.ts doesn't have --------------------------------------------

export const apiPut = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'PUT', body })

export const apiDelete = <T>(path: string, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'DELETE' })

// --- fields ---------------------------------------------------------------

/**
 * The field types the builder can create. The backend stores whatever string it
 * is given, so the `(string & {})` tail keeps unknown/legacy types renderable
 * instead of breaking the editor on a value we didn't ship.
 */
export type AdminFieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'url'
  | 'number'
  | 'dropdown'
  | 'checkbox'
  | (string & {})

export const FIELD_TYPES: Array<{ value: string; label: string }> = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'URL' },
  { value: 'number', label: 'Number' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
]

export function fieldTypeLabel(type: AdminFieldType): string {
  return FIELD_TYPES.find((t) => t.value === type)?.label ?? String(type)
}

/** JSONB blob on a field row. `choices` is the only key the builder writes. */
export interface FieldOptions {
  choices?: string[]
  help?: string | null
  max_length?: number | null
  [key: string]: unknown
}

/** A row in the event's reusable field library. */
export interface LibraryField {
  id: string
  scope?: string | null
  public_name: string
  field_type: AdminFieldType
  options?: FieldOptions | null
  required?: boolean
}

export interface CreateFieldInput {
  scope: string
  public_name: string
  field_type: string
  options?: FieldOptions | null
  required?: boolean
}

export function listFields(eventId: string, scope?: string): Promise<LibraryField[]> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return apiGet<unknown>(`/api/events/${eventId}/fields${qs}`).then((p) =>
    unwrapList<LibraryField>(p as never)
  )
}

export function createField(eventId: string, input: CreateFieldInput): Promise<LibraryField> {
  return apiPost<{ field: LibraryField }>(`/api/events/${eventId}/fields`, input).then((r) => r.field)
}

// --- forms ----------------------------------------------------------------

export interface FormSettings {
  close_at?: string | null
  submission_limit?: number | null
  confirmation_html?: string | null
  max_speakers?: number | null
  [key: string]: unknown
}

export interface FormSummary {
  id: string
  slug: string
  name: string
  /** The event this form belongs to — sources the field library (one event's
   * fields, plus org-global ones), never events[0]. */
  event_id?: string | null
  kind?: string | null
  welcome_html?: string | null
  settings?: FormSettings | null
  submission_count?: number
}

/**
 * One question on a form: the join row (page/order/overrides) flattened
 * together with the library field it points at.
 */
export interface FormFieldRow {
  form_field_id: string
  field_id: string
  page: number
  order: number
  label_override?: string | null
  help_text?: string | null
  required: boolean
  public_name: string
  field_type: AdminFieldType
  options?: FieldOptions | null
}

export type RuleOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'not_empty'
export type RuleMatch = 'all' | 'any'
export type RuleAction = 'show' | 'hide' | 'require'

export interface RuleCondition {
  /** field_id of the field being compared. */
  field: string
  op: RuleOp
  value?: string | number | boolean | null
}

export interface RuleLogic {
  when: RuleCondition[]
  match: RuleMatch
  action: RuleAction
}

export interface QuestionRule {
  id?: string
  target_field_id: string
  logic: RuleLogic
}

export interface FormDetail {
  form: FormSummary
  fields: FormFieldRow[]
  question_rules: QuestionRule[]
}

/** What PUT /fields accepts — the join row only, never the library field. */
export interface FormFieldInput {
  field_id: string
  page: number
  order: number
  label_override?: string | null
  help_text?: string | null
  required: boolean
}

export interface FormPatch {
  name?: string
  welcome_html?: string | null
  settings?: FormSettings
}

export function listForms(eventId: string): Promise<FormSummary[]> {
  return apiGet<unknown>(`/api/events/${eventId}/forms`).then((p) => unwrapList<FormSummary>(p as never))
}

export function createForm(eventId: string, name: string): Promise<FormSummary> {
  return apiPost<{ form: FormSummary }>(`/api/events/${eventId}/forms`, { name }).then((r) => r.form)
}

export function getForm(formId: string): Promise<FormDetail> {
  return apiGet<FormDetail>(`/api/forms/${formId}`)
}

export function updateForm(formId: string, patch: FormPatch): Promise<FormSummary> {
  return apiPatch<{ form: FormSummary }>(`/api/forms/${formId}`, patch).then((r) => r.form)
}

/** Full replace — the draft in the editor is the whole truth on save. */
export function putFormFields(formId: string, fields: FormFieldInput[]): Promise<FormFieldRow[]> {
  return apiPut<unknown>(`/api/forms/${formId}/fields`, { fields }).then((p) =>
    unwrapList<FormFieldRow>(p as never)
  )
}

/** Full replace, same reasoning as putFormFields. */
export function putFormRules(
  formId: string,
  rules: Array<{ target_field_id: string; logic: RuleLogic }>
): Promise<QuestionRule[]> {
  return apiPut<unknown>(`/api/forms/${formId}/rules`, { rules }).then((p) =>
    unwrapList<QuestionRule>(p as never)
  )
}

/** The organizer-facing link for a form. Public route, no token. */
export function publicFormPath(slug: string): string {
  return `/submit/${slug}`
}

export function publicFormUrl(slug: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}${publicFormPath(slug)}`
}

// --- taxonomy -------------------------------------------------------------

export type TaxonomyKind = 'tracks' | 'rooms' | 'formats' | 'levels' | 'tags'

export interface TaxonomyRow {
  id: string
  name: string
  color?: string | null
  capacity?: number | null
  default_duration_min?: number | null
  order?: number | null
}

export interface TaxonomyInput {
  name: string
  color?: string | null
  capacity?: number | null
  default_duration_min?: number | null
  order?: number | null
}

/** POST returns the row under its singular key ({track: …}). */
const TAXONOMY_SINGULAR: Record<TaxonomyKind, string> = {
  tracks: 'track',
  rooms: 'room',
  formats: 'format',
  levels: 'level',
  tags: 'tag',
}

export function listTaxonomy(eventId: string, kind: TaxonomyKind): Promise<TaxonomyRow[]> {
  return apiGet<unknown>(`/api/events/${eventId}/${kind}`).then((p) => unwrapList<TaxonomyRow>(p as never))
}

export function createTaxonomy(
  eventId: string,
  kind: TaxonomyKind,
  input: TaxonomyInput
): Promise<TaxonomyRow> {
  return apiPost<Record<string, TaxonomyRow>>(`/api/events/${eventId}/${kind}`, input).then(
    (r) => r[TAXONOMY_SINGULAR[kind]] ?? (r as unknown as TaxonomyRow)
  )
}

export function updateTaxonomy(
  kind: TaxonomyKind,
  id: string,
  patch: Partial<TaxonomyInput>
): Promise<TaxonomyRow> {
  return apiPatch<Record<string, TaxonomyRow>>(`/api/${kind}/${id}`, patch).then(
    (r) => r[TAXONOMY_SINGULAR[kind]] ?? (r as unknown as TaxonomyRow)
  )
}

/** 409 means the row is referenced by a session — surfaced as a toast, not a crash. */
export function deleteTaxonomy(kind: TaxonomyKind, id: string): Promise<void> {
  return apiDelete<void>(`/api/${kind}/${id}`)
}

// --- events ---------------------------------------------------------------

export interface CreateEventInput {
  name: string
  timezone?: string | null
  starts_at?: string | null
  ends_at?: string | null
  location?: string | null
}

/**
 * `slug` is patch-only: at creation the server derives and de-collides it, but
 * an existing event's public URL is the organizer's to choose. A collision comes
 * back as a 409 rather than a silent suffix.
 */
export type EventPatch = Partial<CreateEventInput> & { slug?: string | null }

export function createEvent(input: CreateEventInput): Promise<EventRow> {
  return apiPost<{ event: EventRow }>('/api/events', input).then((r) => r.event)
}

export function updateEvent(eventId: string, patch: EventPatch): Promise<EventRow> {
  return apiPatch<{ event: EventRow }>(`/api/events/${eventId}`, patch).then(
    (r) => r.event ?? (r as unknown as EventRow)
  )
}

/** Mirrors EventSummary in lib/api.ts; re-declared so admin code has one import. */
export interface EventRow {
  id: string
  name: string
  slug: string
  starts_at?: string | null
  ends_at?: string | null
  timezone?: string | null
  location?: string | null
}

export function listEvents(): Promise<EventRow[]> {
  return apiGet<unknown>('/api/events').then((p) => unwrapList<EventRow>(p as never))
}

// --- API tokens (keys for the public /v1 API) ------------------------------
// The organizer-side management surface for public API keys. The raw key is
// returned exactly once by createApiToken; every other call is metadata only.

export interface ApiTokenRow {
  id: string
  name: string
  scopes?: string[]
  created_at?: string | null
  last_used_at?: string | null
}

export function listApiTokens(): Promise<ApiTokenRow[]> {
  return apiGet<unknown>('/api/api-tokens').then((p) => unwrapList<ApiTokenRow>(p as never))
}

export function createApiToken(name: string): Promise<{ token: string; name: string }> {
  return apiPost<{ token: string; name: string }>('/api/api-tokens', { name })
}

export function deleteApiToken(id: string): Promise<void> {
  return apiDelete<void>(`/api/api-tokens/${id}`)
}
