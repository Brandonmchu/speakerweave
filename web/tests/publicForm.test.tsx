/**
 * The public renderer's half of the conditional-logic contract.
 *
 * lib/rules.ts is unit-tested against the canonical fixtures; what this file
 * proves is the wiring — that a hidden field actually unmounts, that a hidden
 * required field cannot block a submit, and that its stale answer never reaches
 * the payload. The last one is the important one: the server drops those
 * answers too, and a mismatch means the two disagree about what was asked.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PublicForm } from '@/pages/PublicForm'

const SPOKEN_BEFORE = 'field-spoken-before'
const PRIOR_TALK = 'field-prior-talk'

/** The wire shape of GET /public/forms/{slug}, rules included. */
const FORM_PAYLOAD = {
  form: {
    id: 'form-1',
    slug: 'cfp',
    name: 'Call for Papers',
    welcome_html: '',
    settings: {},
  },
  event: { name: 'DaisConf' },
  fields: [
    {
      id: SPOKEN_BEFORE,
      label: 'Have you spoken before?',
      type: 'text',
      required: false,
      order: 1,
    },
    {
      id: PRIOR_TALK,
      label: 'Link to a prior talk',
      type: 'text',
      // Required, but only reachable through the branch — the case that proves
      // visibility is honoured before required is.
      required: true,
      order: 2,
    },
  ],
  question_rules: [
    {
      id: 'rule-1',
      target_field_id: PRIOR_TALK,
      logic: {
        when: [{ field: SPOKEN_BEFORE, op: 'eq', value: 'yes' }],
        match: 'all',
        action: 'show',
      },
    },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let submitted: Array<Record<string, unknown>> = []

function renderForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/submit/cfp']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/submit/:slug" element={<PublicForm />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('PublicForm — live conditional logic', () => {
  beforeEach(() => {
    submitted = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/submissions')) {
          submitted.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse({ id: 'sub-1', friendly_id: 'DAIS-001' }, 201)
        }
        return jsonResponse(FORM_PAYLOAD)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a show-gated field unmounted until its rule matches', async () => {
    renderForm()
    expect(await screen.findByLabelText(/Have you spoken before/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Link to a prior talk/)).not.toBeInTheDocument()

    fill(/Have you spoken before/, 'yes')
    expect(await screen.findByLabelText(/Link to a prior talk/)).toBeInTheDocument()

    fill(/Have you spoken before/, 'no')
    await waitFor(() =>
      expect(screen.queryByLabelText(/Link to a prior talk/)).not.toBeInTheDocument()
    )
  })

  it('submits without the hidden required field and without its stale answer', async () => {
    renderForm()
    await screen.findByLabelText(/Have you spoken before/)

    // Take the branch, answer it, then abandon it.
    fill(/Have you spoken before/, 'yes')
    await screen.findByLabelText(/Link to a prior talk/)
    fill(/Link to a prior talk/, 'https://stale.example')
    fill(/Have you spoken before/, 'no')

    fill(/First name/, 'Ada')
    fill(/Last name/, 'Lovelace')
    fill(/Email/, 'ada@example.com')
    fill(/Session title/, 'Analytical Engines')
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))

    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].answers).toEqual({ [SPOKEN_BEFORE]: 'no' })
  })

  it('blocks submit while a visible required field is blank', async () => {
    renderForm()
    await screen.findByLabelText(/Have you spoken before/)

    fill(/Have you spoken before/, 'yes')
    await screen.findByLabelText(/Link to a prior talk/)

    fill(/First name/, 'Ada')
    fill(/Last name/, 'Lovelace')
    fill(/Email/, 'ada@example.com')
    fill(/Session title/, 'Analytical Engines')
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))

    expect(await screen.findByText('Required')).toBeInTheDocument()
    expect(submitted).toHaveLength(0)
  })
})
