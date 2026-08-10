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
  default_org: string
  source: 'environment'
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

export const SLACK_MANIFEST = JSON.stringify(
  {
    display_information: {
      name: 'SpeakerWeave',
      description: 'Conference submissions, speakers, schedule, content, and decisions in Slack',
    },
    features: {
      bot_user: {
        display_name: 'SpeakerWeave',
        always_online: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write'],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: 'https://speakerweave.com/api/slack/events',
        bot_events: ['app_mention', 'message.im'],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  },
  null,
  2
)
