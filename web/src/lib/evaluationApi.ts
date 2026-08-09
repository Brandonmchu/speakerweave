/** Typed wire contract for organizer evaluations and the reviewer portal. */

import { apiGet, apiPatch, apiPost, request } from '@/lib/api'

export type EvaluationScale = '1_5' | '1_10'
export type EvaluationPlanStatus = 'draft' | 'open' | 'closed'

/**
 * What a scorecard row asks for.
 *
 * `scale` is the weighted 1–N rating that criteria have always been, and an
 * absent `kind` means exactly that — every plan saved before choice/text
 * criteria existed keeps its shape and its behaviour. `select` asks for one of
 * a fixed list of options; `text` asks for a paragraph.
 */
export type EvaluationCriterionKind = 'scale' | 'select' | 'text'

export interface EvaluationCriterion {
  name: string
  /** Only scale criteria are weighted; the others carry 0 and sit outside the 100%. */
  weight: number
  /** Omitted = 'scale'. */
  kind?: EvaluationCriterionKind
  /** The choices offered when `kind` is 'select'. */
  options?: string[]
}

/** An absent kind is a scale criterion — the pre-existing numeric one. */
export function criterionKind(criterion: EvaluationCriterion): EvaluationCriterionKind {
  return criterion.kind ?? 'scale'
}

/** A number for a scale criterion, the chosen option or typed prose otherwise. */
export type ReviewScoreValue = number | string

export interface EvaluationPlan {
  id: string
  org_id?: string
  event_id: string
  name: string
  instructions: string
  anonymized: boolean
  scale: EvaluationScale
  criteria: EvaluationCriterion[]
  status: EvaluationPlanStatus
  session_filter?: Record<string, unknown>
  /** Review window. null on either side = that bound is unset. */
  opens_at?: string | null
  closes_at?: string | null
  evaluator_count?: number
  assignment_count?: number
  review_count?: number
  created_at?: string
}

export interface EvaluationPlanInput {
  name: string
  instructions?: string
  scale?: EvaluationScale
  anonymized?: boolean
  criteria?: EvaluationCriterion[]
  /** A date ("2026-10-01") or a full instant; omit for no bound. */
  opens_at?: string | null
  closes_at?: string | null
}

export interface EvaluationPlanPatch {
  name?: string
  instructions?: string
  anonymized?: boolean
  criteria?: EvaluationCriterion[]
  status?: EvaluationPlanStatus
  /** Send null to clear a bound; omit to leave it alone. */
  opens_at?: string | null
  closes_at?: string | null
}

/** A talk belongs to one or more tracks; a reviewer covers one or more. */
export interface EvaluationTrack {
  id: string
  name: string | null
  color: string | null
}

export interface Evaluator {
  id: string
  plan_id: string
  email: string
  name: string
  /** Tracks this reviewer covers. Empty = every track. */
  track_ids?: string[]
  tracks?: EvaluationTrack[]
  invited_at?: string | null
  last_active_at?: string | null
  assignment_count?: number
  review_count?: number
  complete_count?: number
}

export interface AssignedSessionSummary {
  session_id: string
  title?: string | null
  friendly_id?: string | null
  status?: string | null
  /** The primary track — still the one on sessions.track_id. */
  track_id?: string | null
  tracks?: EvaluationTrack[]
  assignment_count: number
  review_count: number
}

export interface AssignmentSummary {
  total: number
  reviewed: number
  complete: number
  by_session: AssignedSessionSummary[]
}

export interface EvaluationPlanDetail {
  plan: EvaluationPlan
  /** The event's tracks, for the reviewer coverage picker. */
  tracks?: EvaluationTrack[]
  evaluators: Evaluator[]
  assignments: AssignmentSummary
}

export interface AssignmentResult {
  created: number
  total: number
  session_count: number
  evaluator_count: number
}

export interface EvaluationSessionSummary {
  session_id: string
  title: string
  friendly_id?: string | null
  status?: string | null
  tracks?: EvaluationTrack[]
  avg_overall: number | null
  review_count: number
  completed_count: number
  abstained_count: number
  score_range: number
}

export interface EvaluationSummary {
  started: number
  in_progress: number
  complete: number
  assignment_count: number
  per_session: EvaluationSessionSummary[]
  top_sessions: EvaluationSessionSummary[]
  thought_provoking: EvaluationSessionSummary[]
}

