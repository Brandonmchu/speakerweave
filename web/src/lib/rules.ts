/**
 * Conditional form logic — the renderer's half of a two-implementation contract.
 *
 * A rule is the `question_rules` row from PLAN.md §2:
 *
 *     {id, target_field_id, logic: {when: [{field, op, value}],
 *                                   match: 'all' | 'any',
 *                                   action: 'show' | 'hide' | 'require'}}
 *
 * The public form asks one question of this module — "given the answers so far,
 * which fields are on screen and which are required?" — and gets back a state
 * map keyed by field id.
 *
 * This is a line-by-line mirror of `api/services/question_rules.py`. The two
 * MUST agree: if they don't, a speaker either sees a field the server rejects
 * or, worse, submits an answer to a question they were never shown. What pins
 * them together is a single canonical fixture suite,
 * `tests/fixtures/question_rules.json` (byte-identical copy of
 * `api/tests/fixtures/question_rules.json`), which both suites run — exactly
 * the arrangement PLAN.md §3 uses for conflict detection. Change the semantics
 * => change the fixtures => both suites move, or one goes red.
 *
 * Resolution, per target field:
 *   - default is visible with no opinion on required (`requiredOverride: null`)
 *   - a field targeted by any `show` rule is hidden UNLESS one of those rules
 *     matches — "show when X" means "hidden by default"
 *   - a matched `hide` rule always beats a matched `show` rule
 *   - `require` is independent of visibility: a match sets requiredOverride,
 *     no match leaves it null. Rules only ever ADD a requirement.
 *
 * Note the wire/Python side spells the key `required_override`; the TS surface
 * is camelCase, and tests/rules.test.ts translates at the fixture boundary.
 */

export type RuleOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'not_empty'
export type RuleAction = 'show' | 'hide' | 'require'
export type RuleMatch = 'all' | 'any'

export const RULE_OPS: readonly RuleOp[] = [
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'empty',
  'not_empty',
]
export const RULE_ACTIONS: readonly RuleAction[] = ['show', 'hide', 'require']

/**
 * Operators that compare against an operand. `empty`/`not_empty` are unary — a
 * valued op with a missing operand is a half-built rule and must never match
 * (the Python evaluator gates the same set).
 */
const VALUED_OPS: ReadonlySet<string> = new Set([
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
])

/** Anything a form field can hold, on the wire or in renderer state. */
export type AnswerValue = string | number | boolean | string[] | null | undefined

export interface RuleCondition {
  /** Field id whose answer is being tested. */
  field: string
  op: RuleOp
  /** Omitted for empty/not_empty. */
  value?: AnswerValue
}

export interface RuleLogic {
  when?: RuleCondition[] | null
  /** Defaults to 'all'. */
  match?: RuleMatch | null
  action: RuleAction
}

/** The wire shape: one `question_rules` row. */
export interface QuestionRule {
  id: string
  target_field_id: string
  logic: RuleLogic
}

/**
 * What the evaluator actually accepts. DB rows nest `logic`; hand-written rules
 * (tests, seeds, the builder's local preview) may inline it next to the target.
 * Malformed entries are skipped rather than thrown — one bad row must not blank
 * a live call for papers.
 */
export type RuleInput = Partial<QuestionRule> & Partial<RuleLogic> & { target?: string | null }

export type AnswerMap = Record<string, AnswerValue>

export interface FieldRuleState {
  visible: boolean
  /** `true` when a matched 'require' rule forces it; null = use the field's own flag. */
  requiredOverride: boolean | null
}

/** Field id → state. Only fields some rule targets appear here. */
export type RuleStates = Record<string, FieldRuleState>

/** What an untargeted field looks like: on screen, required as authored. */
export const DEFAULT_FIELD_STATE: Readonly<FieldRuleState> = Object.freeze({
  visible: true,
  requiredOverride: null,
})

// --- coercion (mirrors question_rules.py) ---------------------------------

const TRUTHY = new Set(['true', 'yes', '1', 'on', 'checked'])
const FALSY = new Set(['false', 'no', '0', 'off', 'unchecked', ''])

function isNullish(value: AnswerValue): value is null | undefined {
  return value === null || value === undefined
}

/**
 * Blank for empty/not_empty: missing, `false`, whitespace-only, or an empty
 * list. An unchecked checkbox is blank — that is what makes "you must accept
 * the code of conduct" expressible. `0` is a real answer and is NOT blank.
 */
export function isBlankAnswer(value: AnswerValue): boolean {
  if (isNullish(value)) return true
  if (typeof value === 'boolean') return value === false
  if (typeof value === 'number') return false
  if (Array.isArray(value)) return value.length === 0
  return value.trim() === ''
}

/** Loose truthiness. `null` = "this value is not a boolean in any reading". */
function toBool(value: AnswerValue): boolean | null {
  if (typeof value === 'boolean') return value
  if (isNullish(value)) return false
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (TRUTHY.has(text)) return true
    if (FALSY.has(text)) return false
    return null
  }
  if (typeof value === 'number') return value !== 0
  return null
}

/**
 * Numeric reading, or null. Booleans are deliberately excluded — `gt` against a
 * checkbox is a builder mistake, not a comparison — and so is a blank string,
 * which `Number('')` would otherwise turn into a very convincing 0.
 */
