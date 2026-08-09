import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  Lock,
  Mail,
  RotateCcw,
  UserPlus,
  X,
} from 'lucide-react'

import {
  getPublicForm,
  requestManageLink,
  submitPublicForm,
  type CoSpeakerInput,
  type FormFieldOption,
  type PublicFormField,
  type SubmissionInput,
  type SubmissionReceipt,
} from '@/lib/api'
import {
  evaluateRules,
  isFieldRequired,
  isFieldVisible,
  visibleAnswers,
  type RuleStates,
} from '@/lib/rules'
import { stripUnsafeHtml } from '@/lib/sanitize'
import { Button } from '@/ui/button'
import { Checkbox } from '@/ui/checkbox'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'
import { Skeleton } from '@/ui/skeleton'
import { Textarea } from '@/ui/textarea'

type AnswerValue = string | boolean
type Answers = Record<string, AnswerValue>

function normalizeOptions(options: PublicFormField['options']): FormFieldOption[] {
  if (!options) return []
  return options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
}

function isBlank(value: AnswerValue | undefined): boolean {
  if (value === undefined) return true
  if (typeof value === 'boolean') return value === false
  return value.trim() === ''
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// --- co-speakers ----------------------------------------------------------
// A talk is often co-presented, and the CFP is where that gets said — otherwise
// the co-presenter only exists in the abstract's prose and an organizer has to
// re-key them by hand. Each row becomes a contact on the event and a 'speaker'
// participant on the session; the submitter stays the primary. Three is the
// ceiling the backend enforces too.
const MAX_CO_SPEAKERS = 3

type CoSpeaker = CoSpeakerInput

function emptyCoSpeaker(): CoSpeaker {
  return { first_name: '', last_name: '', email: '' }
}

function coSpeakerIsBlank(row: CoSpeaker): boolean {
  return !row.first_name.trim() && !row.last_name.trim() && !row.email.trim()
}

/** The rows worth sending: a half-typed row the speaker abandoned is not one. */
function filledCoSpeakers(rows: CoSpeaker[]): CoSpeaker[] {
  return rows.filter((row) => !coSpeakerIsBlank(row))
}

// --- draft persistence ----------------------------------------------------
// A CFP proposal is a lot of typing. We autosave the in-progress form to
// localStorage keyed by slug so a refresh, a closed tab, or a "let me finish
// tomorrow" never loses it. The draft is cleared the moment a submit succeeds.

interface FormDraft {
  firstName: string
  lastName: string
  email: string
  title: string
  answers: Answers
  coSpeakers: CoSpeaker[]
  /** When the autosave last wrote — what the resume banner dates the draft by. */
  savedAt?: string | null
}

/** Co-speaker rows out of localStorage — anything else on disk is ignored. */
function readStoredCoSpeakers(raw: unknown): CoSpeaker[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, MAX_CO_SPEAKERS)
    .map((entry) => {
      const row = (entry ?? {}) as Partial<CoSpeaker>
      return {
        first_name: typeof row.first_name === 'string' ? row.first_name : '',
        last_name: typeof row.last_name === 'string' ? row.last_name : '',
        email: typeof row.email === 'string' ? row.email : '',
      }
    })
}

function draftStorageKey(slug: string): string {
  return `dais.cfp-draft:${slug}`
}

function readStoredDraft(key: string): FormDraft | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<FormDraft>
    return {
      firstName: typeof parsed.firstName === 'string' ? parsed.firstName : '',
      lastName: typeof parsed.lastName === 'string' ? parsed.lastName : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      answers: parsed.answers && typeof parsed.answers === 'object' ? (parsed.answers as Answers) : {},
      coSpeakers: readStoredCoSpeakers(parsed.coSpeakers),
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    }
  } catch {
    return null
  }
}

/** "2 hours ago" for the resume banner; null for a draft saved by an older build. */
function draftAge(savedAt: string | null | undefined): string | null {
  if (!savedAt) return null
  try {
    return formatDistanceToNow(parseISO(savedAt), { addSuffix: true })
  } catch {
    return null
  }
}