export function listEvaluationPlans(eventId: string): Promise<EvaluationPlan[]> {
  return apiGet<{ plans: EvaluationPlan[] }>(`/api/events/${eventId}/evaluation-plans`).then(
    (response) => response.plans
  )
}

export function createEvaluationPlan(
  eventId: string,
  input: EvaluationPlanInput
): Promise<EvaluationPlan> {
  return apiPost<{ plan: EvaluationPlan }>(`/api/events/${eventId}/evaluation-plans`, input).then(
    (response) => response.plan
  )
}

export function getEvaluationPlan(planId: string): Promise<EvaluationPlanDetail> {
  return apiGet<EvaluationPlanDetail>(`/api/evaluation-plans/${planId}`)
}

export function updateEvaluationPlan(
  planId: string,
  patch: EvaluationPlanPatch
): Promise<EvaluationPlan> {
  return apiPatch<{ plan: EvaluationPlan }>(`/api/evaluation-plans/${planId}`, patch).then(
    (response) => response.plan
  )
}

export function addEvaluator(
  planId: string,
  input: { email: string; name: string; track_ids?: string[] }
): Promise<Evaluator> {
  return apiPost<{ evaluator: Evaluator }>(
    `/api/evaluation-plans/${planId}/evaluators`,
    input
  ).then((response) => response.evaluator)
}

/** Rename a reviewer, or change which tracks they review ([] = every track). */
export function updateEvaluator(
  planId: string,
  evaluatorId: string,
  patch: { name?: string; track_ids?: string[] }
): Promise<Evaluator> {
  return apiPatch<{ evaluator: Evaluator }>(
    `/api/evaluation-plans/${planId}/evaluators/${evaluatorId}`,
    patch
  ).then((response) => response.evaluator)
}

export function deleteEvaluator(planId: string, evaluatorId: string): Promise<void> {
  return request<void>(`/api/evaluation-plans/${planId}/evaluators/${evaluatorId}`, {
    method: 'DELETE',
  })
}

/** `all_to_all` pairs everyone with everything; `by_track` pairs a reviewer
 * only with the sessions whose tracks they cover. */
export type EvaluationAssignMode = 'all_to_all' | 'by_track'

export function assignEvaluationSessions(
  planId: string,
  input: {
    session_ids?: string[]
    evaluator_ids?: string[]
    mode?: EvaluationAssignMode
  } = {}
): Promise<AssignmentResult> {
  const { mode = 'all_to_all', ...selection } = input
  return apiPost<AssignmentResult>(`/api/evaluation-plans/${planId}/assign`, {
    ...selection,
    mode,
  })
}

/** ── per-submission assignment ──────────────────────────────────────────
 * Assigning by track is a bulk stroke; this is the single deliberate pairing
 * — "this reviewer reads THIS submission" — and both dedupe on the same key.
 */
export interface SubmissionReviewer {
  assignment_id: string
  evaluator_id: string
  name: string
  email: string | null
  review_status: ReviewerAssignmentStatus
}

export interface AssignableSubmission {
  session_id: string
  title: string
  friendly_id?: string | null
  status?: string | null
  tracks?: EvaluationTrack[]
  assignments: SubmissionReviewer[]
}

export interface AssignmentBoard {
  evaluators: Array<{ id: string; name: string; email: string | null; track_ids?: string[] }>
  sessions: AssignableSubmission[]
}

export function getPlanAssignments(planId: string): Promise<AssignmentBoard> {
  return apiGet<AssignmentBoard>(`/api/plans/${planId}/assignments`)
}

export interface CreatedAssignment {
  id: string
  plan_id: string
  evaluator_id: string
  session_id: string
  evaluator_name: string
  evaluator_email: string | null
  session_title: string | null
  review_status: ReviewerAssignmentStatus
}

export function assignReviewerToSubmission(
  planId: string,
  input: { evaluator_id: string; session_id: string }
): Promise<CreatedAssignment> {
  return apiPost<{ assignment: CreatedAssignment }>(
    `/api/plans/${planId}/assignments`,
    input
  ).then((response) => response.assignment)
}

