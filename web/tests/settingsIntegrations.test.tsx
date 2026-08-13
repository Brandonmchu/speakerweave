import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPage } from '@/pages/SettingsPage'

const EVENT = {
  id: 'evt-1',
  name: 'AI Builders Summit',
  slug: 'ai-builders-summit',
  timezone: 'America/Toronto',
}

const CONFIG = {
  enabled: true,
  base_id: 'app-speakerweave',
  has_token: true,
  token_hint: '••••9xyz',
  configured: true,
  last_synced_at: '2026-08-10T14:00:00Z',
  source: 'database',
}

let syncError: string | null = null
let agentEnabled = false
let mcpCreateError: string | null = null
let mcpConnectors: Array<Record<string, unknown>> = []
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const method = init.method ?? 'GET'
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/api/agent/capabilities')) {
        return json({
          assistant: agentEnabled,
          provider: agentEnabled ? 'openai' : null,
          mcp: { available: true, connectors_connected: mcpConnectors.filter((item) => item.connected).length },
        })
      }
      if (url.endsWith('/api/agent/integrations/mcp') && method === 'POST') {
        if (mcpCreateError) return json({ detail: mcpCreateError }, 422)
        return json({ ...body, key: 'custom-server', preset: false, connected: true, status: 'connected' })
      }
      if (url.endsWith('/api/agent/integrations/mcp')) return json({ connectors: mcpConnectors })
      if (url.includes('/api/agent/integrations/mcp/') && method === 'DELETE') return json({ ok: true })
      if (url.endsWith('/api/integrations/airtable/sync')) {
        if (syncError) return json({ detail: syncError }, 400)
        return json({
          tables: {
            Speakers: { created: 4, updated: 7 },
            Submissions: { created: 2, updated: 18 },
          },
          last_synced_at: '2026-08-10T15:30:00Z',
        })
      }
      if (url.endsWith('/api/integrations/airtable') && method === 'PUT') {
        return json({ ...CONFIG, ...body, token: undefined })
      }
      if (url.endsWith('/api/integrations/airtable')) return json(CONFIG)
      if (url.endsWith('/api/integrations/slack/status')) {
        return json({
          configured: true,
          signing_secret_configured: true,
          bot_token_configured: true,
          anthropic_configured: false,
          provider: 'openai',
          agent_backed: true,
          model_key_configured: false,
          default_org: 'org_dev',
          source: 'environment',
        })
      }
      if (url.includes('/api/api-tokens')) return json({ api_tokens: [] })
      if (url.includes('/api/events') && !url.includes('/api/events/')) return json({ events: [EVENT] })
      return json({ items: [] })
    })
  )
}

