import { describe, expect, it } from 'vitest'

import { getEntityRoute } from '@/agent/lib/entityRoutes'

describe('agent entity routes', () => {
  it.each([
    ['submission', 'submission-1', '/submissions?open=submission-1'],
    ['speaker', 'person-1', '/speakers?person=person-1'],
    ['contact', 'person-2', '/speakers?person=person-2'],
    ['session', 'session-1', '/agenda?session=session-1'],
    ['form', 'form-1', '/forms/form-1'],
    ['content', 'content-1', '/content?item=content-1'],
    ['event', 'event-1', '/settings'],
  ])('maps %s to its contract route', (type, id, expected) => {
    expect(getEntityRoute(type, id)).toBe(expected)
  })
})

