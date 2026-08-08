import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createEvent,
  createField,
  createForm,
  createTaxonomy,
  deleteTaxonomy,
  getForm,
  listFields,
  listForms,
  listTaxonomy,
  publicFormPath,
  publicFormUrl,
  putFormFields,
  putFormRules,
  updateEvent,
  updateForm,
  updateTaxonomy,
} from '@/lib/adminApi'

interface Call {
  url: string
  method?: string
  body?: unknown
  headers: Headers
}

let calls: Call[] = []
let nextPayload: unknown = {}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init.headers),
      })
      return new Response(JSON.stringify(nextPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  )
}

const last = () => calls[calls.length - 1]

beforeEach(() => {
  calls = []
  nextPayload = {}
  window.localStorage.setItem('dais.token', 'test-token')
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('forms endpoints', () => {
  it('lists forms off the event and unwraps the envelope', async () => {
    nextPayload = { forms: [{ id: 'form-1', slug: 'cfp', name: 'CFP' }] }
    const forms = await listForms('evt-1')
    expect(last().url).toBe('/api/events/evt-1/forms')
    expect(last().method).toBe('GET')
    expect(forms).toHaveLength(1)
    expect(forms[0].slug).toBe('cfp')
  })

  it('creates a form and returns the row out of {form}', async () => {
    nextPayload = { form: { id: 'form-2', slug: 'cfp-2', name: 'Call for Speakers' } }
    const form = await createForm('evt-1', 'Call for Speakers')
    expect(last().url).toBe('/api/events/evt-1/forms')
    expect(last().method).toBe('POST')
    expect(last().body).toEqual({ name: 'Call for Speakers' })
    expect(form.id).toBe('form-2')
  })

  it('reads one form by id', async () => {
    nextPayload = { form: { id: 'form-1' }, fields: [], question_rules: [] }
    await getForm('form-1')
    expect(last().url).toBe('/api/forms/form-1')
  })

  it('PATCHes only the keys it was given', async () => {
    nextPayload = { form: { id: 'form-1', name: 'Renamed' } }
    await updateForm('form-1', { name: 'Renamed' })
    expect(last().url).toBe('/api/forms/form-1')
    expect(last().method).toBe('PATCH')
    expect(last().body).toEqual({ name: 'Renamed' })
  })

  it('PUTs fields as a full replace under {fields}', async () => {
    nextPayload = { fields: [] }
    await putFormFields('form-1', [
      { field_id: 'fld-1', page: 3, order: 1, required: true, label_override: null, help_text: null },
    ])
    expect(last().url).toBe('/api/forms/form-1/fields')
    expect(last().method).toBe('PUT')
    expect(last().body).toEqual({
      fields: [
        { field_id: 'fld-1', page: 3, order: 1, required: true, label_override: null, help_text: null },
      ],
    })
  })

  it('PUTs rules as a full replace under {rules}', async () => {
    nextPayload = { question_rules: [] }
    await putFormRules('form-1', [
      {
        target_field_id: 'fld-2',
        logic: { when: [{ field: 'fld-1', op: 'eq', value: true }], match: 'all', action: 'show' },
      },
    ])
    expect(last().url).toBe('/api/forms/form-1/rules')
    expect(last().method).toBe('PUT')
    expect(last().body).toEqual({
      rules: [
        {
          target_field_id: 'fld-2',
          logic: { when: [{ field: 'fld-1', op: 'eq', value: true }], match: 'all', action: 'show' },
        },
      ],
    })
  })
})

describe('field library endpoints', () => {
  it('omits the scope query when no scope is given', async () => {
    nextPayload = { fields: [] }
    await listFields('evt-1')
    expect(last().url).toBe('/api/events/evt-1/fields')
  })

  it('encodes the scope query when one is', async () => {
    nextPayload = { fields: [] }
    await listFields('evt-1', 'session')
    expect(last().url).toBe('/api/events/evt-1/fields?scope=session')
  })

  it('creates a field and unwraps {field}', async () => {
    nextPayload = { field: { id: 'fld-9', public_name: 'Track', field_type: 'dropdown' } }
    const field = await createField('evt-1', {
      scope: 'session',
      public_name: 'Track',
      field_type: 'dropdown',
      options: { choices: ['AI', 'Infra'] },
    })
    expect(last().url).toBe('/api/events/evt-1/fields')
    expect(last().method).toBe('POST')
    expect(field.id).toBe('fld-9')
  })
})

describe('taxonomy endpoints', () => {
  it('nests list + create under the event, and mutations under the kind', async () => {
    nextPayload = { tracks: [{ id: 't1', name: 'AI' }] }
    const tracks = await listTaxonomy('evt-1', 'tracks')
    expect(last().url).toBe('/api/events/evt-1/tracks')
    expect(tracks[0].name).toBe('AI')

    nextPayload = { track: { id: 't2', name: 'Infra' } }
    const created = await createTaxonomy('evt-1', 'tracks', { name: 'Infra', color: '#fff' })
    expect(last().url).toBe('/api/events/evt-1/tracks')
    expect(last().method).toBe('POST')
    expect(created.id).toBe('t2')

    nextPayload = { room: { id: 'r1', name: 'Main Hall', capacity: 200 } }
    const updated = await updateTaxonomy('rooms', 'r1', { capacity: 200 })
    expect(last().url).toBe('/api/rooms/r1')
    expect(last().method).toBe('PATCH')
    expect(updated.capacity).toBe(200)

    nextPayload = {}
    await deleteTaxonomy('formats', 'fm1')
    expect(last().url).toBe('/api/formats/fm1')
    expect(last().method).toBe('DELETE')
  })
})

describe('event endpoints', () => {
  it('creates and patches events', async () => {
    nextPayload = { event: { id: 'evt-9', name: 'Summit', slug: 'summit' } }
    const created = await createEvent({ name: 'Summit', timezone: 'America/Los_Angeles' })
    expect(last().url).toBe('/api/events')
    expect(last().method).toBe('POST')
    expect(created.id).toBe('evt-9')

    nextPayload = { event: { id: 'evt-9', name: 'Summit 2026', slug: 'summit' } }
    await updateEvent('evt-9', { name: 'Summit 2026' })
    expect(last().url).toBe('/api/events/evt-9')
    expect(last().method).toBe('PATCH')
  })
})

describe('transport', () => {
  it('sends the bearer token on admin calls', async () => {
    nextPayload = { forms: [] }
    await listForms('evt-1')
    expect(last().headers.get('Authorization')).toBe('Bearer test-token')
  })

  it('builds the public form link off the current origin', () => {
    expect(publicFormPath('cfp-2026')).toBe('/submit/cfp-2026')
    expect(publicFormUrl('cfp-2026')).toBe(`${window.location.origin}/submit/cfp-2026`)
  })
})
