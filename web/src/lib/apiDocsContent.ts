/** Copy and structured reference data for the public Developers page. */

export const API_BASE_PATH = '/v1'
export const AUTH_HEADER = 'x-access-token'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface RestEndpoint {
  method: HttpMethod
  path: string
  description: string
}

export interface CurlExample {
  title: string
  description: string
  code: string
}

export interface McpTool {
  name: string
  description: string
}

export const AUTH_EXAMPLE = `curl https://your-dais-host${API_BASE_PATH}/events \\
  -H "${AUTH_HEADER}: dais_your_api_token"`

export const REST_ENDPOINTS: RestEndpoint[] = [
  { method: 'GET', path: '/events', description: 'List the organization’s events.' },
  { method: 'GET', path: '/events/{event_id}', description: 'Get one event.' },
  {
    method: 'GET',
    path: '/events/{event_id}/submissions',
    description: 'List submissions; filter by status or track.',
  },
  {
    method: 'POST',
    path: '/events/{event_id}/submissions/search',
    description: 'Search submissions with filters in a JSON body.',
  },
  {
    method: 'GET',
    path: '/events/{event_id}/sessions',
    description: 'Alias for submissions, compatible with Other Conference/CFP Software.',
  },
  {
    method: 'POST',
    path: '/events/{event_id}/sessions/search',
    description: 'Submission search alias, compatible with Other Conference/CFP Software.',
  },
  { method: 'GET', path: '/submissions/{submission_id}', description: 'Get one submission.' },
  {
    method: 'POST',
    path: '/events/{event_id}/submissions',
    description: 'Create a submission and its submitter contact.',
  },
  {
    method: 'PATCH',
    path: '/submissions/{submission_id}',
    description: 'Update status, title, or abstract.',
  },
  {
    method: 'GET',
    path: '/events/{event_id}/speakers',
    description: 'List speakers; filter by status or text.',
  },
  { method: 'GET', path: '/speakers/{speaker_id}', description: 'Get one speaker.' },
  {
    method: 'POST',
    path: '/events/{event_id}/speakers',
    description: 'Create a speaker, including status and logistics.',
  },
  {
    method: 'PATCH',
    path: '/speakers/{speaker_id}',
    description: 'Update profile, speaker status, or logistics.',
  },
  {
    method: 'GET',
    path: '/events/{event_id}/contacts',
    description: 'Speaker directory, compatible with Other Conference/CFP Software.',
  },
  {
    method: 'POST',
    path: '/events/{event_id}/contacts/search',
    description: 'Speaker directory search, compatible with Other Conference/CFP Software.',
  },
  {
    method: 'GET',
    path: '/events/{event_id}/schedule',
    description: 'Get the complete schedule, rooms, and tracks.',
  },
  {
    method: 'PUT',
    path: '/sessions/{submission_id}/schedule',
    description: 'Place a session in a room at a start time.',
  },
  {
    method: 'DELETE',
    path: '/sessions/{submission_id}/schedule',
    description: 'Remove a session from the schedule.',
  },
  { method: 'GET', path: '/events/{event_id}/tracks', description: 'List event tracks.' },
  { method: 'GET', path: '/events/{event_id}/formats', description: 'List event formats.' },
  { method: 'GET', path: '/events/{event_id}/rooms', description: 'List event rooms.' },
  {
    method: 'GET',
    path: '/events/{event_id}/content-items',
    description: 'List content deliverables; filter by type or status.',
  },
  {
    method: 'GET',
    path: '/events/{event_id}/content-status',
    description: 'Read deliverable counts and outstanding speakers.',
  },
  {
    method: 'GET',
    path: '/events/{event_id}/evaluation-plans',
    description: 'List evaluation plans and review progress.',
  },
  {
    method: 'GET',
    path: '/evaluation-plans/{plan_id}/summary',
    description: 'Read aggregate and per-submission scores.',
  },
]

export const CURL_EXAMPLES: CurlExample[] = [
  {
    title: 'Filter submissions',
    description: 'Status and track accept their ids or natural names where applicable.',
    code: `curl "https://your-dais-host/v1/events/{event_id}/submissions?status=pending&track=AI&page=1&pageSize=25" \\
  -H "x-access-token: dais_your_api_token"`,
  },
  {
    title: 'Create a submission',
    description: 'The submitter contact is reused by normalized email when it already exists.',
    code: `curl -X POST "https://your-dais-host/v1/events/{event_id}/submissions" \\
  -H "x-access-token: dais_your_api_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Agents that plan conferences",
    "abstract": "A practical field report.",
    "submitter_email": "speaker@example.com",
    "submitter_first_name": "Ada",
    "submitter_last_name": "Lovelace"
  }'`,
  },
  {
    title: 'Decide and edit a submission',
    description: 'Patch any combination of status, title, and abstract.',
    code: `curl -X PATCH "https://your-dais-host/v1/submissions/{submission_id}" \\
  -H "x-access-token: dais_your_api_token" \\
  -H "Content-Type: application/json" \\
  -d '{ "status": "accepted", "title": "Agents that run conferences" }'`,
  },
  {
    title: 'Place a session',
    description: 'Room may be a room id or its exact name; start is ISO-8601.',
    code: `curl -X PUT "https://your-dais-host/v1/sessions/{submission_id}/schedule" \\
  -H "x-access-token: dais_your_api_token" \\
  -H "Content-Type: application/json" \\
  -d '{ "room": "Main Hall", "start": "2026-09-14T17:00:00Z" }'`,
  },
]

export const MCP_TOOLS: McpTool[] = [
  { name: 'list_events', description: 'List events in the authenticated organization.' },
  {
    name: 'list_submissions',
    description: 'List submissions with optional event, status, and track filters.',
  },
  { name: 'get_submission', description: 'Get one submission and its related program data.' },
  {
    name: 'decide_submission',
    description: 'Accept, decline, or queue a submission with optional feedback.',
  },
  { name: 'list_speakers', description: 'List and search the speaker directory.' },
  { name: 'get_speaker', description: 'Get a speaker’s profile, status, and logistics.' },
  { name: 'invite_speaker_to_portal', description: 'Queue a speaker portal invitation.' },
  { name: 'list_schedule', description: 'Read an event’s complete schedule.' },
  { name: 'place_session', description: 'Place a session into a room and time.' },
  { name: 'unschedule_session', description: 'Remove a session from the schedule.' },
  { name: 'content_status', description: 'Read content deliverables and outstanding counts.' },
  {
    name: 'remind_outstanding_content',
    description: 'Queue deduplicated reminders for missing content.',
  },
  {
    name: 'evaluation_summary',
    description: 'List evaluation plans or read one plan’s score summary.',
  },
  { name: 'ai_triage', description: 'Run AI first-pass triage for an evaluation plan.' },
]
