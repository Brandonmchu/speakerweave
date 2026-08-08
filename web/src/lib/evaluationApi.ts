/** Typed wire contract for organizer evaluations and the reviewer portal. */

import { apiGet, apiPatch, apiPost, request } from '@/lib/api'

export type EvaluationScale = '1_5' | '1_10'
export type EvaluationPlanStatus = 'draft' | 'open' | 'closed'

export interface EvaluationCriterion {
  name: string
  weight: number
}

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
}

export interface EvaluationPlanPatch {
  name?: string
  instructions?: string
  anonymized?: boolean
  criteria?: EvaluationCriterion[]
  status?: EvaluationPlanStatus
}

export interface Evaluator {
  id: string
  plan_id: string
  email: string
  name: string
  invited_at?: string | null
  last_active_at?: string | null
  assignment_count?: number
  review_count?: number
  complete_count?: number
}

export interface AssignmentSummary {
  total: number
  reviewed: number
  complete: number
  by_session: Array<{
    session_id: string
    assignment_count: number
    review_count: number
  }>
}

export interface EvaluationPlanDetail {
  plan: EvaluationPlan
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
  input: { email: string; name: string }
): Promise<Evaluator> {
  return apiPost<{ evaluator: Evaluator }>(
    `/api/evaluation-plans/${planId}/evaluators`,
    input
  ).then((response) => response.evaluator)
}

export function deleteEvaluator(planId: string, evaluatorId: string): Promise<void> {
  return request<void>(`/api/evaluation-plans/${planId}/evaluators/${evaluatorId}`, {
    method: 'DELETE',
  })
}

export function assignEvaluationSessions(
  planId: string,
  input: { session_ids?: string[]; evaluator_ids?: string[] } = {}
): Promise<AssignmentResult> {
  return apiPost<AssignmentResult>(`/api/evaluation-plans/${planId}/assign`, {
    ...input,
    mode: 'all_to_all',
  })
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
  scores: Record<string, number>
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
  scores: Record<string, number>
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
