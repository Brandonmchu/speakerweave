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
    ['disabled capability', 200, { assistant: false, provider: null, every_mcp: { available: false, connected: false } }],
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
            every_mcp: { available: false, connected: false },
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
    expect(window.localStorage.getItem('sw.chat.open')).toBe('true')
  })
})
