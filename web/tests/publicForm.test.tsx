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

// The form now autosaves a draft to localStorage keyed by slug. Every test here
// reuses the slug 'cfp', so reset storage between tests or one test's in-progress
// answers hydrate the next.
beforeEach(() => {
  window.localStorage.clear()
})

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

/**
 * Co-speakers (ABS-11): a talk is often co-presented, and the CFP is the only
 * place a submitter can say so. Multi-speaker sessions already rendered on the
 * organizer side; what was missing was any way to CREATE one from the public
 * form. These tests cover the row lifecycle, what reaches the payload, and that
 * the draft autosave — which another feature owns — carries the rows too.
 */
describe('PublicForm — co-speakers', () => {
  beforeEach(() => {
    submitted = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/submissions')) {
          submitted.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse({ id: 'sub-3', friendly_id: 'DAIS-003' }, 201)
        }
        return jsonResponse(FORM_PAYLOAD)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Co-speaker inputs share labels with the submitter's, so address them by id. */
  function fillField(id: string, value: string) {
    const el = document.getElementById(id)
    if (!el) throw new Error(`no field #${id}`)
    fireEvent.change(el, { target: { value } })
  }

  function fillSubmitter() {
    fillField('first_name', 'Ada')
    fillField('last_name', 'Lovelace')
    fillField('email', 'ada@example.com')
    fillField('title', 'Analytical Engines')
  }

  function addRow() {
    fireEvent.click(screen.getByTestId('add-co-speaker'))
  }

  function fillCoSpeaker(index: number, first: string, last: string, email: string) {
    fillField(`co_speaker_${index}_first_name`, first)
    fillField(`co_speaker_${index}_last_name`, last)
    fillField(`co_speaker_${index}_email`, email)
  }

  function submitForm() {
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))
  }

  it('shows no co-speaker rows until one is asked for', async () => {
    renderForm()
    expect(await screen.findByTestId('add-co-speaker')).toBeInTheDocument()
    expect(screen.queryByTestId('co-speaker-row-0')).not.toBeInTheDocument()

    addRow()
    expect(screen.getByTestId('co-speaker-row-0')).toBeInTheDocument()
  })

  it('adds rows up to three and then stops offering more', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    addRow()
    addRow()
    addRow()

    expect(screen.getByTestId('co-speaker-row-2')).toBeInTheDocument()
    expect(screen.queryByTestId('add-co-speaker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('co-speaker-row-3')).not.toBeInTheDocument()
  })

  it('removes a row and keeps the remaining rows’ values', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    addRow()
    addRow()
    fillCoSpeaker(0, 'Grace', 'Hopper', 'grace@example.com')
    fillCoSpeaker(1, 'Alan', 'Turing', 'alan@example.com')

    fireEvent.click(screen.getByTestId('remove-co-speaker-0'))

    expect(screen.queryByTestId('co-speaker-row-1')).not.toBeInTheDocument()
    // Alan slid up into row 0 — his values came with him.
    expect((document.getElementById('co_speaker_0_email') as HTMLInputElement).value).toBe(
      'alan@example.com'
    )
  })

  it('submits the co-speakers alongside the proposal', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    fillSubmitter()
    addRow()
    addRow()
    fillCoSpeaker(0, 'Grace', 'Hopper', '  grace@example.com  ')
    fillCoSpeaker(1, 'Alan', 'Turing', 'alan@example.com')
    submitForm()

    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].co_speakers).toEqual([
      { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
      { first_name: 'Alan', last_name: 'Turing', email: 'alan@example.com' },
    ])
  })

  it('sends an empty list when nobody was added', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    fillSubmitter()
    submitForm()

    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].co_speakers).toEqual([])
  })

  it('drops a row the submitter opened but never filled in', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    fillSubmitter()
    addRow()
    addRow()
    fillCoSpeaker(0, 'Grace', 'Hopper', 'grace@example.com')
    submitForm()

    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].co_speakers).toEqual([
      { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
    ])
  })

  it('blocks submit when a named co-speaker has no email', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    fillSubmitter()
    addRow()
    fillField('co_speaker_0_first_name', 'Grace')
    submitForm()

    expect(await screen.findByText(/identified by email/)).toBeInTheDocument()
    expect(submitted).toHaveLength(0)
  })

  it('blocks submit when a co-speaker email is malformed', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    fillSubmitter()
    addRow()
    fillCoSpeaker(0, 'Grace', 'Hopper', 'not-an-email')
    submitForm()

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(submitted).toHaveLength(0)
  })

  it('blocks submit when a co-speaker is the submitter or a repeat', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    fillSubmitter()
    addRow()
    fillCoSpeaker(0, 'Ada', 'Lovelace', 'ADA@example.com')
    submitForm()

    expect(await screen.findByText(/already on this proposal/)).toBeInTheDocument()
    expect(submitted).toHaveLength(0)

    // …and the same address twice across two rows is the same mistake.
    fillField('co_speaker_0_email', 'grace@example.com')
    addRow()
    fillCoSpeaker(1, 'Grace', 'Hopper', 'grace@example.com')
    submitForm()

    expect(await screen.findByText(/already on this proposal/)).toBeInTheDocument()
    expect(submitted).toHaveLength(0)
  })

  it('autosaves co-speaker rows into the draft', async () => {
    renderForm()
    await screen.findByTestId('add-co-speaker')

    addRow()
    fillCoSpeaker(0, 'Grace', 'Hopper', 'grace@example.com')

    await waitFor(() => {
      const draft = JSON.parse(window.localStorage.getItem('dais.cfp-draft:cfp') ?? '{}')
      expect(draft.coSpeakers).toEqual([
        { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
      ])
    })
  })

  it('restores co-speaker rows from a saved draft', async () => {
    window.localStorage.setItem(
      'dais.cfp-draft:cfp',
      JSON.stringify({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        title: 'Analytical Engines',
        answers: {},
        coSpeakers: [{ first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' }],
      })
    )

    renderForm()
    await screen.findByText(/Draft restored/)

    expect(screen.getByTestId('co-speaker-row-0')).toBeInTheDocument()
    expect((document.getElementById('co_speaker_0_email') as HTMLInputElement).value).toBe(
      'grace@example.com'
    )

    // …and a restored row still reaches the payload on submit.
    submitForm()
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].co_speakers).toEqual([
      { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
    ])
  })

  it('clearing the draft clears the co-speaker rows too', async () => {
    window.localStorage.setItem(
      'dais.cfp-draft:cfp',
      JSON.stringify({
        firstName: 'Ada',
        lastName: '',
        email: '',
        title: '',
        answers: {},
        coSpeakers: [{ first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' }],
      })
    )

    renderForm()
    fireEvent.click(await screen.findByRole('button', { name: 'Clear draft' }))

    await waitFor(() => expect(screen.queryByTestId('co-speaker-row-0')).not.toBeInTheDocument())
  })
})

/**
 * The eval-legibility contract: Track and Session format are native `<select>`
 * elements (so a blind browser agent / the harness `select` tool can drive
 * them), and a native change still records the right answer and submits — the
 * conditional-logic answer map is unchanged by the widget swap.
 */
const TRACK = 'field-track'
const FORMAT = 'field-format'

// The wire shape the backend actually sends: field_type 'dropdown' with a
// JSONB `options.choices` string array (see getPublicForm's adapter).
const SELECT_FORM_PAYLOAD = {
  form: { id: 'form-2', slug: 'cfp', name: 'Call for Papers', welcome_html: '', settings: {} },
  event: { name: 'DaisConf' },
  fields: [
    {
      id: TRACK,
      label: 'Track',
      type: 'dropdown',
      required: true,
      order: 1,
      options: { choices: ['Platform', 'AI & ML'] },
    },
    {
      id: FORMAT,
      label: 'Session format',
      type: 'dropdown',
      required: true,
      order: 2,
      options: { choices: ['Talk (30 min)', 'Workshop (90 min)'] },
    },
  ],
  question_rules: [],
}

describe('PublicForm — native select fields (eval-legible)', () => {
  beforeEach(() => {
    submitted = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/submissions')) {
          submitted.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse({ id: 'sub-2', friendly_id: 'DAIS-002' }, 201)
        }
        return jsonResponse(SELECT_FORM_PAYLOAD)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders Track and Session format as native <select> elements', async () => {
    renderForm()
    const track = await screen.findByLabelText(/Track/)
    const format = screen.getByLabelText(/Session format/)
    expect(track.tagName).toBe('SELECT')
    expect(format.tagName).toBe('SELECT')
  })

  it('records the selected Track and Format and submits them', async () => {
    renderForm()
    await screen.findByLabelText(/Track/)

    fill(/First name/, 'Ada')
    fill(/Last name/, 'Lovelace')
    fill(/Email/, 'ada@example.com')
    fill(/Session title/, 'Analytical Engines')
    // Native change events — exactly what the harness `select` tool emits.
    fill(/Track/, 'AI & ML')
    fill(/Session format/, 'Workshop (90 min)')
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))

    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].answers).toEqual({ [TRACK]: 'AI & ML', [FORMAT]: 'Workshop (90 min)' })
  })

  it('blocks submit until a required native select is chosen', async () => {
    renderForm()
    await screen.findByLabelText(/Track/)

    fill(/First name/, 'Ada')
    fill(/Last name/, 'Lovelace')
    fill(/Email/, 'ada@example.com')
    fill(/Session title/, 'Analytical Engines')
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))

    expect(await screen.findAllByText('Required')).not.toHaveLength(0)
    expect(submitted).toHaveLength(0)
  })
})
