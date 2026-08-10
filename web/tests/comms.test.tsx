import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  let urls: string[]
  let logEntries: Array<Record<string, unknown>>

  beforeEach(() => {
    urls = []
    logEntries = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.endsWith('/email-templates')) return jsonResponse({ templates: [TEMPLATE] })
        if (url.includes('/recipients-preview')) {
          const allRoster = url.includes('all_roster=true')
          const ada = { contact_id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' }
          const mae = { contact_id: 'mae', name: 'Mae Jemison', email: 'mae@example.com' }
          return jsonResponse({
            count: allRoster ? 2 : 1,
            sample: allRoster ? ['Ada Lovelace', 'Mae Jemison'] : ['Ada Lovelace'],
            recipients: allRoster ? [ada, mae] : [ada],
            available_recipients: [ada, mae],
          })
        }
        if (url.includes('/comms/log')) return jsonResponse({ log: logEntries })
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

  it('can target the whole roster and fine-tune individual recipients', async () => {
    renderComms()
    await screen.findByText("You're speaking at {{event_name}}")
    fireEvent.click(screen.getByRole('button', { name: 'Compose message' }))
    await screen.findByText('Recipients')

    fireEvent.click(screen.getByRole('checkbox', { name: 'All speakers (roster)' }))
    await waitFor(() =>
      expect(urls.some((url) => url.includes('all_roster=true'))).toBe(true)
    )
    expect(await screen.findByText('2 of 2 selected')).toBeInTheDocument()
    expect(screen.getByText('Sample: Ada Lovelace, Mae Jemison')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Send to Mae Jemison' })).toBeChecked()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Send to Ada Lovelace' }))
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument()
    expect(screen.getByText('Sample: Mae Jemison')).toBeInTheDocument()
    expect(screen.queryByText('Sample: Ada Lovelace, Mae Jemison')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Send to Ada Lovelace' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Send to Mae Jemison' })).toBeChecked()
  })

  it('labels demo-suppressed communication log rows without changing their status', async () => {
    logEntries = [
      {
        id: 'outbox-1',
        template_key: 'accept',
        subject: 'Welcome',
        recipient_name: 'Ada Lovelace',
        recipient_email: 'ada@example.com',
        status: 'cancelled',
        last_error: 'demo address — delivery suppressed',
        created_at: new Date().toISOString(),
      },
    ]
    renderComms()
    await screen.findByText("You're speaking at {{event_name}}")

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Log' }), { button: 0, ctrlKey: false })

    expect(await screen.findByText('suppressed')).toBeInTheDocument()
    expect(screen.queryByText('cancelled')).not.toBeInTheDocument()
  })
})
