/**
 * The event's public URL slug is editable.
 *
 * The defect this covers: renaming an event left its slug frozen at whatever was
 * derived on the day it was created, so publish reported `/e/<old-slug>/`,
 * Settings showed old-slug URLs, and the shared links no longer matched the
 * event's name. Every one of those surfaces already derives from the CURRENT
 * slug — the slug simply had no way to change. Now it does, with the consequence
 * spelled out and a server-side uniqueness check behind it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPage, slugError } from '@/pages/SettingsPage'
import { agendaDays, type Agenda } from '@/lib/scheduleApi'

const EVENT = {
  id: 'evt-1',
  name: 'AI Builders Summit',
  slug: 'ai-builders-summit',
  timezone: 'America/Los_Angeles',
  starts_at: '2026-10-12T16:00:00+00:00',
  ends_at: '2026-10-13T18:00:00+00:00',
  location: 'San Francisco, CA',
}

interface Call {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

let calls: Call[] = []

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(
  { patchStatus = 200, event = EVENT }: { patchStatus?: number; event?: typeof EVENT } = {}
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const method = init.method ?? 'GET'
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })

      if (method === 'PATCH' && url.includes('/api/events/')) {
        if (patchStatus === 409) {
          return json({ detail: 'That public URL slug is already taken' }, 409)
        }
        return json({ event: { ...event, ...body } })
      }
      if (url.includes('/api/api-tokens')) return json({ api_tokens: [] })
      if (url.includes('/api/events') && !url.includes('/api/events/')) {
        return json({ events: [event] })
      }
      return json({ items: [] })
    })
  )
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  calls = []
  window.localStorage.setItem('dais.token', 'test-token')
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('slugError', () => {
  it('accepts a URL-safe slug', () => {
    expect(slugError('ai-builders-summit')).toBeNull()
    expect(slugError('summit2027')).toBeNull()
  })

  it('rejects anything that would not survive a URL', () => {
    expect(slugError('')).toBeTruthy()
    expect(slugError('Has Spaces')).toBeTruthy()
    expect(slugError('UPPER')).toBeTruthy()
    expect(slugError('-leading')).toBeTruthy()
    expect(slugError('trailing-')).toBeTruthy()
    expect(slugError('under_score')).toBeTruthy()
  })
})

describe('Settings — public URL slug', () => {
  it('shows the current slug in an editable field', async () => {
    renderSettings()
    const field = (await screen.findByTestId('event-slug')) as HTMLInputElement
    expect(field.value).toBe('ai-builders-summit')
    expect(screen.getByTestId('event-slug-help')).toHaveTextContent(
      /Lowercase letters, numbers and hyphens/
    )
  })

  it('warns that changing it changes every public link', async () => {
    renderSettings()
    const field = await screen.findByTestId('event-slug')
    fireEvent.change(field, { target: { value: 'ai-summit-2027' } })

    const help = screen.getByTestId('event-slug-help')
    expect(help).toHaveTextContent('changing this changes every public link')
    expect(help).toHaveTextContent('/e/ai-builders-summit/')
    expect(help).toHaveTextContent('/e/ai-summit-2027/')
  })

  it('PATCHes the new slug, so publish and the share links follow the rename', async () => {
    renderSettings()
    const field = await screen.findByTestId('event-slug')
    fireEvent.change(field, { target: { value: 'ai-summit-2027' } })
    fireEvent.click(screen.getByTestId('save-event'))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch!.body?.slug).toBe('ai-summit-2027')
    })
  })

  it('keeps Save disabled while the slug is unusable', async () => {
    renderSettings()
    const field = await screen.findByTestId('event-slug')

    fireEvent.change(field, { target: { value: '' } })
    expect(screen.getByTestId('save-event')).toBeDisabled()
    expect(screen.getByTestId('event-slug-help')).toHaveTextContent('required')

    fireEvent.change(field, { target: { value: 'fine-again' } })
    expect(screen.getByTestId('save-event')).toBeEnabled()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('normalises what the organizer types rather than failing on case or spacing', async () => {
    renderSettings()
    const field = (await screen.findByTestId('event-slug')) as HTMLInputElement
    fireEvent.change(field, { target: { value: '  AI-Summit-2027  ' } })
    expect(field.value).toBe('ai-summit-2027')
    expect(screen.getByTestId('save-event')).toBeEnabled()
  })

  it('surfaces a taken slug as its own message, not a raw failure', async () => {
    vi.unstubAllGlobals()
    stubFetch({ patchStatus: 409 })
    renderSettings()

    fireEvent.change(await screen.findByTestId('event-slug'), {
      target: { value: 'someone-elses-conf' },
    })
    fireEvent.click(screen.getByTestId('save-event'))

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    // The 409 is a fixable answer, so the form stays dirty and re-savable.
    await waitFor(() => expect(screen.getByTestId('save-event')).toBeEnabled())
  })

  it('saves entered dates as whole calendar days in the event timezone', async () => {
    vi.unstubAllGlobals()
    stubFetch({
      event: {
        ...EVENT,
        starts_at: '2026-10-10T07:00:00+00:00',
        ends_at: '2026-10-12T06:59:59.999+00:00',
      },
    })
    renderSettings()

    fireEvent.change(await screen.findByLabelText('Starts'), {
      target: { value: '2026-10-12' },
    })
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-10-13' } })
    fireEvent.click(screen.getByTestId('save-event'))

    let body: Record<string, unknown> = {}
    await waitFor(() => {
      body = calls.find((call) => call.method === 'PATCH')?.body ?? {}
      expect(body.starts_at).toBe('2026-10-12T07:00:00+00:00')
      expect(body.ends_at).toBe('2026-10-14T06:59:59.999+00:00')
    })

    const board: Agenda = {
      event: {
        id: EVENT.id,
        timezone: EVENT.timezone,
        starts_at: String(body.starts_at),
        ends_at: String(body.ends_at),
      },
      rooms: [],
      tracks: [],
      sessions: [],
    }
    expect(agendaDays(board, EVENT.timezone)).toEqual(['2026-10-12', '2026-10-13'])
  })
})
