import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
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

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  calls = []
  syncError = null
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
    expect(screen.getByText('Anthropic key missing')).toBeInTheDocument()

    const manifest = screen.getByTestId('slack-manifest').textContent ?? ''
    expect(manifest).toContain('"name": "SpeakerWeave"')
    expect(manifest).toContain('"app_mentions:read"')
    expect(manifest).toContain('"message.im"')
    expect(manifest).toContain('https://speakerweave.com/api/slack/events')
    expect(screen.getByTestId('copy-slack-manifest')).toBeInTheDocument()
  })
})
