import { describe, expect, it } from 'vitest'

import type { QuestionRule } from '@/lib/adminApi'
import {
  describeRule,
  formatRuleValue,
  isValuelessOp,
  opPhrase,
  ruleSentenceSegments,
  type RuleFieldLookup,
} from '@/lib/ruleText'

const FIELDS: RuleFieldLookup = {
  'f-spoken': { label: 'Have you spoken before?', field_type: 'checkbox' },
  'f-prior': { label: 'Link to prior talk', field_type: 'url' },
  'f-track': { label: 'Track', field_type: 'dropdown' },
  'f-length': { label: 'Talk length (min)', field_type: 'number' },
}

function rule(overrides: Partial<QuestionRule> & Pick<QuestionRule, 'target_field_id'>): QuestionRule {
  return {
    logic: { when: [], match: 'all', action: 'show' },
    ...overrides,
  }
}

describe('describeRule', () => {
  it('renders the canonical show-when-equals sentence', () => {
    const sentence = describeRule(
      rule({
        target_field_id: 'f-prior',
        logic: { when: [{ field: 'f-spoken', op: 'eq', value: true }], match: 'all', action: 'show' },
      }),
      FIELDS
    )
    expect(sentence).toBe("Show 'Link to prior talk' when 'Have you spoken before?' equals Yes")
  })

  it('joins conditions with and/or per the match mode', () => {
    const logic = {
      when: [
        { field: 'f-track', op: 'eq' as const, value: 'AI' },
        { field: 'f-length', op: 'gte' as const, value: 30 },
      ],
      match: 'all' as const,
      action: 'require' as const,
    }
    expect(describeRule(rule({ target_field_id: 'f-prior', logic }), FIELDS)).toBe(
      "Require 'Link to prior talk' when 'Track' equals AI and 'Talk length (min)' is at least 30"
    )
    expect(
      describeRule(rule({ target_field_id: 'f-prior', logic: { ...logic, match: 'any' } }), FIELDS)
    ).toBe(
      "Require 'Link to prior talk' when 'Track' equals AI or 'Talk length (min)' is at least 30"
    )
  })

  it('drops the value for valueless operators', () => {
    expect(
      describeRule(
        rule({
          target_field_id: 'f-prior',
          logic: { when: [{ field: 'f-track', op: 'not_empty' }], match: 'all', action: 'hide' },
        }),
        FIELDS
      )
    ).toBe("Hide 'Link to prior talk' when 'Track' is not empty")
  })

  it('names a rule with no conditions as inert', () => {
    expect(describeRule(rule({ target_field_id: 'f-prior' }), FIELDS)).toBe(
      "Show 'Link to prior talk' — always (no conditions yet)"
    )
  })

  it('degrades gracefully when a referenced field is gone', () => {
    expect(
      describeRule(
        rule({
          target_field_id: 'missing',
          logic: { when: [{ field: 'also-missing', op: 'eq', value: 'x' }], match: 'all', action: 'show' },
        }),
        FIELDS
      )
    ).toBe("Show 'a deleted question' when 'a deleted question' equals x")
  })

  it('emphasises field names and values, not connective words', () => {
    const segments = ruleSentenceSegments(
      rule({
        target_field_id: 'f-prior',
        logic: { when: [{ field: 'f-track', op: 'eq', value: 'AI' }], match: 'all', action: 'show' },
      }),
      FIELDS
    )
    const emphasised = segments.filter((s) => s.emphasis).map((s) => s.text)
    expect(emphasised).toEqual(['Link to prior talk', 'Track', 'AI'])
  })
})

describe('rule value + operator helpers', () => {
  it('reads checkbox values as Yes/No', () => {
    expect(formatRuleValue(true)).toBe('Yes')
    expect(formatRuleValue(false)).toBe('No')
    expect(formatRuleValue('true', 'checkbox')).toBe('Yes')
    expect(formatRuleValue('0', 'checkbox')).toBe('No')
    expect(formatRuleValue('Workshop', 'dropdown')).toBe('Workshop')
    expect(formatRuleValue(null)).toBe('(blank)')
  })

  it('knows which operators take no value', () => {
    expect(isValuelessOp('empty')).toBe(true)
    expect(isValuelessOp('not_empty')).toBe(true)
    expect(isValuelessOp('eq')).toBe(false)
  })

  it('has a phrase for every supported operator', () => {
    const phrases = (['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'] as const).map(
      (op) => opPhrase(op)
    )
    expect(phrases).toEqual([
      'equals',
      'does not equal',
      'contains',
      'is greater than',
      'is at least',
      'is less than',
      'is at most',
      'is empty',
      'is not empty',
    ])
  })
})
