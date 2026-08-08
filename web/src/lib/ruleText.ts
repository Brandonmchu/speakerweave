/**
 * Renders a question rule as an English sentence.
 *
 * The rule editor stores logic as JSON ({when, match, action}), but an operator
 * should never have to read JSON to know what their form does. Everything the
 * Rules tab shows comes from here, so the list, the dialog preview and any
 * future audit log all say exactly the same thing.
 *
 * Output is returned as segments so the UI can emphasise field names and values
 * without re-parsing a string; `describeRule` is the flattened form (and what
 * the tests assert against).
 */

import type { QuestionRule, RuleCondition, RuleLogic, RuleOp } from '@/lib/adminApi'

export interface RuleFieldMeta {
  label: string
  field_type?: string
}

/** field_id → how to name and format it. Missing ids degrade to "a deleted question". */
export type RuleFieldLookup = Record<string, RuleFieldMeta | undefined>

export interface Segment {
  text: string
  /** Field names and compared values — rendered stronger than the connective words. */
  emphasis?: boolean
  /** Only field names get quoted in the flattened sentence. */
  kind?: 'field' | 'value'
}

const ACTION_VERB: Record<string, string> = {
  show: 'Show',
  hide: 'Hide',
  require: 'Require',
}

const OP_PHRASE: Record<RuleOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  contains: 'contains',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  empty: 'is empty',
  not_empty: 'is not empty',
}

/** Ops that compare against nothing — the value input is hidden for these. */
export const VALUELESS_OPS: RuleOp[] = ['empty', 'not_empty']

export function isValuelessOp(op: RuleOp): boolean {
  return VALUELESS_OPS.indexOf(op) !== -1
}

export function opPhrase(op: RuleOp): string {
  return OP_PHRASE[op] ?? String(op)
}

export function actionVerb(action: string): string {
  return ACTION_VERB[action] ?? action
}

const MISSING_FIELD = 'a deleted question'

function fieldName(fieldId: string, fields: RuleFieldLookup): string {
  const meta = fields[fieldId]
  return meta?.label?.trim() || MISSING_FIELD
}

/**
 * Values arrive off JSON, so anything can show up. Checkboxes read as Yes/No —
 * "equals true" is developer-speak.
 */
export function formatRuleValue(value: unknown, fieldType?: string): string {
  if (value === null || value === undefined || value === '') return '(blank)'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (fieldType === 'checkbox') {
    const s = String(value).toLowerCase()
    if (s === 'true' || s === 'yes' || s === '1') return 'Yes'
    if (s === 'false' || s === 'no' || s === '0') return 'No'
  }
  return String(value)
}

function conditionSegments(condition: RuleCondition, fields: RuleFieldLookup): Segment[] {
  const meta = fields[condition.field]
  const segments: Segment[] = [
    { text: fieldName(condition.field, fields), emphasis: true, kind: 'field' },
    { text: ` ${opPhrase(condition.op)}` },
  ]
  if (!isValuelessOp(condition.op)) {
    segments.push({ text: ' ' })
    segments.push({
      text: formatRuleValue(condition.value, meta?.field_type),
      emphasis: true,
      kind: 'value',
    })
  }
  return segments
}

/**
 * "Show <Field> when <Field> equals <Value> and <Field> is not empty".
 * A rule with no conditions is inert and says so.
 */
export function ruleSentenceSegments(rule: QuestionRule, fields: RuleFieldLookup): Segment[] {
  const logic: RuleLogic = rule.logic ?? { when: [], match: 'all', action: 'show' }
  const conditions = logic.when ?? []
  const segments: Segment[] = [
    { text: actionVerb(logic.action) },
    { text: ' ' },
    { text: fieldName(rule.target_field_id, fields), emphasis: true, kind: 'field' },
  ]

  if (conditions.length === 0) {
    segments.push({ text: ' — always (no conditions yet)' })
    return segments
  }

  segments.push({ text: ' when ' })
  const joiner = logic.match === 'any' ? ' or ' : ' and '
  conditions.forEach((condition, i) => {
    if (i > 0) segments.push({ text: joiner })
    segments.push(...conditionSegments(condition, fields))
  })
  return segments
}

/** Flattened sentence — quotes around question names so it reads standalone. */
export function describeRule(rule: QuestionRule, fields: RuleFieldLookup): string {
  return ruleSentenceSegments(rule, fields)
    .map((s) => (s.kind === 'field' ? `'${s.text}'` : s.text))
    .join('')
}
