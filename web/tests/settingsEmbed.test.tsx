/**
 * The organizer-facing "Embed & share" card (EMB-15): the two public page URLs
 * and the two paste-ready embed snippets, each with one-click copy.
 *
 * The snippets are asserted verbatim-ish on purpose — they have to match the
 * real loader at GET /public/program/{slug}/embed.js, which reads
 * `data-dais-event` / `data-dais-widget` off its own <script> tag.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPage } from '@/pages/SettingsPage'

const EVENT = {
  id: 'evt-1',
  name: 'AI Builders Summit',
  slug: 'ai-builders-summit',
  timezone: 'America/Los_Angeles',
  starts_at: '2026-10-12T16:00:00+00:00',
  ends_at: '2026-10-13T18:00:00+00:00',
  location: 'San Francisco, CA',
}

let writeText: ReturnType<typeof vi.fn>

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/api/events') && !url.includes('/api/events/')
        ? { events: [EVENT] }
        : url.includes('/api/api-tokens')
          ? { api_tokens: [] }
          : { items: [] }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
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
  window.localStorage.setItem('dais.token', 'test-token')
  stubFetch()
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const origin = () => window.location.origin

describe('Settings → Embed & share (EMB-15)', () => {
  it('shows the public schedule and speaker URLs for this event', async () => {
    renderSettings()
    expect(await screen.findByText('Embed & share')).toBeInTheDocument()

    expect(screen.getByTestId('public-url-schedule')).toHaveTextContent(
      `${origin()}/e/ai-builders-summit/schedule`
    )
    expect(screen.getByTestId('public-url-speakers')).toHaveTextContent(
      `${origin()}/e/ai-builders-summit/speakers`
    )
  })

  it('renders a script snippet that matches the real embed.js contract', async () => {
    renderSettings()
    const snippet = await screen.findByTestId('embed-snippet-script')
    const text = snippet.textContent ?? ''

    // Loads the loader the API actually serves…
    expect(text).toContain(`src="${origin()}/public/program/ai-builders-summit/embed.js"`)
    // …and carries the two data-* attributes the loader reads off its own tag.
    expect(text).toContain('data-dais-event="ai-builders-summit"')
    expect(text).toContain('data-dais-widget="schedule"')
    // Never async/defer: document.currentScript is null for those, and the
    // loader would bail before injecting the iframe.
    expect(text).not.toMatch(/\basync\b|\bdefer\b/)
  })

  it('renders a plain iframe snippet pointing at the embed=1 public page', async () => {
    renderSettings()
    const snippet = await screen.findByTestId('embed-snippet-iframe')
    const text = snippet.textContent ?? ''

    expect(text).toContain(`<iframe src="${origin()}/e/ai-builders-summit/schedule?embed=1"`)
    expect(text).toContain('width:100%')
    expect(text).toContain('</iframe>')
  })

  it('switches both snippets to the speakers widget', async () => {
    renderSettings()
    await screen.findByTestId('embed-snippet-script')

    fireEvent.change(screen.getByLabelText('Widget to embed'), { target: { value: 'speakers' } })

    expect(screen.getByTestId('embed-snippet-script')).toHaveTextContent(
      'data-dais-widget="speakers"'
    )
    expect(screen.getByTestId('embed-snippet-iframe').textContent).toContain(
      '/e/ai-builders-summit/speakers?embed=1'
    )
  })

  it('copies a snippet to the clipboard and confirms with "Copied"', async () => {
    renderSettings()
    const snippet = await screen.findByTestId('embed-snippet-script')
    const expected = snippet.textContent ?? ''

    const button = screen.getByTestId('copy-embed-snippet-script')
    expect(button).toHaveTextContent('Copy')

    fireEvent.click(button)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
    await waitFor(() =>
      expect(screen.getByTestId('copy-embed-snippet-script')).toHaveTextContent('Copied')
    )
  })

  it('copies the iframe snippet independently', async () => {
    renderSettings()
    const snippet = await screen.findByTestId('embed-snippet-iframe')
    const expected = snippet.textContent ?? ''

    fireEvent.click(screen.getByTestId('copy-embed-snippet-iframe'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
    expect(expected).toContain('<iframe')
    // The script block's own button is untouched.
    expect(screen.getByTestId('copy-embed-snippet-script')).toHaveTextContent('Copy')
  })

  it('offers an open-in-new-tab link beside each public URL', async () => {
    renderSettings()
    await screen.findByText('Embed & share')

    const link = screen.getByRole('link', { name: 'Open schedule' })
    expect(link).toHaveAttribute('href', `${origin()}/e/ai-builders-summit/schedule`)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('degrades to a toast when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    renderSettings()
    await screen.findByTestId('embed-snippet-script')

    fireEvent.click(screen.getByTestId('copy-embed-snippet-script'))

    // No crash, and the button never claims success.
    await waitFor(() =>
      expect(screen.getByTestId('copy-embed-snippet-script')).toHaveTextContent('Copy')
    )
    expect(screen.getByTestId('copy-embed-snippet-script')).not.toHaveTextContent('Copied')
  })

  it('keeps the copy button inside the block it belongs to', async () => {
    renderSettings()
    await screen.findByTestId('embed-snippet-script')
    const scriptBlock = screen.getByTestId('embed-snippet-script').parentElement as HTMLElement
    expect(within(scriptBlock).getByTestId('copy-embed-snippet-script')).toBeInTheDocument()
  })
})