function renderSettings(path = '/settings/integrations') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/settings/:section?" element={<SettingsPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  calls = []
  syncError = null
  agentEnabled = false
  mcpCreateError = null
  mcpConnectors = []
  window.localStorage.setItem('dais.token', 'test-token')
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('Settings integrations', () => {
  it('keeps the Airtable token write-only and saves a replacement', async () => {
    renderSettings()
    const token = (await screen.findByLabelText('Personal access token')) as HTMLInputElement
    expect(token.value).toBe('')
    await waitFor(() => expect(token.placeholder).toContain('••••9xyz'))

    fireEvent.change(token, { target: { value: 'pat-new-private-token' } })
    fireEvent.change(screen.getByLabelText('Base ID'), { target: { value: 'app-new-base' } })
    fireEvent.click(screen.getByTestId('save-airtable'))

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT')
      expect(save?.body).toEqual({
        token: 'pat-new-private-token',
        base_id: 'app-new-base',
        enabled: true,
      })
    })
    await waitFor(() => expect((screen.getByLabelText('Personal access token') as HTMLInputElement).value).toBe(''))
  })

  it('syncs now and shows counts for both tables plus the new time', async () => {
    renderSettings()
    await screen.findByText('Airtable sync')
    await waitFor(() => expect(screen.getByTestId('sync-airtable')).toBeEnabled())
    fireEvent.click(screen.getByTestId('sync-airtable'))

    const result = await screen.findByTestId('airtable-sync-result')
    expect(result).toHaveTextContent('4 created · 7 updated')
    expect(result).toHaveTextContent('2 created · 18 updated')
    await waitFor(() => expect(screen.getByTestId('airtable-last-synced')).not.toHaveTextContent('Never synced'))
  })

  it('shows an incomplete-schema error verbatim', async () => {
    syncError =
      'Airtable setup is incomplete. Create these exact tables and fields:\n- Speakers: Name, Email, Company, Title, Status, Sessions count\n- Submissions: Friendly ID, Title, Submitter, Track, Status, Review score'
    renderSettings()
    await waitFor(() => expect(screen.getByTestId('sync-airtable')).toBeEnabled())
    fireEvent.click(screen.getByTestId('sync-airtable'))

    expect((await screen.findByTestId('airtable-sync-error')).textContent).toBe(syncError)
  })

  it('shows Slack env status and a complete copyable manifest', async () => {
    renderSettings()
    expect(await screen.findByText('Environment configured')).toBeInTheDocument()
    expect(screen.getByText('Signing secret set')).toBeInTheDocument()
    expect(screen.getByText('Bot token set')).toBeInTheDocument()
    expect(screen.getByText('OpenAI key missing')).toBeInTheDocument()
    expect(screen.getByText('Agent bridge active')).toBeInTheDocument()
    expect(screen.getByText(/same agent as in-app Ask/i)).toBeInTheDocument()
    expect(screen.getByText(/Approve/).closest('div')).toHaveTextContent(
      'Slack conversations also appear in in-app Ask history'
    )

    const manifest = screen.getByTestId('slack-manifest').textContent ?? ''
    expect(manifest).toContain('"name": "SpeakerWeave"')
    expect(manifest).toContain('"app_mentions:read"')
    expect(manifest).toContain('"message.im"')
    expect(manifest).toContain('"users:read"')
    expect(manifest).toContain('"interactivity"')
    expect(manifest).toContain('"is_enabled": true')
    expect(manifest).toContain('https://speakerweave.com/api/slack/events')
    expect(screen.getByTestId('copy-slack-manifest')).toBeInTheDocument()
  })

  it('renders preset, connected, disconnected, and error connector states', async () => {
    agentEnabled = true
    mcpConnectors = [
      {
        key: 'every',
        name: 'Every',
        url: 'https://mcp.every.test/mcp',
        auth_kind: 'oauth',
        preset: true,
        description: 'Business tools: proposals, invoices, clients',
        connected: false,
        status: 'disconnected',
      },
      {
        key: 'crm',
        name: 'Sales CRM',
        url: 'https://crm.example.com/a/very/long/mcp/endpoint',
        auth_kind: 'bearer',
        preset: false,
        connected: true,
        status: 'connected',
      },
      {
        key: 'internal',
        name: 'Internal tools',
        url: 'https://tools.example.com/mcp',
        auth_kind: 'oauth',
        preset: false,
        connected: false,
        status: 'error',
        last_error: 'Authorization expired',
      },
    ]
    renderSettings('/settings/mcp')

    expect(await screen.findByTestId('mcp-connectors-card')).toBeInTheDocument()
    expect(await screen.findByTestId('mcp-connector-every')).toHaveTextContent('Preset')
    expect(screen.getByTestId('mcp-connector-every')).toHaveTextContent('Not connected')
    expect(screen.getByTestId('mcp-connector-crm')).toHaveTextContent('Connected')
    expect(screen.getByTestId('mcp-connector-internal')).toHaveTextContent('Error')
    expect(screen.getByTitle('Authorization expired')).toBeInTheDocument()
  })

  it('validates the add-custom dialog and shows a server 422 inline', async () => {
    agentEnabled = true
    mcpCreateError = 'MCP validation failed: tools/list rejected the credential'
    renderSettings('/settings/mcp')
    fireEvent.click(await screen.findByRole('button', { name: /add custom server/i }))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sales CRM' } })
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'http://crm.example.com/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Use HTTPS')
    expect(calls.filter((call) => call.url.endsWith('/api/agent/integrations/mcp') && call.method === 'POST')).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://crm.example.com/mcp' } })
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('tools/list rejected the credential')
  })

  it('hides MCP connector management when assistant capabilities are off', async () => {
    agentEnabled = false
    renderSettings()
    expect(await screen.findByText('Airtable sync')).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/agent/capabilities'), expect.anything()))
    expect(screen.queryByRole('link', { name: 'MCP connectors' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('mcp-connectors-card')).not.toBeInTheDocument()
    expect(calls.some((call) => call.url.endsWith('/api/agent/integrations/mcp'))).toBe(false)
  })

  it('bounces /settings/mcp back to the Event tab when the assistant is off', async () => {
    agentEnabled = false
    renderSettings('/settings/mcp')
    expect(await screen.findByLabelText(/event name/i)).toBeInTheDocument()
    expect(screen.queryByTestId('mcp-connectors-card')).not.toBeInTheDocument()
    expect(calls.some((call) => call.url.endsWith('/api/agent/integrations/mcp'))).toBe(false)
  })
})