function toNumber(value: AnswerValue): number | null {
  if (typeof value === 'boolean' || isNullish(value)) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return null
  const text = value.trim()
  if (text === '') return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Equality across the type sloppiness of an HTML form: a checkbox arrives as
 * `true` from this renderer and as `"true"` from a hand-rolled POST; a number
 * field arrives as `"30"` and is compared against `30`. Text comparison is
 * trimmed but case-SENSITIVE — select options are exact values, and "Talk" and
 * "talk" can legitimately be two different choices.
 */
export function looseEquals(left: AnswerValue, right: AnswerValue): boolean {
  if (isNullish(left) && isNullish(right)) return true
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    const asLeft = toBool(left)
    const asRight = toBool(right)
    return asLeft !== null && asRight !== null && asLeft === asRight
  }
  if (isNullish(left) || isNullish(right)) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    return left.length === right.length && left.every((item, i) => item === right[i])
  }
  const numLeft = toNumber(left)
  const numRight = toNumber(right)
  if (numLeft !== null && numRight !== null) return numLeft === numRight
  return String(left).trim() === String(right).trim()
}

/** `contains` over both multi-selects (membership) and text (substring). */
function looseContains(haystack: AnswerValue, needle: AnswerValue): boolean {
  if (isNullish(haystack)) return false
  if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle))
  // A conditionless operand is a builder bug; never matching is the safe read.
  if (isNullish(needle)) return false
  return String(haystack).toLowerCase().includes(String(needle).trim().toLowerCase())
}

function numericCompare(
  op: 'gt' | 'gte' | 'lt' | 'lte',
  answer: AnswerValue,
  expected: AnswerValue
): boolean {
  const left = toNumber(answer)
  const right = toNumber(expected)
  if (left === null || right === null) return false
  if (op === 'gt') return left > right
  if (op === 'gte') return left >= right
  if (op === 'lt') return left < right
  return left <= right
}

// --- evaluation -----------------------------------------------------------

/** One {field, op, value} clause against the current answers. */
export function evaluateCondition(condition: RuleCondition, answers: AnswerMap): boolean {
  if (!condition || typeof condition !== 'object') return false
  const answer = answers[condition.field]
  // A valued operator with no operand can't be a real comparison — fail closed,
  // in lockstep with the Python evaluator.
  if (VALUED_OPS.has(condition.op) && isNullish(condition.value)) return false
  switch (condition.op) {
    case 'eq':
      return looseEquals(answer, condition.value)
    case 'neq':
      return !looseEquals(answer, condition.value)
    case 'contains':
      return looseContains(answer, condition.value)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return numericCompare(condition.op, answer, condition.value)
    case 'empty':
      return isBlankAnswer(answer)
    case 'not_empty':
      return !isBlankAnswer(answer)
    default:
      // The builder rejects unknown ops on write, so anything here is legacy
      // data. Never matching is the safe reading.
      return false
  }
}

/**
 * Does this rule fire for these answers?
 *
 * A rule with no conditions never fires — in every match mode. `all([])` is
 * true in both JS and Python, which would make an empty `show` rule silently
 * pin a field visible and an empty `hide` rule erase it; neither is what a
 * half-filled builder row means.
 */
export function ruleMatches(logic: RuleLogic | null | undefined, answers: AnswerMap): boolean {
  const when = logic?.when
  if (!Array.isArray(when) || when.length === 0) return false
  return logic?.match === 'any'
    ? when.some((condition) => evaluateCondition(condition, answers))
    : when.every((condition) => evaluateCondition(condition, answers))
}

function logicOf(rule: RuleInput): RuleLogic {
  const logic = rule.logic
  return logic && typeof logic === 'object' ? logic : (rule as RuleLogic)
}

function targetOf(rule: RuleInput): string | null {
  const target = rule.target_field_id || rule.target
  return target ? String(target) : null
}

/** Resolve every rule-targeted field to its {visible, requiredOverride} verdict. */
export function evaluateRules(
  rules: ReadonlyArray<RuleInput | null | undefined> | null | undefined,
  answers: AnswerMap | null | undefined
): RuleStates {
  const resolved = answers ?? {}

  const byTarget = new Map<string, RuleLogic[]>()
  for (const rule of rules ?? []) {
    if (!rule || typeof rule !== 'object') continue
    const target = targetOf(rule)
    if (!target) continue
    const logics = byTarget.get(target)
    if (logics) logics.push(logicOf(rule))
    else byTarget.set(target, [logicOf(rule)])
  }

  const states: RuleStates = {}
  for (const [target, logics] of byTarget) {
    const matched = (action: RuleAction) =>
      logics.some((logic) => logic?.action === action && ruleMatches(logic, resolved))

    let visible = true
    if (logics.some((logic) => logic?.action === 'show')) visible = matched('show')
    if (matched('hide')) visible = false

    states[target] = { visible, requiredOverride: matched('require') ? true : null }
  }
  return states
}

// --- lookups the renderer uses -------------------------------------------

export function fieldRuleState(states: RuleStates, fieldId: string): FieldRuleState {
  return states[fieldId] ?? DEFAULT_FIELD_STATE
}

export function isFieldVisible(states: RuleStates, fieldId: string): boolean {
  return fieldRuleState(states, fieldId).visible
}

/** Effective required flag: a matched `require` rule wins, else the field's own. */
export function isFieldRequired(states: RuleStates, fieldId: string, baseRequired = false): boolean {
  const override = fieldRuleState(states, fieldId).requiredOverride
  return override === null ? baseRequired : override
}

/**
 * Drop answers belonging to hidden fields.
 *
 * A speaker can answer a question and then take a branch that hides it. That
 * residue must reach neither validation nor the submission payload, or the
 * organizer ends up reading an answer to a question nobody was asked — the
 * server enforces the same thing in `validate_submission`.
 */
export function visibleAnswers<T extends AnswerValue>(
  answers: Record<string, T>,
  states: RuleStates
): Record<string, T> {
  const kept: Record<string, T> = {}
  for (const [fieldId, value] of Object.entries(answers)) {
    if (isFieldVisible(states, fieldId)) kept[fieldId] = value
  }
  return kept
}
