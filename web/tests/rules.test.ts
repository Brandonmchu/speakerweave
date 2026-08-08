/**
 * The canonical conditional-logic contract.
 *
 * `tests/fixtures/question_rules.json` is a byte-identical copy of
 * `api/tests/fixtures/question_rules.json`; both implementations run it, so a
 * semantic that drifts on one side turns the other side's suite red instead of
 * quietly showing a speaker a field the server will reject.
 *
 * The fixture speaks the wire's snake_case (`required_override`) because Python
 * owns the write path; the TS surface is camelCase. `toWire` is the whole of
 * that translation — deliberately the only place the two spellings meet.
 */
import { describe, expect, it } from 'vitest'

// `?raw` rather than a JSON import: the file is a verbatim copy of the Python
// suite's fixture, so it must be read as text and parsed, never reformatted or
// reshaped by a bundler plugin on the way in.
import fixtureText from './fixtures/question_rules.json?raw'

import {
  DEFAULT_FIELD_STATE,
  RULE_ACTIONS,
  RULE_OPS,
  evaluateRules,
  isBlankAnswer,
  isFieldRequired,
  isFieldVisible,
  looseEquals,
  visibleAnswers,
  type AnswerMap,
  type AnswerValue,
  type RuleInput,
  type RuleStates,
} from '@/lib/rules'

interface FixtureCase {
  name: string
  rules: RuleInput[]
  answers: AnswerMap
  expected: Record<string, { visible: boolean; required_override: boolean | null }>
}

const parsed = JSON.parse(fixtureText) as FixtureCase[] | { cases: FixtureCase[] }
const CASES: FixtureCase[] = Array.isArray(parsed) ? parsed : parsed.cases

function toWire(states: RuleStates): FixtureCase['expected'] {
  return Object.fromEntries(
    Object.entries(states).map(([fieldId, state]) => [
      fieldId,
      { visible: state.visible, required_override: state.requiredOverride },
    ])
  )
}

describe('evaluateRules — canonical fixtures', () => {
  it('loads a suite worth trusting', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10)
  })

  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    expect(toWire(evaluateRules(testCase.rules, testCase.answers))).toEqual(testCase.expected)
  })

  it('covers every operator, action and match mode', () => {
    const ops = new Set<string>()
    const actions = new Set<string>()
    const matches = new Set<string>()
    for (const testCase of CASES) {
      for (const rule of testCase.rules) {
        const logic = rule.logic ?? rule
        actions.add(String(logic.action))
        matches.add(String(logic.match ?? 'all'))
        for (const condition of logic.when ?? []) ops.add(condition.op)
      }
    }
    expect([...RULE_OPS].filter((op) => !ops.has(op))).toEqual([])
    expect([...RULE_ACTIONS].filter((action) => !actions.has(action))).toEqual([])
    expect(matches).toEqual(new Set(['all', 'any']))
  })
})

describe('evaluateRules — shapes the wire can produce', () => {
  it('ignores malformed rules instead of blanking the form', () => {
    expect(evaluateRules([null, undefined, {}, { logic: { action: 'show' } }], { a: 1 })).toEqual({})
  })

  it('accepts logic inlined next to the target (seeds and hand-written rules)', () => {
    const inline: RuleInput[] = [
      {
        target_field_id: 'prior_talk',
        when: [{ field: 'spoken_before', op: 'eq', value: true }],
        match: 'all',
        action: 'show',
      },
    ]
    expect(evaluateRules(inline, { spoken_before: true }).prior_talk.visible).toBe(true)
    expect(evaluateRules(inline, { spoken_before: false }).prior_talk.visible).toBe(false)
  })

  it('tolerates missing rules and missing answers', () => {
    expect(evaluateRules(null, null)).toEqual({})
    expect(evaluateRules(undefined, {})).toEqual({})
  })
})

describe('looseEquals', () => {
  it.each([
    [true, 'true', true],
    [false, 'false', true],
    [false, '', true],
    [true, 'maybe', false],
    [30, '30', true],
    ['30.0', 30, true],
    ['Talk', ' Talk ', true],
    ['Talk', 'talk', false],
    [null, null, true],
    [undefined, null, true],
    [null, '', false],
    [['a', 'b'], ['a', 'b'], true],
    [['a'], ['a', 'b'], false],
  ] as Array<[AnswerValue, AnswerValue, boolean]>)('%s == %s -> %s', (left, right, equal) => {
    expect(looseEquals(left, right)).toBe(equal)
  })
})

describe('isBlankAnswer', () => {
  it.each([
    [null, true],
    [undefined, true],
    [false, true],
    ['', true],
    ['   ', true],
    [[], true],
    [true, false],
    ['x', false],
    [0, false],
    [['a'], false],
  ] as Array<[AnswerValue, boolean]>)('%s -> %s', (value, blank) => {
    expect(isBlankAnswer(value)).toBe(blank)
  })
})

describe('renderer lookups', () => {
  const rules: RuleInput[] = [
    {
      id: 'r-show',
      target_field_id: 'prior_talk',
      logic: {
        when: [{ field: 'spoken_before', op: 'eq', value: true }],
        match: 'all',
        action: 'show',
      },
    },
    {
      id: 'r-require',
      target_field_id: 'bio',
      logic: {
        when: [{ field: 'format', op: 'eq', value: 'Keynote' }],
        match: 'all',
        action: 'require',
      },
    },
  ]

  it('defaults untargeted fields to visible and un-overridden', () => {
    const states = evaluateRules(rules, {})
    expect(isFieldVisible(states, 'abstract')).toBe(true)
    expect(isFieldRequired(states, 'abstract', false)).toBe(false)
    expect(isFieldRequired(states, 'abstract', true)).toBe(true)
    expect(DEFAULT_FIELD_STATE).toEqual({ visible: true, requiredOverride: null })
  })

  it('promotes an optional field when a require rule matches', () => {
    expect(isFieldRequired(evaluateRules(rules, { format: 'Keynote' }), 'bio', false)).toBe(true)
    expect(isFieldRequired(evaluateRules(rules, { format: 'Talk' }), 'bio', false)).toBe(false)
  })

  it('never cancels a requirement the form author declared', () => {
    expect(isFieldRequired(evaluateRules(rules, { format: 'Talk' }), 'bio', true)).toBe(true)
  })

  // The submit-payload guarantee: a branch the speaker abandoned leaves no
  // residue for the organizer to read. Server-side twin: validate_submission.
  it('drops answers to hidden fields from the submission payload', () => {
    const answers = { spoken_before: false, prior_talk: 'https://stale.example', abstract: 'A talk' }
    const states = evaluateRules(rules, answers)

    expect(visibleAnswers(answers, states)).toEqual({
      spoken_before: false,
      abstract: 'A talk',
    })
  })

  it('keeps the answer once the branch is taken again', () => {
    const answers = { spoken_before: true, prior_talk: 'https://talk.example' }
    expect(visibleAnswers(answers, evaluateRules(rules, answers))).toEqual(answers)
  })
})
