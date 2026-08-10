import { apiGet, apiPatch, apiPost, request } from '@/lib/api'

export type CommsRole = 'speaker' | 'submitter' | 'chairperson' | 'moderator'
export type CommsSessionStatus =
  | 'draft'
  | 'pending'
  | 'accept_queue'
  | 'accepted'
  | 'decline_queue'
  | 'declined'
  | 'withdrawn'

export interface EmailTemplate {
  id: string
  org_id: string
  event_id: string
  key: string
  subject: string
  body_html: string
}

export interface EmailTemplateInput {
  key: string
  subject: string
  body_html: string
}

export interface CommsAudience {
  roles?: CommsRole[]
  statuses?: CommsSessionStatus[]
  all_roster?: boolean
  /** When present, this exact validated event-scoped list overrides filters. */
  contact_ids?: string[]
}

export type SendCommunicationInput =
  | { template_key: string; audience: CommsAudience }
  | { subject: string; body_html: string; audience: CommsAudience }

export interface SendCommunicationResult {
  sent: number
  failed: number
  total: number
}

export interface RecipientsPreview {
  count: number
  sample: string[]
  recipients?: CommsRecipient[]
  available_recipients?: CommsRecipient[]
}

export interface CommsRecipient {
  contact_id: string
  name: string
  email: string | null
}

export type CommsDeliveryStatus = 'queued' | 'sent' | 'failed' | 'cancelled'

export interface CommsLogEntry {
  id: string
  contact_id?: string | null
  template_key: string
  subject: string
  recipient_name: string
  recipient_email: string
  status: CommsDeliveryStatus
  sent_at?: string | null
  created_at?: string | null
  last_error?: string | null
}

function eventPath(eventId: string): string {
  return `/api/events/${encodeURIComponent(eventId)}`
}

export async function listEmailTemplates(eventId: string): Promise<EmailTemplate[]> {
  const result = await apiGet<{ templates: EmailTemplate[] }>(`${eventPath(eventId)}/email-templates`)
  return result.templates
}

export async function saveEmailTemplate(
  eventId: string,
  input: EmailTemplateInput
): Promise<EmailTemplate> {
  const result = await apiPost<{ template: EmailTemplate }>(
    `${eventPath(eventId)}/email-templates`,
    input
  )
  return result.template
}

export async function updateEmailTemplate(
  templateId: string,
  input: Partial<EmailTemplateInput>
): Promise<EmailTemplate> {
  const result = await apiPatch<{ template: EmailTemplate }>(
    `/api/email-templates/${encodeURIComponent(templateId)}`,
    input
  )
  return result.template
}

export function deleteEmailTemplate(templateId: string): Promise<void> {
  return request<void>(`/api/email-templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' })
}

export function recipientsPreview(
  eventId: string,
  audience: CommsAudience
): Promise<RecipientsPreview> {
  const params = new URLSearchParams()
  audience.roles?.forEach((role) => params.append('roles', role))
  audience.statuses?.forEach((status) => params.append('statuses', status))
  if (audience.all_roster) params.set('all_roster', 'true')
  const query = params.toString()
  return apiGet<RecipientsPreview>(
    `${eventPath(eventId)}/comms/recipients-preview${query ? `?${query}` : ''}`
  )
}

export function sendCommunication(
  eventId: string,
  input: SendCommunicationInput
): Promise<SendCommunicationResult> {
  return apiPost<SendCommunicationResult>(`${eventPath(eventId)}/comms/send`, input)
}

export async function communicationLog(eventId: string, limit = 100): Promise<CommsLogEntry[]> {
  const result = await apiGet<{ log: CommsLogEntry[] }>(
    `${eventPath(eventId)}/comms/log?limit=${limit}`
  )
  return result.log
}
