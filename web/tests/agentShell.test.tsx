import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from '@/shell/AppShell'

const CURRENT_EVENT = {
  id: 'event-current',
  name: 'Builder Summit',
  slug: 'builder-summit',
  starts_at: '2026-09-01T00:00:00Z',
  ends_at: '2026-09-02T00:00:00Z',
  timezone: 'UTC',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/dashboard" element={<p>Dashboard content</p>} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('agent capability gate', () => {
  beforeEach(() => {
    window.localStorage.setItem('dais.token', 'test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it.each([
    ['disabled capability', 200, { assistant: false, provider: null, mcp: { available: true, connectors_connected: 0 } }],
    ['missing capability route', 404, { detail: 'Not found' }],
  ])('renders no chat affordance for a %s', async (_label, capabilityStatus, capabilityBody) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [CURRENT_EVENT] })
        if (url.endsWith('/api/agent/capabilities')) return jsonResponse(capabilityBody, capabilityStatus)
        return jsonResponse({}, 404)
      }),
    )
    renderShell()

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('ask-agent')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Ask SpeakerWeave')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(screen.queryByTestId('ask-agent')).not.toBeInTheDocument()
  })

  it('mounts the rail only after the enabled capability arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [CURRENT_EVENT] })
        if (url.endsWith('/api/agent/capabilities')) {
          return jsonResponse({
            assistant: true,
            provider: 'openai',
            mcp: { available: true, connectors_connected: 2 },
          })
        }
        if (url.endsWith('/api/agent/integrations/mcp')) {
          return jsonResponse({
            connectors: [
              { key: 'crm', name: 'Sales CRM', url: 'https://crm.example.com/mcp', auth_kind: 'none', preset: false, connected: true, status: 'connected' },
              { key: 'ops', name: 'Ops tools', url: 'https://ops.example.com/mcp', auth_kind: 'oauth', preset: false, connected: false, status: 'error', last_error: 'Offline' },
            ],
          })
        }
        if (url.endsWith('/api/agent/threads')) return jsonResponse({ threads: [] })
        return jsonResponse({}, 404)
      }),
    )
    renderShell()

    fireEvent.click(await screen.findByTestId('ask-agent'))
    expect(await screen.findByRole('complementary', { name: 'Ask SpeakerWeave' })).toBeVisible()
    expect(screen.getByText('Ask about your program')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByLabelText('MCP connectors, 2 connected'), { key: 'Enter' })
    expect(await screen.findByText('Sales CRM')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText('Manage in Settings')).toBeInTheDocument()
    expect(window.localStorage.getItem('sw.chat.open')).toBe('true')
  })

  it('opens with Command-K and still accepts Control-J', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [CURRENT_EVENT] })
        if (url.endsWith('/api/agent/capabilities')) {
          return jsonResponse({
            assistant: true,
            provider: 'openai',
            mcp: { available: true, connectors_connected: 0 },
          })
        }
        if (url.endsWith('/api/agent/integrations/mcp')) return jsonResponse({ connectors: [] })
        if (url.endsWith('/api/agent/threads')) return jsonResponse({ threads: [] })
        return jsonResponse({}, 404)
      }),
    )
    renderShell()
    await screen.findByTestId('ask-agent')

    const openEvent = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    fireEvent(window, openEvent)
    expect(openEvent.defaultPrevented).toBe(true)
    expect(await screen.findByRole('complementary', { name: 'Ask SpeakerWeave' })).toBeVisible()

    const closeEvent = new KeyboardEvent('keydown', {
      key: 'j',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    fireEvent(window, closeEvent)
    expect(closeEvent.defaultPrevented).toBe(true)
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Ask SpeakerWeave' })).not.toBeInTheDocument()
    )
  })
})
