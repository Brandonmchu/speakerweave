/**
 * Wire layer for the org-level speaker CRM (`/api/crm/*`).
 *
 * Split out of api.ts for the same reason adminApi and dashboardApi were: one
 * area, one contract, one file to read when the payload changes. Everything
 * here is org-scoped — no endpoint takes an event id in its path, because the
 * whole point of the directory is that it sits above events.
 *
 * Every reader normalizes: the backend is free to grow a field, and a missing
 * array must render as an empty section rather than crashing the page.
 */

import { apiGet, apiPatch, apiPost, request } from '@/lib/api'

/** The sourcing lifecycle, left to right on the board. Mirrors services/crm.py. */
export const PIPELINE_STAGES = [
  'researching',
  'identified',
  'contacted',
  'interested',
  'confirmed',
  'declined',
] as const

export type PipelineStage = (typeof PIPELINE_STAGES)[number]

export const STAGE_LABELS: Record<string, string> = {
  researching: 'Researching',
  identified: 'Identified',
  contacted: 'Contacted',
  interested: 'Interested',
  confirmed: 'Confirmed',
  declined: 'Declined',
}

/** Tags the composer resolves per recipient. Mirrors crm.MERGE_TAGS. */
export const MERGE_TAGS = ['first_name', 'last_name', 'full_name', 'email', 'company', 'title', 'event_name']

export interface DirectoryEventRef {
  id: string
  name: string
}

/** One row of the directory: the person, plus where they have shown up. */
export interface DirectoryPerson {
  id: string
  name: string
  first_name: string
  last_name: string
  email: string
  alt_emails: string[]
  company_name: string | null
  title: string | null
  about: string | null
  photo_url: string | null
  tags: string[]
  custom: Record<string, string>
  pipeline_stage: PipelineStage
  in_pipeline: boolean
  score: number | null
  rationale: string | null
  events: DirectoryEventRef[]
  event_ids: string[]
  event_count: number
  contact_ids: string[]
  /** True when another record shares this person's name or email local part. */
  is_duplicate: boolean
  last_moved_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface DirectoryFilters {
  q?: string
  company?: string
  title?: string
  tag?: string
  stage?: string
  event_id?: string
}

export interface CustomFieldDef {
  id: string
  key: string
  label: string
  field_type: 'text' | 'dropdown' | 'number' | 'date'
  options: string[]
}

export interface Segment {
  id: string
  name: string
  kind: 'dynamic' | 'curated'
  filter: DirectoryFilters
  member_ids: string[]
  member_count?: number
  created_at?: string | null
}

export interface DirectoryFacets {
  companies: string[]
  titles: string[]
  tags: string[]
  stages: { value: string; label: string }[]
  events: DirectoryEventRef[]
}

export interface DirectoryPayload {
  people: DirectoryPerson[]
  total: number
  total_all: number
  filters: DirectoryFilters
  segment_id: string | null
  segments: Segment[]
  duplicate_count: number
  facets: DirectoryFacets
  custom_fields: CustomFieldDef[]
}

const EMPTY_FACETS: DirectoryFacets = {
  companies: [],
  titles: [],
  tags: [],
  stages: [],
  events: [],
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** GET /api/crm/directory — the whole roster, or one filtered slice of it. */
export async function listDirectory(
  filters: DirectoryFilters & { segment_id?: string } = {}
): Promise<DirectoryPayload> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, String(value))
  }
  const query = params.toString()
  const wire = await apiGet<Partial<DirectoryPayload>>(`/api/crm/directory${query ? `?${query}` : ''}`)
  return {
    people: list<DirectoryPerson>(wire.people),
    total: wire.total ?? 0,
    total_all: wire.total_all ?? 0,
    filters: wire.filters ?? {},
    segment_id: wire.segment_id ?? null,
    segments: list<Segment>(wire.segments),
    duplicate_count: wire.duplicate_count ?? 0,
    facets: { ...EMPTY_FACETS, ...(wire.facets ?? {}) },
    custom_fields: list<CustomFieldDef>(wire.custom_fields),
  }
}

