import { apiGet, apiPost, request } from '@/lib/api'

export interface AirtableConfig {
  enabled: boolean
  base_id: string | null
  has_token: boolean
  token_hint: string | null
  configured: boolean
  last_synced_at: string | null
  source: 'database' | 'environment' | null
}

export interface AirtableConfigInput {
  token?: string
  base_id: string
  enabled: boolean
}

export interface AirtableTableResult {
  created: number
  updated: number
}

export interface AirtableSyncResult {
  tables: {
    Speakers: AirtableTableResult
    Submissions: AirtableTableResult
  }
  last_synced_at: string
}

export interface SlackStatus {
  configured: boolean
  signing_secret_configured: boolean
  bot_token_configured: boolean
  anthropic_configured: boolean
  provider?: 'openai' | 'anthropic' | null
  agent_backed?: boolean
  model_key_configured?: boolean
  default_org: string
  source: 'environment'
}

export type MCPAuthKind = 'oauth' | 'bearer' | 'none'

export interface MCPConnector {
  key: string
  name: string
  url: string
  auth_kind: MCPAuthKind
  preset: boolean
  description?: string
  connected: boolean
  status: string
  connected_at?: string
  last_error?: string
}

export interface MCPConnectorInput {
  name: string
  url: string
  auth_kind: MCPAuthKind
  bearer_token?: string
}

export const getAirtableConfig = () =>
  apiGet<AirtableConfig>('/api/integrations/airtable')

export const saveAirtableConfig = (input: AirtableConfigInput) =>
  request<AirtableConfig>('/api/integrations/airtable', {
    method: 'PUT',
    body: input,
  })

export const syncAirtable = () =>
  apiPost<AirtableSyncResult>('/api/integrations/airtable/sync')

export const getSlackStatus = () =>
  apiGet<SlackStatus>('/api/integrations/slack/status')

export const listMCPConnectors = () =>
  apiGet<{ connectors: MCPConnector[] }>('/api/agent/integrations/mcp').then(
    (response) => response.connectors,
  )

export const createMCPConnector = (input: MCPConnectorInput) =>
  apiPost<MCPConnector | { authorize_url: string }>('/api/agent/integrations/mcp', input)

export const connectMCPConnector = (key: string) =>
  apiPost<{ authorize_url: string }>(`/api/agent/integrations/mcp/${key}/connect`, {})

export const deleteMCPConnector = (key: string) =>
  request<{ ok: boolean }>(`/api/agent/integrations/mcp/${key}`, { method: 'DELETE' })

export const SLACK_MANIFEST = JSON.stringify(
  {
    display_information: {
      name: 'SpeakerWeave',
      description: 'Conference submissions, speakers, schedule, content, and decisions in Slack',
    },
    features: {
      bot_user: {
        display_name: 'SpeakerWeave',
        always_online: true,
      },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      assistant_view: {
        assistant_description:
          'The SpeakerWeave program-operations agent: submissions, speakers, agenda, content, and decisions — with approvals right here in Slack.',
        suggested_prompts: [
          { title: 'Pending review', message: "What's still pending review?" },
          {
            title: 'Speaker status',
            message: 'Which speakers still owe content deliverables?',
          },
          {
            title: "Today's agenda",
            message:
              "Summarize the current agenda: what's scheduled and what still needs a slot?",
          },
        ],
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read',
          'assistant:write',
          'chat:write',
          'im:history',
          'im:read',
          'im:write',
          'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: 'https://speakerweave.com/api/slack/events',
        bot_events: ['app_mention', 'assistant_thread_started', 'message.im'],
      },
      interactivity: {
        is_enabled: true,
        request_url: 'https://speakerweave.com/api/slack/events',
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  },
  null,
  2
)
