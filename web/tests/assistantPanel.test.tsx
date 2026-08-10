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

describe('Ask SpeakerWeave panel', () => {
  let assistantStatus: number
  let assistantBody: unknown
  let postedMessages: unknown[]

  beforeEach(() => {
    assistantStatus = 200
    assistantBody = {
      reply: '**Four** submissions are pending.\n\n- Two need reviews',
      tool_calls: [{ name: 'list_submissions', summary: 'status="pending"' }],
    }
    postedMessages = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/api/events')) {
          return jsonResponse({ events: [CURRENT_EVENT] })
        }
        if (url.endsWith('/api/assistant/chat') && init?.method === 'POST') {
          postedMessages.push(JSON.parse(String(init.body)).messages)
          return jsonResponse(assistantBody, assistantStatus)
        }
        return jsonResponse({}, 404)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('opens, sends with Enter, and renders Markdown plus the tool caption', async () => {
    renderShell()

    fireEvent.click(await screen.findByTestId('ask-assistant'))
    expect(screen.getByRole('dialog', { name: 'Ask SpeakerWeave' })).toBeInTheDocument()
    expect(screen.getByText("What's the state of submissions?")).toBeInTheDocument()
    expect(screen.getByText("Who hasn't finished onboarding?")).toBeInTheDocument()
    expect(screen.getByText('Any schedule conflicts?')).toBeInTheDocument()

    const input = screen.getByTestId('assistant-input')
    fireEvent.change(input, { target: { value: 'How many submissions are pending?' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    expect((await screen.findByText('Four')).tagName).toBe('STRONG')
    expect(screen.getByText('Two need reviews')).toBeInTheDocument()
    expect(screen.getByText('Used tools: list_submissions')).toBeInTheDocument()
    expect(screen.getAllByTestId('assistant-message')).toHaveLength(2)
    expect(postedMessages).toEqual([
      [{ role: 'user', content: 'How many submissions are pending?' }],
    ])
  })

  it('shows a clear inline error when the assistant request fails', async () => {
    assistantStatus = 500
    assistantBody = { detail: 'Assistant service is unavailable.' }
    renderShell()

    fireEvent.click(await screen.findByTestId('ask-assistant'))
    fireEvent.change(screen.getByTestId('assistant-input'), {
      target: { value: 'Check the schedule' },
    })
    fireEvent.click(screen.getByTestId('assistant-send'))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Assistant service is unavailable.'),
    )
  })
})