export interface CrmOverview {
  totals: {
    contacts: number
    events: number
    returning_speakers: number
    in_pipeline: number
    confirmed: number
    tagged: number
  }
  top_companies: { name: string; count: number }[]
  top_titles: { name: string; count: number }[]
  top_tags: { name: string; count: number }[]
  by_stage: { stage: string; label: string; count: number }[]
  by_event: { id: string; name: string; count: number }[]
}

const EMPTY_TOTALS = {
  contacts: 0,
  events: 0,
  returning_speakers: 0,
  in_pipeline: 0,
  confirmed: 0,
  tagged: 0,
}

/** GET /api/crm/overview — org-wide KPIs and the analytics widgets. */
export async function getOverview(): Promise<CrmOverview> {
  const wire = await apiGet<Partial<CrmOverview>>('/api/crm/overview')
  return {
    totals: { ...EMPTY_TOTALS, ...(wire.totals ?? {}) },
    top_companies: list(wire.top_companies),
    top_titles: list(wire.top_titles),
    top_tags: list(wire.top_tags),
    by_stage: list(wire.by_stage),
    by_event: list(wire.by_event),
  }
}

export interface PersonNote {
  id: string
  body: string
  author: string
  created_at: string | null
}

export interface StageTransition {
  id: string
  from_stage: string | null
  from_label: string
  to_stage: string
  to_label: string
  actor: string
  created_at: string | null
}

export interface Appearance {
  event_id: string
  event_name: string
  event_slug: string | null
  starts_at: string | null
  contact_id: string
  submissions: { id: string; title: string | null; status: string; friendly_id?: string | null }[]
  sessions: {
    id: string
    title: string | null
    status: string
    friendly_id?: string | null
    starts_at: string | null
    role: string | null
  }[]
  tasks_total: number
  tasks_done: number
}

export interface Communication {
  id: string
  template_key: string | null
  subject: string | null
  status: string | null
  sent_at: string | null
  created_at: string | null
  event_name: string
}

export interface PersonDetail {
  person: DirectoryPerson
  appearances: Appearance[]
  notes: PersonNote[]
  stage_history: StageTransition[]
  communications: Communication[]
  duplicates: { id: string; name: string; email: string; company_name: string | null; title: string | null }[]
  custom_fields: CustomFieldDef[]
  tag_library: string[]
  events: DirectoryEventRef[]
}

/** GET /api/crm/people/{id} — identity + every event they appear in. */
export async function getPerson(personId: string): Promise<PersonDetail> {
  const wire = await apiGet<Partial<PersonDetail>>(`/api/crm/people/${encodeURIComponent(personId)}`)
  return {
    person: wire.person as DirectoryPerson,
    appearances: list(wire.appearances),
    notes: list(wire.notes),
    stage_history: list(wire.stage_history),
    communications: list(wire.communications),
    duplicates: list(wire.duplicates),
    custom_fields: list(wire.custom_fields),
    tag_library: list(wire.tag_library),
    events: list(wire.events),
  }
}

export interface PersonInput {
  email?: string
  first_name?: string
  last_name?: string
  company_name?: string | null
  title?: string | null
  about?: string | null
  linkedin_url?: string | null
  twitter_url?: string | null
  phone?: string | null
  tags?: string[]
  custom?: Record<string, string | null>
}

/** POST /api/crm/directory — add a contact by hand. */
export async function createPerson(input: PersonInput): Promise<DirectoryPerson> {
  const wire = await apiPost<{ person: DirectoryPerson }>('/api/crm/directory', input)
  return wire.person
}

/** PATCH /api/crm/people/{id} — identity fields, tags, or custom values. */
export async function updatePerson(personId: string, input: PersonInput): Promise<DirectoryPerson> {
  const wire = await apiPatch<{ person: DirectoryPerson }>(
    `/api/crm/people/${encodeURIComponent(personId)}`,
    input
  )
  return wire.person
}