export function unassignReviewerFromSubmission(
  planId: string,
  assignmentId: string
): Promise<void> {
  return request<void>(`/api/plans/${planId}/assignments/${assignmentId}`, { method: 'DELETE' })
}

export interface LaggardReminderResult {
  reminded: number
  evaluators: string[]
  skipped: number
  already_reminded: string[]
  incomplete_reviewers: number
  outstanding: number
}

/** Email only the reviewers with unfinished work. Deduped per reviewer per
 * day server-side, so a second click reminds nobody. */
export function remindLaggingReviewers(planId: string): Promise<LaggardReminderResult> {
  return apiPost<LaggardReminderResult>(`/api/plans/${planId}/remind-laggards`)
}

export function openEvaluationPlan(
  planId: string
): Promise<{ plan: EvaluationPlan; count: number }> {
  return apiPost<{ plan: EvaluationPlan; count: number }>(
    `/api/evaluation-plans/${planId}/open`
  )
}

export function getEvaluationSummary(planId: string): Promise<EvaluationSummary> {
  return apiGet<EvaluationSummary>(`/api/evaluation-plans/${planId}/summary`)
}

export interface ReviewerLink {
  evaluator_id: string
  name: string
  email: string | null
  review_url: string
}

/** GET /api/evaluation-plans/{id}/reviewer-links — a fresh review link per
 * evaluator, so an organizer can open a reviewer scorecard without email. */
export function getReviewerLinks(planId: string): Promise<ReviewerLink[]> {
  return apiGet<ReviewerLink[]>(`/api/evaluation-plans/${planId}/reviewer-links`)
}

export function updateEvaluationDecision(
  sessionId: string,
  status: 'pending' | 'accept_queue' | 'accepted' | 'decline_queue' | 'declined'
): Promise<void> {
  return apiPatch(`/api/sessions/${sessionId}`, { status }).then(() => undefined)
}

export interface ReviewerSpeaker {
  id: string
  first_name?: string | null
  last_name?: string | null
  company_name?: string | null
  title?: string | null
  about?: string | null
}

export interface ReviewerSession {
  id: string
  title: string
  description?: string | null
  friendly_id?: string | null
  form_answers?: Record<string, unknown>
  custom_fields?: Record<string, unknown>
  speaker?: ReviewerSpeaker | null
  speakers?: ReviewerSpeaker[]
}

export type ReviewerAssignmentStatus = 'pending' | 'in_progress' | 'reviewed'

export interface ReviewerAssignment {
  assignment_id: string
  session: ReviewerSession
  review_status: ReviewerAssignmentStatus
}

export interface ReviewerHome {
  evaluator: Evaluator
  plan: Pick<
    EvaluationPlan,
    'id' | 'name' | 'instructions' | 'scale' | 'criteria' | 'anonymized' | 'status'
  >
  assignments: ReviewerAssignment[]
}

export interface ReviewRecord {
  id?: string
  assignment_id: string
  scores: Record<string, ReviewScoreValue>
  overall?: number | null
  comment?: string | null
  abstained: boolean
  abstain_reason?: string | null
  is_draft: boolean
  submitted_at?: string | null
}

export interface ReviewerSubmission {
  assignment_id: string
  session: ReviewerSession
  review: ReviewRecord | null
}

export interface ReviewInput {
  scores: Record<string, ReviewScoreValue>
  comment?: string
  abstained?: boolean
  abstain_reason?: string
  is_draft: boolean
}

const REVIEWER_OPTIONS = { anonymous: true, credentials: 'include' as const }

export function getReviewerHome(): Promise<ReviewerHome> {
  return request<ReviewerHome>('/public/review/me', {
    ...REVIEWER_OPTIONS,
    method: 'GET',
  })
}

export function getReviewerSubmission(assignmentId: string): Promise<ReviewerSubmission> {
  return request<ReviewerSubmission>(`/public/review/submissions/${assignmentId}`, {
    ...REVIEWER_OPTIONS,
    method: 'GET',
  })
}

export function saveReviewerReview(
  assignmentId: string,
  input: ReviewInput
): Promise<ReviewRecord> {
  return request<{ review: ReviewRecord }>(`/public/review/submissions/${assignmentId}`, {
    ...REVIEWER_OPTIONS,
    method: 'PUT',
    body: input,
  }).then((response) => response.review)
}
