import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

import {
  getPublicForm,
  submitPublicForm,
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
import { Button } from '@/ui/button'
import { Checkbox } from '@/ui/checkbox'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select'
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

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [answers, setAnswers] = useState<Answers>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null)

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
    onSuccess: (data) => setReceipt(data ?? { id: '' }),
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
            Thanks, {firstName}. We&rsquo;ve emailed a copy to {email}. You can reference this submission
            with the code below.
          </p>
          {receipt.friendly_id && (
            <div className="mt-6 rounded-lg border border-border bg-muted/50 px-5 py-4">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Reference
              </div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">
                {receipt.friendly_id}
              </div>
            </div>
          )}
          {form.confirmation_html && (
            <div
              className="rich-text mt-6 max-w-lg text-left"
              dangerouslySetInnerHTML={{ __html: form.confirmation_html }}
            />
          )}
        </div>
      </PublicShell>
    )
  }

  if (form.closed) {
    return (
      <PublicShell eyebrow={form.event_name ?? undefined}>
        <Notice
          tone="error"
          title={`${form.name} is closed`}
          description="This call for papers is no longer accepting submissions."
        />
      </PublicShell>
    )
  }

  // --- form ---------------------------------------------------------------

  return (
    <PublicShell eyebrow={form.event_name ?? undefined}>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">{form.name}</h1>
      {form.welcome_html && (
        <div className="rich-text mt-4" dangerouslySetInnerHTML={{ __html: form.welcome_html }} />
      )}

      <form onSubmit={handleSubmit} noValidate className="mt-8 space-y-8">
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
          <p className="text-xs text-muted-foreground">
            Fields marked <span className="form-required-asterisk">*</span> are required.
          </p>
          <Button type="submit" size="lg" disabled={submit.isPending}>
            {submit.isPending ? 'Submitting…' : 'Submit proposal'}
          </Button>
        </div>
      </form>
    </PublicShell>
  )
}

// --- pieces ---------------------------------------------------------------

function PublicShell({ children, eyebrow }: { children: ReactNode; eyebrow?: string }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-16">
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
        <div className="rounded-xl border border-border bg-card p-6 shadow-soft sm:p-10">{children}</div>
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
        <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
          <SelectTrigger id={field.id} aria-invalid={invalid}>
            <SelectValue placeholder={field.placeholder ?? 'Select an option'} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label ?? option.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