/** POST /api/crm/people/{id}/notes — an internal note the speaker never sees. */
export async function addNote(personId: string, body: string, author = 'Organizer'): Promise<PersonNote> {
  const wire = await apiPost<{ note: PersonNote }>(
    `/api/crm/people/${encodeURIComponent(personId)}/notes`,
    { body, author }
  )
  return wire.note
}

export interface StageMoveInput {
  stage: string
  score?: number | null
  rationale?: string | null
}

/** POST /api/crm/people/{id}/stage — enrol or move, writing a history row. */
export async function moveStage(personId: string, input: StageMoveInput) {
  return apiPost<{ person: DirectoryPerson; stage_history: unknown[] }>(
    `/api/crm/people/${encodeURIComponent(personId)}/stage`,
    input
  )
}

export interface AddToEventResult {
  created: boolean
  event: { id: string; name: string; slug?: string | null }
  contact: {
    id: string
    email: string
    first_name: string
    last_name: string
    company_name: string | null
    title: string | null
    about: string | null
  }
}

/** POST /api/crm/people/{id}/add-to-event — push into an event, no re-keying. */
export function addToEvent(personId: string, eventId: string): Promise<AddToEventResult> {
  return apiPost<AddToEventResult>(`/api/crm/people/${encodeURIComponent(personId)}/add-to-event`, {
    event_id: eventId,
  })
}

export interface DuplicateGroup {
  reason: string
  members: DirectoryPerson[]
}

/** GET /api/crm/duplicates — records that look like the same human. */
export async function listDuplicates(): Promise<DuplicateGroup[]> {
  const wire = await apiGet<{ groups?: DuplicateGroup[] }>('/api/crm/duplicates')
  return list<DuplicateGroup>(wire.groups)
}

/** POST /api/crm/merge — fold one record into another. Cannot be undone. */
export async function mergePeople(
  primaryId: string,
  duplicateId: string,
  fields?: Record<string, string>
): Promise<{ person: DirectoryPerson; total_all: number }> {
  return apiPost('/api/crm/merge', {
    primary_id: primaryId,
    duplicate_id: duplicateId,
    fields: fields ?? null,
  })
}

/** GET /api/crm/segments — saved segments with a live member count. */
export async function listSegments(): Promise<Segment[]> {
  const wire = await apiGet<{ segments?: Segment[] }>('/api/crm/segments')
  return list<Segment>(wire.segments)
}

export async function createSegment(input: {
  name: string
  kind: 'dynamic' | 'curated'
  filter?: DirectoryFilters
  member_ids?: string[]
}): Promise<Segment> {
  const wire = await apiPost<{ segment: Segment }>('/api/crm/segments', input)
  return wire.segment
}

export function deleteSegment(segmentId: string): Promise<void> {
  return request<void>(`/api/crm/segments/${encodeURIComponent(segmentId)}`, { method: 'DELETE' })
}

/** POST /api/crm/fields — define a field that appears on every contact. */
export async function createCustomField(input: {
  label: string
  field_type: 'text' | 'dropdown' | 'number' | 'date'
  options?: string[]
}): Promise<CustomFieldDef> {
  const wire = await apiPost<{ field: CustomFieldDef }>('/api/crm/fields', input)
  return wire.field
}

export function deleteCustomField(fieldId: string): Promise<void> {
  return request<void>(`/api/crm/fields/${encodeURIComponent(fieldId)}`, { method: 'DELETE' })
}

export interface ImportRowError {
  line?: number | null
  email?: string
  message: string
}

export interface ImportResult {
  dry_run: boolean
  columns?: string[]
  ignored_columns?: string[]
  preview?: { email: string; first_name?: string; last_name?: string; company?: string; title?: string }[]
  ready?: number
  created?: number
  updated?: number
  skipped: number
  added_to_event?: number
  errors: ImportRowError[]
  total: number
  event?: { id: string; name: string } | null
}

