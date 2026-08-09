/**
 * The last three Radix comboboxes in the form editor, as a blind browser agent
 * has to drive them.
 *
 * The rule builder was converted first (formEditorRules.test.tsx); these are the
 * ones left on the Questions tab: which page a question sits on, and — in the
 * "create a new field" dialog — the field's Answer type and what it Applies to.
 * A Radix combobox is a button that opens a portal of `role="option"` divs, which
 * the eval harness `select` tool cannot touch. Each must therefore be a real
 * `<select>`, and a plain change event on it must still produce the same payload.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FormEditor } from '@/pages/FormEditor'

const ABSTRACT = 'fld-abstract'

const FORM_DETAIL = {
  form: { id: 'form-1', slug: 'cfp', name: 'Call for Speakers', event_id: 'evt-1', settings: {} },
  fields: [
    {
      form_field_id: 'ff-1',
      field_id: ABSTRACT,
      page: 3,
      order: 0,
      required: true,
      public_name: 'Session abstract',
      field_type: 'textarea',
    },
  ],
  question_rules: [],
}

const LIBRARY_FIELDS = [
  { id: ABSTRACT, public_name: 'Session abstract', field_type: 'textarea', scope: 'session' },
]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let savedFields: Array<{ fields: Array<Record<string, unknown>> }>
let createdFields: Array<Record<string, unknown>>

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

/** Open the "Add a question" dialog and switch it to the create-a-field form. */
async function openCreateFieldForm() {
  renderEditor()
  fireEvent.click(await screen.findByRole('button', { name: /Add question/i }))
  const dialog = within(await screen.findByRole('dialog'))
  fireEvent.click(await dialog.findByRole('button', { name: /Create new field/i }))
  return dialog
}

describe('FormEditor pickers — native, agent-drivable', () => {
  beforeEach(() => {
    savedFields = []
    createdFields = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.includes('/api/forms/form-1/fields') && method === 'PUT') {
          savedFields.push(JSON.parse(String(init?.body ?? '{}')))
          return json({ fields: FORM_DETAIL.fields })
        }
        if (url.includes('/api/forms/form-1')) return json(FORM_DETAIL)
        if (url.includes('/fields') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'))
          createdFields.push(body)
          return json({ field: { id: 'fld-new', ...body } }, 201)
        }
        if (url.includes('/fields')) return json({ fields: LIBRARY_FIELDS })
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

  it('the per-question Page picker is a real <select> listing every page', async () => {
    renderEditor()

    const page = await screen.findByTestId('field-page-ff-1')
    expect(page.tagName).toBe('SELECT')
    expect((page as HTMLSelectElement).value).toBe('3')
    expect(within(page).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '1 · Welcome',
      '2 · About you',
      '3 · Your session',
      '4 · Speaker info',
    ])
  })

  it('moving a question to another page through a native change event saves it', async () => {
    renderEditor()
    const page = await screen.findByTestId('field-page-ff-1')

    // Exactly what the harness `select` tool emits.
    fireEvent.change(page, { target: { value: '2' } })
    expect((page as HTMLSelectElement).value).toBe('2')
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(savedFields).toHaveLength(1))
    expect(savedFields[0].fields[0]).toMatchObject({ field_id: ABSTRACT, page: 2 })
  })

  it('the new-field Answer type and Applies to pickers are real <select>s', async () => {
    const dialog = await openCreateFieldForm()

    const type = dialog.getByTestId('new-field-type')
    const scope = dialog.getByTestId('new-field-scope')
    expect(type.tagName).toBe('SELECT')
    expect(scope.tagName).toBe('SELECT')

    // Every answer type the field library supports is a real <option>…
    expect(within(type).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Short text',
      'Long text',
      'Email',
      'URL',
      'Number',
      'Dropdown',
      'Checkbox',
    ])
    expect(within(scope).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Session',
      'Speaker',
    ])
    // …and both are labelled, so the control is addressable by its question.
    expect(dialog.getByLabelText('Answer type')).toBe(type)
    expect(dialog.getByLabelText('Applies to')).toBe(scope)
  })

  it('changing the Answer type drives the form: Dropdown asks for choices', async () => {
    const dialog = await openCreateFieldForm()
    expect(dialog.queryByLabelText(/Choices/)).not.toBeInTheDocument()

    fireEvent.change(dialog.getByTestId('new-field-type'), { target: { value: 'dropdown' } })
    expect(await dialog.findByLabelText(/Choices/)).toBeInTheDocument()

    // …and switching back to a plain type drops the choices box again.
    fireEvent.change(dialog.getByTestId('new-field-type'), { target: { value: 'text' } })
    await waitFor(() => expect(dialog.queryByLabelText(/Choices/)).not.toBeInTheDocument())
  })

  it('creates a field with the values picked through native change events', async () => {
    const dialog = await openCreateFieldForm()

    fireEvent.change(dialog.getByLabelText(/Question/), {
      target: { value: 'Which track fits best?' },
    })
    fireEvent.change(dialog.getByTestId('new-field-type'), { target: { value: 'dropdown' } })
    fireEvent.change(dialog.getByTestId('new-field-scope'), { target: { value: 'speaker' } })
    fireEvent.change(await dialog.findByLabelText(/Choices/), {
      target: { value: 'Platform\nAI & ML' },
    })

    fireEvent.click(dialog.getByRole('button', { name: /Create & add/i }))

    await waitFor(() => expect(createdFields).toHaveLength(1))
    expect(createdFields[0]).toMatchObject({
      public_name: 'Which track fits best?',
      field_type: 'dropdown',
      scope: 'speaker',
      options: { choices: ['Platform', 'AI & ML'] },
    })
  })
})