function draftHasContent(draft: FormDraft | null): boolean {
  if (!draft) return false
  if (draft.firstName || draft.lastName || draft.email || draft.title) return true
  if (filledCoSpeakers(draft.coSpeakers ?? []).length > 0) return true
  return Object.values(draft.answers).some((value) =>
    typeof value === 'boolean' ? value : String(value ?? '').trim() !== ''
  )
}

// --- deadline formatting --------------------------------------------------

function formatDeadline(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

/** Human "closes in N days" phrasing from a future deadline. */
function countdownLabel(date: Date): string {
  const ms = date.getTime() - Date.now()
  if (ms <= 0) return 'Closed'
  const days = Math.floor(ms / 86_400_000)
  if (days >= 2) return `Closes in ${days} days`
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 2) return `Closes in ${hours} hours`
  return 'Closing soon'
}

export function PublicForm() {
  const { slug = '' } = useParams()

  const formQuery = useQuery({
    queryKey: ['public-form', slug],
    queryFn: () => getPublicForm(slug),
    enabled: Boolean(slug),
    retry: false,
  })

  const form = formQuery.data
  const fields = useMemo(() => {
    const list = form?.fields ?? []
    return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }, [form])

  const draftKey = draftStorageKey(slug)
  // Read any saved draft ONCE, synchronously, so state starts hydrated and the
  // persist effect below never clobbers it on the first render.
  const [initialDraft] = useState(() => readStoredDraft(draftKey))

  const [firstName, setFirstName] = useState(initialDraft?.firstName ?? '')
  const [lastName, setLastName] = useState(initialDraft?.lastName ?? '')
  const [email, setEmail] = useState(initialDraft?.email ?? '')
  const [title, setTitle] = useState(initialDraft?.title ?? '')
  const [answers, setAnswers] = useState<Answers>(initialDraft?.answers ?? {})
  const [coSpeakers, setCoSpeakers] = useState<CoSpeaker[]>(initialDraft?.coSpeakers ?? [])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null)
  // A draft found on load is applied to the fields immediately, but it is also
  // ANNOUNCED: a speaker coming back days later gets an explicit "resume or
  // clear" choice rather than a page that quietly looks half-filled (CFP-07).
  const [draftPrompt, setDraftPrompt] = useState(() => draftHasContent(initialDraft))
  const [draftResumed, setDraftResumed] = useState(false)
  // Whether the current in-progress form is persisted — drives the visible
  // "Draft saved" affordance so a speaker can trust they can finish later.
  const [draftSaved, setDraftSaved] = useState(() => draftHasContent(initialDraft))
  // How old the draft we found was, frozen at mount so it doesn't tick while
  // the speaker reads the banner.
  const [foundDraftAge] = useState(() => draftAge(initialDraft?.savedAt))
  const formRef = useRef<HTMLFormElement>(null)

  // Autosave: mirror the in-progress form to localStorage on every change (with
  // the time it was written, so a later visit can say how old it is), and drop
  // the key once the form is empty. Stops the moment a submit succeeds.
  useEffect(() => {
    if (receipt) return
    const draft: FormDraft = { firstName, lastName, email, title, answers, coSpeakers }
    try {
      if (draftHasContent(draft)) {
        window.localStorage.setItem(
          draftKey,
          JSON.stringify({ ...draft, savedAt: new Date().toISOString() })
        )
        setDraftSaved(true)
      } else {
        window.localStorage.removeItem(draftKey)
        setDraftSaved(false)
      }
    } catch {
      // Private-mode Safari and friends — autosave is a nicety, not load-bearing.
    }
  }, [firstName, lastName, email, title, answers, coSpeakers, draftKey, receipt])

  /** Take the banner's offer: the values are already in the fields, so this
   * dismisses the prompt and puts the speaker back at the form. */
  function resumeDraft() {
    setDraftPrompt(false)
    setDraftResumed(true)
    formRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  function clearDraft() {
    try {
      window.localStorage.removeItem(draftKey)
    } catch {
      // ignore
    }
    setFirstName('')
    setLastName('')
    setEmail('')
    setTitle('')
    setAnswers({})
    setCoSpeakers([])
    setErrors({})
    setDraftPrompt(false)
    setDraftResumed(false)
    setDraftSaved(false)
  }

  function addCoSpeaker() {
    setCoSpeakers((prev) => (prev.length >= MAX_CO_SPEAKERS ? prev : [...prev, emptyCoSpeaker()]))
  }

  function removeCoSpeaker(index: number) {
    setCoSpeakers((prev) => prev.filter((_, i) => i !== index))
    // Row indexes shift on removal, so stale per-row errors would land on the
    // wrong row. Drop them all; the next submit recomputes them.
    setErrors((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([key]) => !key.startsWith('co_speaker_'))
      )
      return next
    })
  }

  function setCoSpeakerField(index: number, key: keyof CoSpeaker, value: string) {
    setCoSpeakers((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)))
    setErrors((prev) => {
      const errorKey = `co_speaker_${index}_${key}`
      if (!prev[errorKey]) return prev
      const { [errorKey]: _removed, ...rest } = prev
      return rest
    })
  }

  // Conditional logic, re-resolved on every keystroke that changes an answer.
  // Same evaluator the server runs at submit time (lib/rules.ts ↔
  // api/services/question_rules.py), so what a speaker sees is what validates.
  const ruleStates: RuleStates = useMemo(
    () => evaluateRules(form?.question_rules, answers),
    [form?.question_rules, answers]
  )

  // Hidden fields unmount entirely: they are not rendered, not validated, and
  // their answers never reach the payload.
  const visibleFields = useMemo(
    () => fields.filter((field) => isFieldVisible(ruleStates, field.id)),
    [fields, ruleStates]
  )

  const submit = useMutation({
    mutationFn: (payload: SubmissionInput) => submitPublicForm(slug, payload),
    onSuccess: (data) => {
      // The draft has served its purpose — clear it so a later visit starts fresh.
      try {
        window.localStorage.removeItem(draftKey)
      } catch {
        // ignore
      }
      setDraftPrompt(false)
      setDraftResumed(false)
      setReceipt(data ?? { id: '' })
    },
  })

  function setAnswer(id: string, value: AnswerValue) {
    setAnswers((prev) => ({ ...prev, [id]: value }))
    setErrors((prev) => {
      if (!prev[id]) return prev
      const { [id]: _removed, ...rest } = prev
      return rest
    })
  }

  function validate(): Record<string, string> {
    const next: Record<string, string> = {}
    if (!firstName.trim()) next.first_name = 'Required'
    if (!lastName.trim()) next.last_name = 'Required'
    if (!email.trim()) next.email = 'Required'
    else if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address'

    // A co-speaker is identified by email — a row with a name but no address
    // can't become a contact, so it's an error rather than a silent drop. The
    // backend re-checks all of this; the browser is not a trusted validator.
    const seenEmails = new Set<string>([email.trim().toLowerCase()])
    coSpeakers.forEach((row, index) => {
      if (coSpeakerIsBlank(row)) return
      const key = `co_speaker_${index}_email`
      const address = row.email.trim().toLowerCase()
      if (!address) next[key] = 'Required — a co-speaker is identified by email'
      else if (!EMAIL_RE.test(address)) next[key] = 'Enter a valid email address'
      else if (seenEmails.has(address)) next[key] = 'This email is already on this proposal'
      else seenEmails.add(address)
    })

    if (!title.trim()) next.title = 'Required'

    for (const field of visibleFields) {
      const value = answers[field.id]
      if (isFieldRequired(ruleStates, field.id, Boolean(field.required)) && isBlank(value)) {
        next[field.id] = field.type === 'checkbox' ? 'Please confirm to continue' : 'Required'
        continue
      }
      if (field.type === 'email' && typeof value === 'string' && value.trim() && !EMAIL_RE.test(value.trim())) {
        next[field.id] = 'Enter a valid email address'
      }
    }
    return next
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const nextErrors = validate()
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      const firstId = Object.keys(nextErrors)[0]
      document.getElementById(firstId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    submit.mutate({
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      email: email.trim(),
      title: title.trim(),
      // A branch the speaker abandoned leaves no residue: answers to fields a
      // rule has since hidden are dropped here, exactly as the server drops
      // them in validate_submission.
      answers: visibleAnswers(answers, ruleStates),
      co_speakers: filledCoSpeakers(coSpeakers).map((row) => ({
        first_name: row.first_name.trim(),
        last_name: row.last_name.trim(),
        email: row.email.trim(),
      })),
    })
  }

  // --- states -------------------------------------------------------------

  if (formQuery.isPending) {
    return (
      <PublicShell>
        <div className="space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </PublicShell>
    )
  }

  if (formQuery.error || !form) {
    return (
      <PublicShell>
        <Notice
          tone="error"
          title="This form isn't available"
          description={formQuery.error?.message ?? 'Double-check the link you were sent.'}
        />
      </PublicShell>
    )
  }

  if (receipt) {
    return (
      <PublicShell eyebrow={form.event_name ?? undefined}>
        <div className="flex flex-col items-center py-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success/12">
            <CheckCircle2 className="h-7 w-7 text-success-strong" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">Submission received</h1>
          <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted-foreground">
            Thanks{firstName ? `, ${firstName}` : ''}. We&rsquo;ve emailed a copy to {email}. You can
            reference this submission with the code below.
          </p>
          {(receipt.friendly_id || title) && (
            <div className="mt-6 w-full max-w-sm rounded-lg border border-border bg-muted/50 px-5 py-4 text-left">
              {receipt.friendly_id && (
                <>
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Reference
                  </div>
                  <div className="mt-1 font-mono text-xl font-semibold text-foreground">
                    {receipt.friendly_id}
                  </div>
                </>
              )}
              {title && (
                <div className={receipt.friendly_id ? 'mt-3' : undefined}>
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Title
                  </div>
                  <div className="mt-1 text-[15px] font-medium text-foreground">{title}</div>
                </div>
              )}
            </div>
          )}
          {form.confirmation_html && (
            <div
              className="rich-text mt-6 max-w-lg text-left"
              dangerouslySetInnerHTML={{ __html: stripUnsafeHtml(form.confirmation_html) }}
            />
          )}
          <div className="mt-8 w-full max-w-sm border-t border-border pt-6">
            {receipt.manage_token ? (
              <ManageLinkReady slug={slug} token={receipt.manage_token} />
            ) : (
              <ManageLinkPrompt slug={slug} />
            )}
          </div>
        </div>
      </PublicShell>
    )
  }

  if (form.closed) {
    const closedAt = form.close_at ? new Date(form.close_at) : null
    return (
      <PublicShell eyebrow={form.event_name ?? undefined}>
        <div className="flex flex-col items-center py-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Lock className="h-6 w-6 text-muted-foreground" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">Submissions are closed</h1>
          <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted-foreground">
            {form.name} is no longer accepting submissions
            {closedAt ? ` — the deadline was ${formatDeadline(closedAt)}.` : '.'}
          </p>
          <div className="mt-8 w-full max-w-sm border-t border-border pt-6 text-left">
            <p className="mb-3 text-center text-sm text-muted-foreground">
              Already submitted? You can still view your submissions.
            </p>
            <ManageLinkPrompt slug={slug} />
          </div>
        </div>
      </PublicShell>
    )
  }

  // --- form ---------------------------------------------------------------

  // Optional per-user cap, surfaced by the public-form adapter in lib/api.ts.
  const submissionLimit = form.submission_limit ?? null
  const closeAt = form.close_at ? new Date(form.close_at) : null

  return (
    <PublicShell eyebrow={form.event_name ?? undefined}>
      {submissionLimit != null && (
        <div className="mb-6 rounded-lg border border-border bg-card px-4 py-3 text-center text-sm font-medium text-foreground">
          Submission Limit: {submissionLimit} submission{submissionLimit === 1 ? '' : 's'} per user
        </div>
      )}
      {closeAt && (
        <div className="mb-6 flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary-subtle/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <CalendarClock className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-sm text-foreground">
              Submissions close <span className="font-semibold">{formatDeadline(closeAt)}</span>
            </span>
          </div>
          <span className="text-xs font-semibold uppercase tracking-wide text-primary">
            {countdownLabel(closeAt)}
          </span>
        </div>
      )}
      {/* The unfinished-draft handoff (CFP-07): loud, dated, and two-way — the
          fields are already refilled, so "Resume" just returns you to them and
          "Clear draft" throws the whole thing away. */}
      {draftPrompt && (
        <div
          role="status"
          data-testid="resume-draft-banner"
          className="mb-6 flex flex-col gap-4 rounded-xl border border-primary/30 bg-primary-subtle/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
              <RotateCcw className="h-4 w-4" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-foreground">
                {foundDraftAge
                  ? `Draft restored — you have an unfinished draft from ${foundDraftAge}`
                  : 'Draft restored — you have an unfinished draft'}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Everything you typed on this device is back in the form below. Pick up where you
                left off, or clear it and start fresh.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" data-testid="resume-draft" onClick={resumeDraft}>
              Resume draft
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="discard-draft"
              title="Discard this draft and start fresh"
              onClick={clearDraft}
            >
              Clear draft
            </Button>
          </div>
        </div>
      )}
      {draftResumed && (
        <div
          role="status"
          data-testid="draft-resumed-note"
          className="mb-6 flex flex-col gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Check className="h-4 w-4 shrink-0 text-success-strong" />
            Draft restored — you&rsquo;re picking up where you left off.
          </p>
          <button
            type="button"
            data-testid="discard-draft"
            onClick={clearDraft}
            className="self-start text-sm font-medium text-primary hover:underline sm:self-auto"
          >
            Clear draft
          </button>
        </div>
      )}
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">{form.name}</h1>
      {form.welcome_html && (
        <div
          className="rich-text mt-4"
          dangerouslySetInnerHTML={{ __html: stripUnsafeHtml(form.welcome_html) }}
        />
      )}

      <form ref={formRef} onSubmit={handleSubmit} noValidate className="mt-8 space-y-8">
        <section className="space-y-5">
          <SectionHeading title="About you" />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="first_name" label="First name" required error={errors.first_name}>
              <Input
                id="first_name"
                value={firstName}
                autoComplete="given-name"
                aria-invalid={errors.first_name ? true : undefined}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>
            <Field id="last_name" label="Last name" required error={errors.last_name}>
              <Input
                id="last_name"
                value={lastName}
                autoComplete="family-name"
                aria-invalid={errors.last_name ? true : undefined}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>
          </div>
          <Field id="email" label="Email" required error={errors.email}>
            <Input
              id="email"
              type="email"
              value={email}
              autoComplete="email"
              aria-invalid={errors.email ? true : undefined}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        </section>

        <section className="space-y-4">
          <SectionHeading title="Co-speakers" />
          <p className="-mt-1 text-sm text-muted-foreground">
            Presenting with someone? Add them here and they&rsquo;ll be listed on the session.
            Optional — up to {MAX_CO_SPEAKERS}.
          </p>

          {coSpeakers.map((row, index) => (
            <div
              key={index}
              data-testid={`co-speaker-row-${index}`}
              className="space-y-4 rounded-lg border border-border bg-muted/30 p-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">Co-speaker {index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeCoSpeaker(index)}
                  data-testid={`remove-co-speaker-${index}`}
                  aria-label={`Remove co-speaker ${index + 1}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                  Remove
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={`co_speaker_${index}_first_name`} label="First name">
                  <Input
                    id={`co_speaker_${index}_first_name`}
                    value={row.first_name}
                    autoComplete="off"
                    onChange={(e) => setCoSpeakerField(index, 'first_name', e.target.value)}
                  />
                </Field>
                <Field id={`co_speaker_${index}_last_name`} label="Last name">
                  <Input
                    id={`co_speaker_${index}_last_name`}
                    value={row.last_name}
                    autoComplete="off"
                    onChange={(e) => setCoSpeakerField(index, 'last_name', e.target.value)}
                  />
                </Field>
              </div>
              <Field
                id={`co_speaker_${index}_email`}
                label="Email"
                error={errors[`co_speaker_${index}_email`]}
              >
                <Input
                  id={`co_speaker_${index}_email`}
                  type="email"
                  value={row.email}
                  autoComplete="off"
                  placeholder="cospeaker@example.com"
                  aria-invalid={errors[`co_speaker_${index}_email`] ? true : undefined}
                  onChange={(e) => setCoSpeakerField(index, 'email', e.target.value)}
                />
              </Field>
            </div>
          ))}

          {coSpeakers.length < MAX_CO_SPEAKERS ? (
            <Button
              type="button"
              variant="secondary"
              onClick={addCoSpeaker}
              data-testid="add-co-speaker"
            >
              <UserPlus className="h-4 w-4" />
              Add a co-speaker
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              That&rsquo;s the maximum of {MAX_CO_SPEAKERS} co-speakers.
            </p>
          )}
        </section>

        <section className="space-y-5">
          <SectionHeading title="Your session" />
          <Field id="title" label="Session title" required error={errors.title}>
            <Input
              id="title"
              value={title}
              maxLength={300}
              aria-invalid={errors.title ? true : undefined}
              onChange={(e) => {
                setTitle(e.target.value)
                setErrors((prev) => {
                  if (!prev.title) return prev
                  const { title: _removed, ...rest } = prev
                  return rest
                })
              }}
            />
          </Field>
          {visibleFields.map((field) => {
            // Rule-targeted fields fade in when a branch opens; fields nobody
            // conditions on render plainly, so a first paint isn't an animation
            // of the whole form.
            const conditional = Boolean(ruleStates[field.id])
            return (
              <div
                key={field.id}
                className={
                  conditional
                    ? 'animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out'
                    : undefined
                }
              >
                <FormField
                  field={field}
                  value={answers[field.id]}
                  required={isFieldRequired(ruleStates, field.id, Boolean(field.required))}
                  error={errors[field.id]}
                  onChange={(value) => setAnswer(field.id, value)}
                />
              </div>
            )
          })}
        </section>

        {submit.error && (
          <Notice tone="error" title="We couldn't submit that" description={submit.error.message} />
        )}

        <div className="flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Fields marked <span className="form-required-asterisk">*</span> are required.
            </p>
            {draftSaved && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Check className="h-3.5 w-3.5 text-success-strong" />
                Draft saved automatically — you can finish later on this device.
              </p>
            )}
          </div>
          <Button type="submit" size="lg" className="rounded-full px-7" disabled={submit.isPending}>
            {submit.isPending ? 'Submitting…' : 'Submit proposal'}
            {!submit.isPending && <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
      </form>
    </PublicShell>
  )
}

// --- pieces ---------------------------------------------------------------

function PublicShell({ children, eyebrow }: { children: ReactNode; eyebrow?: string }) {
  return (
    <div className="min-h-screen bg-[#FBFBFB]">
      <div className="mx-auto w-full max-w-[920px] px-5 py-10 sm:py-16">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            d
          </div>
          <span className="text-sm font-semibold tracking-tight text-foreground">dais</span>
          {eyebrow && (
            <>
              <span className="text-border">/</span>
              <span className="truncate text-sm text-muted-foreground">{eyebrow}</span>
            </>
          )}
        </div>
        <div className="rounded-2xl border border-border bg-card p-6 shadow-[0_10px_30px_rgba(15,23,42,0.08)] sm:p-10">
          {children}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">Powered by dais</p>
      </div>
    </div>
  )
}

function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
  )
}

function Field({
  id,
  label,
  required,
  help,
  error,
  children,
}: {
  id: string
  label: string
  required?: boolean
  help?: string | null
  error?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {children}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

function FormField({
  field,
  value,
  required,
  error,
  onChange,
}: {
  field: PublicFormField
  value: AnswerValue | undefined
  /** Effective required flag — a matched `require` rule can promote a field. */
  required?: boolean
  error?: string
  onChange: (value: AnswerValue) => void
}) {
  const invalid = error ? true : undefined
  const isRequired = required ?? Boolean(field.required)

  if (field.type === 'checkbox') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-start gap-2.5">
          <Checkbox
            id={field.id}
            checked={value === true}
            onCheckedChange={(checked) => onChange(checked === true)}
            className="mt-0.5"
          />
          <Label htmlFor={field.id} required={isRequired} className="leading-snug">
            {field.label}
          </Label>
        </div>
        {field.help_text && <p className="pl-6 text-xs text-muted-foreground">{field.help_text}</p>}
        {error && <p className="pl-6 text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  if (field.type === 'select') {
    const options = normalizeOptions(field.options)
    return (
      <Field id={field.id} label={field.label} required={isRequired} help={field.help_text} error={error}>
        <NativeSelect
          id={field.id}
          value={typeof value === 'string' ? value : ''}
          onValueChange={onChange}
          options={options}
          placeholder={field.placeholder ?? 'Select an option'}
          required={isRequired}
          aria-invalid={invalid}
        />
      </Field>
    )
  }

  if (field.type === 'textarea') {
    return (
      <Field id={field.id} label={field.label} required={isRequired} help={field.help_text} error={error}>
        <Textarea
          id={field.id}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder ?? undefined}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    )
  }

  // text, email, and anything unrecognized: render as a single-line input.
  return (
    <Field id={field.id} label={field.label} required={isRequired} help={field.help_text} error={error}>
      <Input
        id={field.id}
        type={field.type === 'email' ? 'email' : 'text'}
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder ?? undefined}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

function Notice({ title, description }: { tone: 'error'; title: string; description?: string }) {
  return (
    <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  )
}

/**
 * In-app manage link shown on the confirmation screen.
 *
 * The submit response carried this submitter's OWN token (minted server-side
 * because they just proved ownership by submitting from that email), so we can
 * offer a real, clickable AND copyable manage link with NO dependence on email
 * delivery. A blind submitter reaches view / edit / withdraw in the same
 * session, even when the sending domain is unverified. The "email me the link"
 * path stays available below as a secondary option.
 */
function ManageLinkReady({ slug, token }: { slug: string; token: string }) {
  const managePath = `/submit/${slug}/manage?token=${encodeURIComponent(token)}`
  // A same-origin absolute URL so it is copyable and always opens THIS
  // deployment — it never depends on a server-configured frontend URL.
  const manageUrl =
    typeof window !== 'undefined' ? `${window.location.origin}${managePath}` : managePath
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(manageUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked or unavailable — the field is selectable as a fallback.
    }
  }

  return (
    <div className="space-y-3 text-left">
      <div>
        <p className="text-sm font-semibold text-foreground">Manage your submissions</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          View, edit, or withdraw what you submitted — no email needed. Save this private link.
        </p>
      </div>
      <Button asChild size="lg" className="w-full rounded-full">
        <Link to={managePath}>
          Manage or edit your submissions
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
      <div className="flex gap-2">
        <Input
          readOnly
          value={manageUrl}
          aria-label="Your private manage link"
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button type="button" variant="secondary" onClick={copy} className="shrink-0">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <details className="pt-1">
        <summary className="cursor-pointer list-none text-xs font-medium text-primary hover:underline">
          Prefer a link by email instead?
        </summary>
        <div className="mt-3">
          <ManageLinkPrompt slug={slug} />
        </div>
      </details>
    </div>
  )
}

/**
 * "Manage my submissions": collect the submitter's email and ask the backend to
 * mail a magic link. The backend always returns the same generic 200, so this
 * never reveals whether the address has any submissions — we show the same
 * "check your email" message regardless.
 */
function ManageLinkPrompt({ slug }: { slug: string }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (value: string) => requestManageLink(slug, value),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!EMAIL_RE.test(trimmed)) {
      setError('Enter a valid email address')
      return
    }
    setError(null)
    mutation.mutate(trimmed)
  }

  if (mutation.isSuccess) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-left">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-success-strong" />
        <p className="text-sm text-foreground">
          {mutation.data?.message ??
            'Check your email for a link to view, edit, or withdraw your submissions.'}
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-2 text-left">
      <Label htmlFor="manage-email">Manage my submissions</Label>
      <p className="text-xs text-muted-foreground">
        Enter your email and we&rsquo;ll send a private link to view, edit, or withdraw your submissions.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="manage-email"
          type="email"
          value={email}
          placeholder="you@example.com"
          autoComplete="email"
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setEmail(e.target.value)
            if (error) setError(null)
          }}
        />
        <Button type="submit" disabled={mutation.isPending} className="shrink-0">
          {mutation.isPending ? 'Sending…' : 'Send link'}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {mutation.error && (
        <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
      )}
    </form>
  )
}