/**
 * POST /api/crm/import — bulk-add from CSV.
 *
 * `dry_run` returns the parsed rows and their problems without writing: the
 * validation step an organizer gets to look at before committing a file.
 */
export async function importDirectory(input: {
  csv: string
  event_id?: string | null
  dry_run?: boolean
}): Promise<ImportResult> {
  const wire = await apiPost<Partial<ImportResult>>('/api/crm/import', input)
  return {
    dry_run: Boolean(wire.dry_run),
    columns: list<string>(wire.columns),
    ignored_columns: list<string>(wire.ignored_columns),
    preview: list(wire.preview),
    ready: wire.ready ?? 0,
    created: wire.created ?? 0,
    updated: wire.updated ?? 0,
    skipped: wire.skipped ?? 0,
    added_to_event: wire.added_to_event ?? 0,
    errors: list<ImportRowError>(wire.errors),
    total: wire.total ?? 0,
    event: wire.event ?? null,
  }
}

export interface OutreachResult {
  sent: number
  failed: number
  skipped: number
  total: number
  event: { id: string; name: string }
  recipients: { person_id: string; name: string; email: string; subject: string; status: string }[]
}

/** POST /api/crm/outreach — one personalized email per selected contact. */
export async function sendOutreach(input: {
  person_ids: string[]
  subject: string
  body_html: string
  event_id?: string | null
}): Promise<OutreachResult> {
  const wire = await apiPost<Partial<OutreachResult>>('/api/crm/outreach', input)
  return {
    sent: wire.sent ?? 0,
    failed: wire.failed ?? 0,
    skipped: wire.skipped ?? 0,
    total: wire.total ?? 0,
    event: wire.event ?? { id: '', name: '' },
    recipients: list(wire.recipients),
  }
}

export interface OutreachLogEntry {
  id: string
  to: string | null
  subject: string | null
  status: string | null
  sent_at: string | null
  created_at: string | null
  error: string | null
}

/** GET /api/crm/outreach/log — every CRM send, newest first. */
export async function getOutreachLog(): Promise<OutreachLogEntry[]> {
  const wire = await apiGet<{ entries?: OutreachLogEntry[] }>('/api/crm/outreach/log')
  return list<OutreachLogEntry>(wire.entries)
}

export interface PipelineColumn {
  stage: PipelineStage
  label: string
  terminal: boolean
  cards: DirectoryPerson[]
  count: number
}

export interface PipelineBoard {
  columns: PipelineColumn[]
  total: number
  candidates: DirectoryPerson[]
  stages: { value: string; label: string }[]
}

/** GET /api/crm/pipeline — the kanban board, enrolled prospects only. */
export async function getPipeline(): Promise<PipelineBoard> {
  const wire = await apiGet<Partial<PipelineBoard>>('/api/crm/pipeline')
  return {
    columns: list<PipelineColumn>(wire.columns),
    total: wire.total ?? 0,
    candidates: list<DirectoryPerson>(wire.candidates),
    stages: list(wire.stages),
  }
}

/**
 * Resolve merge tags client-side for the composer preview.
 *
 * Deliberately mirrors `crm.render_merge_tags` rather than round-tripping to
 * the server: a preview that needs a network call is a preview nobody looks at.
 * An unknown tag is left visible, so a typo reads as wrong instead of vanishing.
 */
export function renderMergeTags(text: string, person: DirectoryPerson, eventName = ''): string {
  const context: Record<string, string> = {
    first_name: person.first_name || '',
    last_name: person.last_name || '',
    full_name: person.name || '',
    email: person.email || '',
    company: person.company_name || '',
    title: person.title || '',
    event_name: eventName,
  }
  return (text || '').replace(/{{\s*(\w+)\s*}}/g, (match, key: string) =>
    key in context ? context[key] : match
  )
}
