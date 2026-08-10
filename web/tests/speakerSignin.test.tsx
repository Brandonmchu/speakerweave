import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SpeakerSignin } from '@/pages/SpeakerSignin'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/speaker-signin']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/speaker-signin" element={<SpeakerSignin />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('Speaker sign in', () => {
  it('posts to the featured form manage-link endpoint and shows generic copy', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ ok: true, message: 'Server wording is deliberately ignored.' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )
    vi.stubGlobal('fetch', fetch)
    renderPage()

    expect(screen.getByRole('heading', { name: 'Speaker sign in' })).toBeInTheDocument()
    expect(screen.getByText(/No password needed/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'speaker@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Email me a sign-in link/i }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0][0]).toBe('/public/forms/call-for-speakers/manage-link')
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      email: 'speaker@example.com',
    })
    expect(
      await screen.findByText('Check your email — we sent you a sign-in link')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Server wording/)).not.toBeInTheDocument()
  })
})
