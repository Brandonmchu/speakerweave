/**
 * The rule builder, as a blind browser agent has to drive it.
 *
 * Conditional logic worked before this — but every control in the builder was a
 * Radix combobox: a button that opens a portal of `role="option"` divs. An agent
 * (and the eval harness `select` tool) can only operate a real `<select>`, so
 * the whole feature was unreachable without a mouse. These tests pin the two
 * things that must both hold: the controls ARE native `<select>` elements, and
 * a rule built entirely through them saves the same payload the old widgets did.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FormEditor } from '@/pages/FormEditor'

const ABSTRACT = 'fld-abstract'
const SPOKEN = 'fld-spoken'
const PRIOR = 'fld-prior'

const FORM_DETAIL = {
  form: { id: 'form-1', slug: 'cfp', name: 'Call for Speakers', settings: {} },
  fields: [
    {
      form_field_id: 'ff-1',
      field_id: ABSTRACT,
      page: 1,
      order: 0,
      required: true,
      public_name: 'Session abstract',
      field_type: 'textarea',
    },
    {
      form_field_id: 'ff-2',
      field_id: SPOKEN,
      page: 1,
      order: 1,
      required: false,
      public_name: 'Have you spoken before?',
      field_type: 'checkbox',
    },
    {
      form_field_id: 'ff-3',
      field_id: PRIOR,
      page: 1,
      order: 2,
      required: false,
      public_name: 'Link to a prior talk',
      field_type: 'text',
    },
  ],
  question_rules: [],
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let savedRules: Array<{ rules: unknown[] }>

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/forms/form-1']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/forms/:formId" element={<FormEditor />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

/** Open the Logic tab and start a new rule — the state every test needs. */
async function openRuleDialog() {
  renderEditor()
  // Radix Tabs activate on mousedown, which a real click fires and
  // fireEvent.click does not.
  fireEvent.mouseDown(await screen.findByRole('tab', { name: /Logic/ }))
  // Both the toolbar and the empty state offer "Add rule"; either opens it.
  await screen.findAllByRole('button', { name: 'Add rule' })
  fireEvent.click(screen.getAllByRole('button', { name: 'Add rule' })[0])
  return within(await screen.findByRole('dialog'))
}

