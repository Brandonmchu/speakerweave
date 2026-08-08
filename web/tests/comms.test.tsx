import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Comms } from '@/pages/Comms'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }
const TEMPLATE = {
  id: 'template-1',
  org_id: 'org-1',
  event_id: 'event-1',
  key: 'accept',
  subject: "You're speaking at {{event_name}}",
  body_html: '<p>Hi {{first_name}}, your session is {{session_title}}.</p>',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderComms() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <Comms />
    </QueryClientProvider>
  )
}

describe('Communications center', () => {
  beforeEach(() => {
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.endsWith('/email-templates')) return jsonResponse({ templates: [TEMPLATE] })
        if (url.includes('/recipients-preview')) {
          return jsonResponse({ count: 1, sample: ['Ada Lovelace'] })
        }
        if (url.includes('/comms/log')) return jsonResponse({ log: [] })
        return jsonResponse({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('renders the event templates and live compose audience count', async () => {
    renderComms()

    expect(screen.getByRole('heading', { name: 'Communications' })).toBeInTheDocument()
    expect(await screen.findByText("You're speaking at {{event_name}}")).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Compose message' }))
    expect(await screen.findByText('This will send to 1 speakers')).toBeInTheDocument()
    expect(screen.getByText('{{session_title}}')).toBeInTheDocument()
  })
})