describe('FormEditor rule builder — native, agent-drivable controls', () => {
  beforeEach(() => {
    savedRules = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.includes('/api/forms/form-1/rules') && method === 'PUT') {
          savedRules.push(JSON.parse(String(init?.body ?? '{}')))
          return json({ rules: [] })
        }
        if (url.includes('/api/forms/form-1')) return json(FORM_DETAIL)
        if (url.includes('/api/events')) {
          return json({ events: [{ id: 'evt-1', name: 'Summit', slug: 'summit' }] })
        }
        return json({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('renders every rule-builder control as a native <select>', async () => {
    const dialog = await openRuleDialog()

    for (const testId of [
      'rule-action',
      'rule-target',
      'rule-match',
      'rule-condition-field-0',
      'rule-condition-op-0',
    ]) {
      expect(dialog.getByTestId(testId).tagName).toBe('SELECT')
    }
  })

  it('offers every question and every operator as real <option>s', async () => {
    const dialog = await openRuleDialog()

    const target = dialog.getByTestId('rule-target')
    expect(within(target).getByRole('option', { name: 'Link to a prior talk' })).toBeInTheDocument()
    expect(within(target).getByRole('option', { name: 'Session abstract' })).toBeInTheDocument()

    const action = dialog.getByTestId('rule-action')
    expect(within(action).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Show',
      'Hide',
      'Require',
    ])

    // Every operator the evaluator supports is pickable, not just the common ones.
    expect(within(dialog.getByTestId('rule-condition-op-0')).getAllByRole('option')).toHaveLength(9)
  })

  it('builds and saves a rule entirely through native change events', async () => {
    const dialog = await openRuleDialog()

    // Exactly what the harness `select` tool emits: a change on a <select>.
    fireEvent.change(dialog.getByTestId('rule-action'), { target: { value: 'show' } })
    fireEvent.change(dialog.getByTestId('rule-target'), { target: { value: PRIOR } })
    fireEvent.change(dialog.getByTestId('rule-match'), { target: { value: 'all' } })
    fireEvent.change(dialog.getByTestId('rule-condition-field-0'), { target: { value: SPOKEN } })
    fireEvent.change(dialog.getByTestId('rule-condition-op-0'), { target: { value: 'eq' } })
    // The compared question is a checkbox, so the value control is a Yes/No select.
    fireEvent.change(dialog.getByTestId('rule-condition-value-0'), { target: { value: 'true' } })

    fireEvent.click(dialog.getByRole('button', { name: 'Add rule' }))

    // The rule reads back as a sentence, then saves in the wire shape the public
    // form consumes as question_rules.
    expect(await screen.findByText(/Link to a prior talk/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))

    await waitFor(() => expect(savedRules).toHaveLength(1))
    expect(savedRules[0].rules).toEqual([
      {
        target_field_id: PRIOR,
        logic: { when: [{ field: SPOKEN, op: 'eq', value: true }], match: 'all', action: 'show' },
      },
    ])
  })

  it('switching the compared question swaps in that question type’s value control', async () => {
    const dialog = await openRuleDialog()

    // A checkbox question compares against a Yes/No select…
    fireEvent.change(dialog.getByTestId('rule-condition-field-0'), { target: { value: SPOKEN } })
    expect(dialog.getByTestId('rule-condition-value-0').tagName).toBe('SELECT')

    // …a text question against a free-text input.
    fireEvent.change(dialog.getByTestId('rule-condition-field-0'), { target: { value: PRIOR } })
    expect(dialog.getByTestId('rule-condition-value-0').tagName).toBe('INPUT')
  })

  it('a valueless operator drops the value control entirely', async () => {
    const dialog = await openRuleDialog()

    fireEvent.change(dialog.getByTestId('rule-condition-op-0'), { target: { value: 'not_empty' } })
    expect(dialog.queryByTestId('rule-condition-value-0')).not.toBeInTheDocument()

    fireEvent.change(dialog.getByTestId('rule-condition-op-0'), { target: { value: 'contains' } })
    expect(dialog.getByTestId('rule-condition-value-0')).toBeInTheDocument()
  })

  it('a second condition gets its own addressable controls', async () => {
    const dialog = await openRuleDialog()

    fireEvent.click(dialog.getByRole('button', { name: /Add condition/ }))

    expect(dialog.getByTestId('rule-condition-field-1').tagName).toBe('SELECT')
    fireEvent.change(dialog.getByTestId('rule-condition-field-0'), { target: { value: SPOKEN } })
    fireEvent.change(dialog.getByTestId('rule-condition-field-1'), { target: { value: PRIOR } })

    // Each row edits only itself.
    expect((dialog.getByTestId('rule-condition-field-0') as HTMLSelectElement).value).toBe(SPOKEN)
    expect((dialog.getByTestId('rule-condition-field-1') as HTMLSelectElement).value).toBe(PRIOR)
  })

  it('saves a rule loaded from the server through the same native controls', async () => {
    // An existing rule must be editable, not just creatable.
    FORM_DETAIL.question_rules = [
      {
        id: 'rule-1',
        target_field_id: PRIOR,
        logic: { when: [{ field: SPOKEN, op: 'eq', value: true }], match: 'all', action: 'show' },
      },
    ] as never
    renderEditor()
    // Radix Tabs activate on mousedown, which a real click fires and
  // fireEvent.click does not.
  fireEvent.mouseDown(await screen.findByRole('tab', { name: /Logic/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit rule' }))

    const dialog = within(await screen.findByRole('dialog'))
    expect((dialog.getByTestId('rule-action') as HTMLSelectElement).value).toBe('show')
    expect((dialog.getByTestId('rule-target') as HTMLSelectElement).value).toBe(PRIOR)

    fireEvent.change(dialog.getByTestId('rule-action'), { target: { value: 'require' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Update rule' }))
    fireEvent.click(await screen.findByRole('button', { name: /Save changes/ }))

    await waitFor(() => expect(savedRules).toHaveLength(1))
    expect((savedRules[0].rules[0] as { logic: { action: string } }).logic.action).toBe('require')
    FORM_DETAIL.question_rules = []
  })
})

/**
 * CFP-02, the builder half: the choices an organizer authors logic against.
 *
 * Track and Session format questions carry a SNAPSHOT of the taxonomy names
 * they were created with. The public form has served the event's live names
 * since wave 6; the builder had not caught up, so renaming formats in Settings
 * left the organizer picking "Workshop" out of a list nobody would ever be
 * shown — and the `show when format equals "Workshop"` they saved could never
 * fire against the "Workshop (120 min)" a speaker actually picks.
 *
 * GET /api/forms/{id} now resolves both the choices and the operands of stored
 * rules against the live taxonomy (api/routes/form_admin_routes.py). What these
 * tests pin is the builder's side of it: it offers exactly the choices the API
 * sends, and a value that has fallen off that list stays visible instead of
 * being silently displayed as some other choice.
 */
const FORMAT = 'fld-format'
const PREREQ = 'fld-prereq'

/** The builder payload after live resolution: renamed formats, re-pointed rule. */
function formatFormDetail(operand: string) {
  return {
    form: { id: 'form-1', slug: 'cfp', name: 'Call for Speakers', settings: {} },
    fields: [
      {
        form_field_id: 'ff-f',
        field_id: FORMAT,
        page: 1,
        order: 0,
        required: true,
        public_name: 'Session format',
        field_type: 'dropdown',
        options: { choices: ['Talk (30 min)', 'Workshop (120 min)', 'Panel (45 min)'] },
      },
      {
        form_field_id: 'ff-p',
        field_id: PREREQ,
        page: 1,
        order: 1,
        required: false,
        public_name: 'Workshop prerequisites',
        field_type: 'textarea',
      },
    ],
    question_rules: [
      {
        id: 'rule-workshop',
        target_field_id: PREREQ,
        logic: {
          when: [{ field: FORMAT, op: 'eq', value: operand }],
          match: 'all',
          action: 'show',
        },
      },
    ],
  }
}

function stubBuilder(detail: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/forms/form-1/rules') && (init?.method ?? 'GET') === 'PUT') {
        savedRules.push(JSON.parse(String(init?.body ?? '{}')))
        return json({ rules: [] })
      }
      if (url.includes('/api/forms/form-1')) return json(detail)
      return json({}, 404)
    })
  )
}

/** Open the stored rule for editing and return its dialog. */
async function openStoredRule() {
  renderEditor()
  fireEvent.mouseDown(await screen.findByRole('tab', { name: /Logic/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Edit rule' }))
  return within(await screen.findByRole('dialog'))
}

describe('FormEditor rule builder — taxonomy choices are the live ones', () => {
  beforeEach(() => {
    savedRules = []
    window.localStorage.setItem('dais.token', 'test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('offers the format choices the API sends, selected on the stored operand', async () => {
    stubBuilder(formatFormDetail('Workshop (120 min)'))
    const dialog = await openStoredRule()

    const value = dialog.getByTestId('rule-condition-value-0') as HTMLSelectElement
    expect(value.tagName).toBe('SELECT')
    expect(
      within(value)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Talk (30 min)', 'Workshop (120 min)', 'Panel (45 min)'])
    // The rule reads as what it does, against a name a speaker will be offered.
    expect(value.value).toBe('Workshop (120 min)')
  })

  it('lists the questions page with the live choices, not the snapshot', async () => {
    stubBuilder(formatFormDetail('Workshop (120 min)'))
    renderEditor()

    expect(
      await screen.findByText(/Choices: Talk \(30 min\), Workshop \(120 min\), Panel \(45 min\)/)
    ).toBeInTheDocument()
  })

  it('keeps an operand that is no longer a choice visible and flagged', async () => {
    // The format was deleted rather than renamed, so the backend had nothing to
    // re-point it at. Dropping it from the list would make the select display
    // "Talk (30 min)" — a rule saying something it has never said.
    stubBuilder(formatFormDetail('Fireside chat'))
    const dialog = await openStoredRule()

    const value = dialog.getByTestId('rule-condition-value-0') as HTMLSelectElement
    expect(value.value).toBe('Fireside chat')
    expect(
      within(value).getByRole('option', { name: 'Fireside chat — no longer a choice' })
    ).toBeInTheDocument()
  })

  it('saves the live choice the organizer picks', async () => {
    stubBuilder(formatFormDetail('Workshop (120 min)'))
    const dialog = await openStoredRule()

    fireEvent.change(dialog.getByTestId('rule-condition-value-0'), {
      target: { value: 'Panel (45 min)' },
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Update rule' }))
    fireEvent.click(await screen.findByRole('button', { name: /Save changes/ }))

    await waitFor(() => expect(savedRules).toHaveLength(1))
    expect(savedRules[0].rules).toEqual([
      {
        target_field_id: PREREQ,
        logic: {
          when: [{ field: FORMAT, op: 'eq', value: 'Panel (45 min)' }],
          match: 'all',
          action: 'show',
        },
      },
    ])
  })
})
