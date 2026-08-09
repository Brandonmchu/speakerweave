import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDownWideNarrow,
  BellRing,
  CalendarClock,
  Check,
  ClipboardCheck,
  Layers,
  Link2,
  ListChecks,
  Mail,
  Plus,
  Send,
  Tags,
  Trash2,
  Users,
  X,
} from 'lucide-react'

import { listEvents } from '@/lib/adminApi'
import {
  addEvaluator,
  assignEvaluationSessions,
  assignReviewerToSubmission,
  createEvaluationPlan,
  criterionKind,
  deleteEvaluator,
  getEvaluationPlan,
  getEvaluationSummary,
  getPlanAssignments,
  getReviewerLinks,
  listEvaluationPlans,
  openEvaluationPlan,
  remindLaggingReviewers,
  unassignReviewerFromSubmission,
  updateEvaluationDecision,
  updateEvaluationPlan,
  updateEvaluator,
  type AssignableSubmission,
  type EvaluationAssignMode,
  type EvaluationCriterion,
  type EvaluationCriterionKind,
  type EvaluationPlan,
  type EvaluationPlanStatus,
  type EvaluationScale,
  type EvaluationSessionSummary,
  type EvaluationTrack,
  type Evaluator,
  type ReviewerAssignmentStatus,
} from '@/lib/evaluationApi'
import { CopyButton } from '@/pages/Forms'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Checkbox } from '@/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs'
import { Textarea } from '@/ui/textarea'
import { toast } from '@/ui/use-toast'

const STATUS_BADGE: Record<
  EvaluationPlanStatus,
  { label: string; variant: 'muted' | 'solid' | 'warning' }
> = {
  draft: { label: 'Draft', variant: 'muted' },
  open: { label: 'Open', variant: 'solid' },
  closed: { label: 'Closed', variant: 'warning' },
}

function PlanStatusBadge({ status }: { status: EvaluationPlanStatus }) {
  const meta = STATUS_BADGE[status]
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

/* ── review window ─────────────────────────────────────────────────────────
 * A plan says when reviewing opens and when it closes, and the server refuses
 * reviews outside that. Dates are formatted in UTC — the API stores the day the
 * organizer picked as midnight/end-of-day UTC, so anything else would show the
 * neighbouring day to half the world. */

function formatWindowDate(value?: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function reviewWindowLabel(window: {
  opens_at?: string | null
  closes_at?: string | null
}): string | null {
  const opens = formatWindowDate(window.opens_at)
  const closes = formatWindowDate(window.closes_at)
  if (opens && closes) return `Reviews open ${opens} – ${closes}`
  if (opens) return `Reviews open ${opens}`
  if (closes) return `Reviews close ${closes}`
  return null
}

/** An ISO instant as the yyyy-mm-dd a native date input wants. */
function toDateInputValue(value?: string | null): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toISOString().slice(0, 10)
}

function ReviewWindowNote({ plan }: { plan: EvaluationPlan }) {
  const label = reviewWindowLabel(plan)
  if (!label) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <CalendarClock className="h-3.5 w-3.5 text-primary" />
      {label}
    </span>
  )
}

/** Reviews open/close date pair, shared by the create dialog and the editor. */
function ReviewWindowFields({
  idPrefix,
  opensAt,
  closesAt,
  onOpensAtChange,
  onClosesAtChange,
}: {
  idPrefix: string
  opensAt: string
  closesAt: string
  onOpensAtChange: (value: string) => void
  onClosesAtChange: (value: string) => void
}) {
  const label = reviewWindowLabel({ opens_at: opensAt || null, closes_at: closesAt || null })
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium text-foreground">Review window</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Reviewers can only score between these dates. Leave a date empty for no limit.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reviews open" htmlFor={`${idPrefix}-opens-at`}>
          <Input
            id={`${idPrefix}-opens-at`}
            type="date"
            value={opensAt}
            onChange={(event) => onOpensAtChange(event.target.value)}
          />
        </Field>
        <Field label="Reviews close" htmlFor={`${idPrefix}-closes-at`}>
          <Input
            id={`${idPrefix}-closes-at`}
            type="date"
            value={closesAt}
            onChange={(event) => onClosesAtChange(event.target.value)}
          />
        </Field>
      </div>
      <p className="text-xs font-medium text-primary">
        {label ?? 'No window set — reviewers can score at any time.'}
      </p>
    </div>
  )
}

const TRACK_FALLBACK_COLOR = '#4962E2'

function TrackDot({ color }: { color?: string | null }) {
  return (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color || TRACK_FALLBACK_COLOR }}
    />
  )
}

/** A talk sits in one or more tracks; a reviewer covers one or more. Both read
 * as the same chip so the two lists are comparable at a glance. */
function TrackChips({ tracks, empty }: { tracks?: EvaluationTrack[] | null; empty?: ReactNode }) {
  if (!tracks || tracks.length === 0) return <>{empty ?? null}</>
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tracks.map((track) => (
        <span
          key={track.id}
          className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground"
        >
          <TrackDot color={track.color} />
          <span className="truncate">{track.name || 'Untitled track'}</span>
        </span>
      ))}
    </div>
  )
}

function AllTracksHint() {
  return <span className="text-xs text-muted-foreground">All tracks</span>
}

/** Multi-select over the event's tracks. Nothing selected = reviews all. */
function TrackPicker({
  tracks,
  value,
  onChange,
  disabled = false,
}: {
  tracks: EvaluationTrack[]
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tracks.map((track) => {
        const selected = value.includes(track.id)
        return (
          <button
            key={track.id}
            type="button"
            role="checkbox"
            aria-checked={selected}
            disabled={disabled}
            onClick={() =>
              onChange(
                selected ? value.filter((id) => id !== track.id) : [...value, track.id]
              )
            }
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50',
              selected
                ? 'border-primary bg-primary-subtle text-primary'
                : 'border-border bg-card text-muted-foreground hover:bg-accent'
            )}
          >
            <TrackDot color={track.color} />
            {track.name || 'Untitled track'}
            {selected && <Check className="h-3 w-3" />}
          </button>
        )
      })}
    </div>
  )
}

export function Evaluation() {
  const queryClient = useQueryClient()
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const eventsQuery = useQuery({ queryKey: ['events'], queryFn: listEvents })
  const event = eventsQuery.data?.[0]
  const plansQuery = useQuery({
    queryKey: ['evaluation-plans', event?.id],
    queryFn: () => listEvaluationPlans(event!.id),
    enabled: Boolean(event?.id),
  })
  const plans = useMemo(() => plansQuery.data ?? [], [plansQuery.data])

  useEffect(() => {
    if (!plans.length) {
      setSelectedPlanId(null)
      return
    }
    if (!selectedPlanId || !plans.some((plan) => plan.id === selectedPlanId)) {
      setSelectedPlanId(plans[0].id)
    }
  }, [plans, selectedPlanId])

  const detailQuery = useQuery({
    queryKey: ['evaluation-plan', selectedPlanId],
    queryFn: () => getEvaluationPlan(selectedPlanId!),
    enabled: Boolean(selectedPlanId),
  })

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['evaluation-plans', event?.id] }),
      queryClient.invalidateQueries({ queryKey: ['evaluation-plan', selectedPlanId] }),
      queryClient.invalidateQueries({ queryKey: ['evaluation-summary', selectedPlanId] }),
    ])
  }

  const error = eventsQuery.error ?? plansQuery.error
  const loading = eventsQuery.isPending || (Boolean(event) && plansQuery.isPending)

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <ClipboardCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Evaluation</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Build a review committee, collect consistent scores, and make the final call
              {event ? ` for ${event.name}` : ''}.
            </p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={!event}>
          <Plus />
          New plan
        </Button>
      </header>

      {error ? (
        <PageMessage
          icon={<AlertCircle className="h-6 w-6 text-destructive" />}
          title="Couldn't load evaluation plans"
          description={error.message}
          action={<Button onClick={() => plansQuery.refetch()}>Try again</Button>}
        />
      ) : loading ? (
        <EvaluationSkeleton />
      ) : !event ? (
        <PageMessage
          icon={<ListChecks className="h-6 w-6 text-muted-foreground" />}
          title="Create an event first"
          description="Evaluation plans live inside an event and draw from its pending submissions."
        />
      ) : plans.length === 0 ? (
        <PageMessage
          icon={<ClipboardCheck className="h-6 w-6 text-primary" />}
          title="No evaluation plan yet"
          description="Set the score criteria, invite your reviewers, and send each person a private review link."
          action={<Button onClick={() => setCreateOpen(true)}>Create the first plan</Button>}
        />
      ) : (
        <div className="mt-7 grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="self-start overflow-hidden rounded-lg border border-border bg-card shadow-soft lg:sticky lg:top-5">
            <div className="border-b border-border px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Plans
              </p>
            </div>
            <div className="divide-y divide-border">
              {plans.map((plan) => (
                <button
                  type="button"
                  key={plan.id}
                  onClick={() => setSelectedPlanId(plan.id)}
                  className={cn(
                    'w-full px-4 py-4 text-left transition-colors hover:bg-accent/60',
                    selectedPlanId === plan.id && 'bg-primary-subtle/70'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{plan.name}</span>
                    <PlanStatusBadge status={plan.status} />
                  </div>
                  <div className="mt-2 flex gap-3 text-xs tabular-nums text-muted-foreground">
                    <span>{plan.evaluator_count ?? 0} reviewers</span>
                    <span>{plan.review_count ?? 0}/{plan.assignment_count ?? 0} started</span>
                  </div>
                  {reviewWindowLabel(plan) && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CalendarClock className="h-3 w-3 shrink-0 text-primary" />
                      <span className="truncate">{reviewWindowLabel(plan)}</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </aside>

          <main className="min-w-0">
            {detailQuery.isPending ? (
              <PlanSkeleton />
            ) : detailQuery.error ? (
              <PageMessage
                icon={<AlertCircle className="h-6 w-6 text-destructive" />}
                title="Couldn't load this plan"
                description={detailQuery.error.message}
                action={<Button onClick={() => detailQuery.refetch()}>Try again</Button>}
              />
            ) : detailQuery.data ? (
              <PlanWorkspace detail={detailQuery.data} onRefresh={refresh} />
            ) : null}
          </main>
        </div>
      )}

      {event && (
        <CreatePlanDialog
          eventId={event.id}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(plan) => {
            setSelectedPlanId(plan.id)
            queryClient.invalidateQueries({ queryKey: ['evaluation-plans', event.id] })
          }}
        />
      )}
    </div>
  )
}

function CreatePlanDialog({
  eventId,
  open,
  onOpenChange,
  onCreated,
}: {
  eventId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (plan: EvaluationPlan) => void
}) {
  const [name, setName] = useState('Program committee')
  const [instructions, setInstructions] = useState('')
  const [scale, setScale] = useState<EvaluationScale>('1_5')
  const [anonymized, setAnonymized] = useState(false)
  const [opensAt, setOpensAt] = useState('')
  const [closesAt, setClosesAt] = useState('')
  const create = useMutation({
    mutationFn: () =>
      createEvaluationPlan(eventId, {
        name: name.trim(),
        instructions,
        scale,
        anonymized,
        opens_at: opensAt || null,
        closes_at: closesAt || null,
      }),
    onSuccess: (plan) => {
      onCreated(plan)
      onOpenChange(false)
      toast({ title: 'Evaluation plan created' })
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an evaluation plan</DialogTitle>
          <DialogDescription>
            Start with the default weighted criteria, then fine-tune them before inviting reviewers.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <Field label="Plan name" htmlFor="evaluation-plan-name">
            <Input
              id="evaluation-plan-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Reviewer instructions" htmlFor="evaluation-plan-instructions">
            <Textarea
              id="evaluation-plan-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="What should reviewers prioritize?"
            />
          </Field>
          <Field label="Score scale" htmlFor="evaluation-plan-scale">
            <NativeSelect
              id="evaluation-plan-scale"
              value={scale}
              onValueChange={(value) => setScale(value as EvaluationScale)}
              options={[
                { value: '1_5', label: '1–5' },
                { value: '1_10', label: '1–10' },
              ]}
            />
          </Field>
          <ReviewWindowFields
            idPrefix="new-plan"
            opensAt={opensAt}
            closesAt={closesAt}
            onOpensAtChange={setOpensAt}
            onClosesAtChange={setClosesAt}
          />
          <label className="flex items-start gap-3 rounded-md border border-border p-3">
            <Checkbox checked={anonymized} onCheckedChange={(value) => setAnonymized(value === true)} />
            <span>
              <span className="block text-sm font-medium text-foreground">Anonymized review</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Hide speaker names and profiles from the reviewer portal.
              </span>
            </span>
          </label>
          {create.error && <InlineError>{create.error.message}</InlineError>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PlanWorkspace({
  detail,
  onRefresh,
}: {
  detail: Awaited<ReturnType<typeof getEvaluationPlan>>
  onRefresh: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const { plan } = detail
  const tracks = detail.tracks ?? []
  const [tab, setTab] = useState('setup')
  const assign = useMutation({
    mutationFn: (mode: EvaluationAssignMode) => assignEvaluationSessions(plan.id, { mode }),
    onSuccess: async (result, mode) => {
      await onRefresh()
      toast({
        title: result.created
          ? mode === 'by_track'
            ? 'Sessions assigned by track'
            : 'Sessions assigned'
          : 'Assignments already up to date',
        description: `${result.total} assignments across ${result.session_count} sessions.`,
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Assignment failed', description: error.message }),
  })
  const openPlan = useMutation({
    mutationFn: () => openEvaluationPlan(plan.id),
    onSuccess: async ({ count }) => {
      await onRefresh()
      toast({
        title: 'Review plan opened',
        description: `${count} private reviewer ${count === 1 ? 'invite' : 'invites'} queued.`,
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not open plan', description: error.message }),
  })

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{plan.name}</h2>
            <PlanStatusBadge status={plan.status} />
            {plan.anonymized && <Badge variant="outline">Anonymized</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.assignments.total} assignments · {detail.evaluators.length} reviewers ·{' '}
            {plan.scale === '1_10' ? '10-point' : '5-point'} scale
          </p>
          <div className="mt-1">
            <ReviewWindowNote plan={plan} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => assign.mutate('all_to_all')}
            disabled={assign.isPending || detail.evaluators.length === 0}
          >
            <ListChecks />
            {assign.isPending ? 'Assigning…' : 'Assign sessions'}
          </Button>
          {tracks.length > 0 && (
            <Button
              variant="secondary"
              onClick={() => assign.mutate('by_track')}
              disabled={assign.isPending || detail.evaluators.length === 0}
              title="Give each reviewer only the submissions in the tracks they cover"
            >
              <Layers />
              Assign by track
            </Button>
          )}
          <Button
            onClick={() => openPlan.mutate()}
            disabled={openPlan.isPending || detail.evaluators.length === 0}
          >
            <Send />
            {openPlan.isPending ? 'Queuing…' : plan.status === 'open' ? 'Resend invites' : 'Open plan'}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="border-b border-border px-5 sm:px-6">
          <TabsList variant="underline">
            <TabsTrigger value="setup">Plan setup</TabsTrigger>
            <TabsTrigger value="assignments">Assignments</TabsTrigger>
            <TabsTrigger value="summary">Summary & decisions</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="setup" className="m-0">
          <PlanEditor plan={plan} onRefresh={onRefresh} />
          <EvaluatorEditor
            plan={plan}
            evaluators={detail.evaluators}
            tracks={tracks}
            onRefresh={onRefresh}
          />
        </TabsContent>
        <TabsContent value="assignments" className="m-0">
          <AssignmentsPanel plan={plan} onRefresh={onRefresh} />
        </TabsContent>
        <TabsContent value="summary" className="m-0">
          <SummaryPanel
            plan={plan}
            onDecision={() => {
              queryClient.invalidateQueries({ queryKey: ['evaluation-summary', plan.id] })
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** "Yes, No, Unsure" as the option list the server stores (blanks dropped). */
function parseCriterionOptions(text: string): string[] {
  return text
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean)
}

function PlanEditor({
  plan,
  onRefresh,
}: {
  plan: EvaluationPlan
  onRefresh: () => Promise<void>
}) {
  const [name, setName] = useState(plan.name)
  const [instructions, setInstructions] = useState(plan.instructions ?? '')
  const [anonymized, setAnonymized] = useState(plan.anonymized)
  const [criteria, setCriteria] = useState<EvaluationCriterion[]>(plan.criteria)
  // The choices of a select criterion, kept as the raw comma-separated text
  // the organizer is typing — round-tripping through the array would eat the
  // comma the moment they press it.
  const [optionsText, setOptionsText] = useState<Record<number, string>>({})
  const [opensAt, setOpensAt] = useState(toDateInputValue(plan.opens_at))
  const [closesAt, setClosesAt] = useState(toDateInputValue(plan.closes_at))

  useEffect(() => {
    setName(plan.name)
    setInstructions(plan.instructions ?? '')
    setAnonymized(plan.anonymized)
    setCriteria(plan.criteria)
    setOptionsText({})
    setOpensAt(toDateInputValue(plan.opens_at))
    setClosesAt(toDateInputValue(plan.closes_at))
  }, [plan])

  const save = useMutation({
    mutationFn: () =>
      updateEvaluationPlan(plan.id, {
        name: name.trim(),
        instructions,
        anonymized,
        criteria,
        // An emptied date field clears the bound rather than leaving it stale.
        opens_at: opensAt || null,
        closes_at: closesAt || null,
      }),
    onSuccess: async () => {
      await onRefresh()
      toast({ title: 'Plan settings saved' })
    },
  })
  // Only the scored rows carry weight: a choice or a paragraph collects an
  // answer, not a score, so it stays out of the 100% and out of the overall.
  const scaleCriteria = criteria.filter((item) => criterionKind(item) === 'scale')
  const weightTotal = scaleCriteria.reduce((sum, criterion) => sum + Number(criterion.weight || 0), 0)
  const weightsBalance = scaleCriteria.length === 0 || weightTotal === 100
  const canSave =
    Boolean(name.trim()) &&
    criteria.every((item) => item.name.trim()) &&
    scaleCriteria.every((item) => Number(item.weight) > 0) &&
    criteria.every(
      (item) => criterionKind(item) !== 'select' || (item.options?.length ?? 0) > 0
    ) &&
    weightsBalance

  const updateCriterion = (index: number, patch: Partial<EvaluationCriterion>) => {
    setCriteria((current) =>
      current.map((criterion, criterionIndex) =>
        criterionIndex === index ? { ...criterion, ...patch } : criterion
      )
    )
  }

  const changeCriterionKind = (index: number, kind: EvaluationCriterionKind) => {
    // The row is becoming a different question — the half-typed choice list of
    // whatever it was before shouldn't linger under it.
    setOptionsText((current) => {
      const { [index]: _dropped, ...rest } = current
      return rest
    })
    if (kind === 'select') {
      updateCriterion(index, { kind, weight: 0, options: criteria[index].options ?? [] })
      return
    }
    if (kind === 'text') {
      updateCriterion(index, { kind, weight: 0, options: undefined })
      return
    }
    updateCriterion(index, { kind: 'scale', options: undefined })
  }

  return (
    <section className="px-5 py-6 sm:px-6">
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <div className="space-y-5">
          <div>
            <h3 className="text-base font-semibold text-foreground">Review brief</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              The instructions shown at the top of every reviewer scorecard.
            </p>
          </div>
          <Field label="Plan name" htmlFor="plan-name">
            <Input id="plan-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Instructions" htmlFor="plan-instructions">
            <Textarea
              id="plan-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Describe what a strong submission looks like."
            />
          </Field>
          <ReviewWindowFields
            idPrefix="plan"
            opensAt={opensAt}
            closesAt={closesAt}
            onOpensAtChange={setOpensAt}
            onClosesAtChange={setClosesAt}
          />
          <label className="flex items-start gap-3 rounded-md border border-border p-3">
            <Checkbox checked={anonymized} onCheckedChange={(value) => setAnonymized(value === true)} />
            <span>
              <span className="block text-sm font-medium text-foreground">Hide speaker identity</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Reviewers will only see the proposal content.
              </span>
            </span>
          </label>
        </div>

        <div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">Weighted criteria</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Scored criteria are normalized by weight and stay on the{' '}
                {plan.scale === '1_10' ? '1–10' : '1–5'} scale. Choice and text criteria collect an
                answer instead, so they carry no weight and never move the overall.
              </p>
            </div>
            <Badge variant={weightsBalance ? 'success' : 'destructive'}>
              {scaleCriteria.length === 0 ? 'Unscored' : `${weightTotal}%`}
            </Badge>
          </div>
          <div className="mt-4 space-y-2">
            {criteria.map((criterion, index) => {
              const kind = criterionKind(criterion)
              const label = criterion.name || `Criterion ${index + 1}`
              return (
                <div key={index} className="space-y-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_104px_76px_32px] gap-2">
                    <Input
                      aria-label={`Criterion ${index + 1} name`}
                      value={criterion.name}
                      onChange={(event) => updateCriterion(index, { name: event.target.value })}
                    />
                    <NativeSelect
                      aria-label={`${label} type`}
                      value={kind}
                      onValueChange={(value) =>
                        changeCriterionKind(index, value as EvaluationCriterionKind)
                      }
                      options={[
                        { value: 'scale', label: 'Scale' },
                        { value: 'select', label: 'Choice' },
                        { value: 'text', label: 'Text' },
                      ]}
                    />
                    {kind === 'scale' ? (
                      <Input
                        type="number"
                        aria-label={`${label} weight`}
                        min={1}
                        max={100}
                        value={criterion.weight}
                        onChange={(event) =>
                          updateCriterion(index, { weight: Number(event.target.value) })
                        }
                      />
                    ) : (
                      <span
                        className="flex h-9 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground"
                        title="Choice and text criteria aren't weighted"
                      >
                        No weight
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${criterion.name || 'criterion'}`}
                      disabled={criteria.length === 1}
                      onClick={() => {
                        // Removing a row renumbers the ones after it, so the
                        // raw option text (keyed by index) is re-derived.
                        setOptionsText({})
                        setCriteria((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index)
                        )
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {kind === 'select' && (
                    <Input
                      aria-label={`${label} choices`}
                      placeholder="Comma-separated choices, e.g. Yes, No, Unsure"
                      value={optionsText[index] ?? (criterion.options ?? []).join(', ')}
                      onChange={(event) => {
                        const text = event.target.value
                        setOptionsText((current) => ({ ...current, [index]: text }))
                        updateCriterion(index, { options: parseCriterionOptions(text) })
                      }}
                    />
                  )}
                </div>
              )
            })}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCriteria((current) => [...current, { name: '', weight: 0 }])}
            >
              <Plus />
              Add criterion
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-6 flex items-center justify-end gap-3 border-t border-border pt-5">
        {save.error && <span className="mr-auto text-sm text-destructive">{save.error.message}</span>}
        <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
          <Check />
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </section>
  )
}

function EvaluatorEditor({
  plan,
  evaluators,
  tracks,
  onRefresh,
}: {
  plan: EvaluationPlan
  evaluators: Awaited<ReturnType<typeof getEvaluationPlan>>['evaluators']
  tracks: EvaluationTrack[]
  onRefresh: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [trackIds, setTrackIds] = useState<string[]>([])
  const [linksOpen, setLinksOpen] = useState(false)
  const add = useMutation({
    mutationFn: () =>
      addEvaluator(plan.id, {
        name: name.trim(),
        email: email.trim(),
        // [] is meaningful: "reviews every track"
        track_ids: trackIds,
      }),
    onSuccess: async () => {
      setName('')
      setEmail('')
      setTrackIds([])
      await onRefresh()
      toast({ title: 'Reviewer added' })
    },
  })
  const remove = useMutation({
    mutationFn: (evaluatorId: string) => deleteEvaluator(plan.id, evaluatorId),
    onSuccess: async () => {
      await onRefresh()
      toast({ title: 'Reviewer removed' })
    },
  })

  // Who is actually behind: at least one assignment without a submitted review.
  // The reminder goes to exactly these people, never the whole committee.
  const laggards = evaluators.filter(
    (evaluator) => (evaluator.assignment_count ?? 0) > (evaluator.complete_count ?? 0)
  )
  const remind = useMutation({
    mutationFn: () => remindLaggingReviewers(plan.id),
    onSuccess: (result) => {
      if (result.reminded > 0) {
        toast({
          title: `Reminded ${result.reminded} ${result.reminded === 1 ? 'reviewer' : 'reviewers'}`,
          description: result.evaluators.join(', '),
        })
      } else if (result.skipped > 0) {
        toast({
          title: 'Already reminded today',
          description: `${result.already_reminded.join(', ')} already got a nudge today.`,
        })
      } else {
        toast({
          title: 'Everyone is up to date',
          description: 'No reviewer has an unfinished review.',
        })
      }
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not send reminders', description: error.message }),
  })

  return (
    <section className="border-t border-border px-5 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Review committee</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Add reviewers, assign every eligible submission, then open the plan to queue private links.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {evaluators.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={laggards.length === 0 || remind.isPending}
              title={
                laggards.length === 0
                  ? 'Every reviewer has finished'
                  : 'Email only the reviewers with unfinished reviews'
              }
              onClick={() => remind.mutate()}
            >
              <BellRing />
              {remind.isPending
                ? 'Reminding…'
                : `Remind incomplete reviewers (${laggards.length})`}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={evaluators.length === 0}
            onClick={() => setLinksOpen(true)}
          >
            <Link2 />
            Reviewer links
          </Button>
        </div>
      </div>
      <ReviewerLinksDialog planId={plan.id} open={linksOpen} onOpenChange={setLinksOpen} />
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(150px,0.7fr)_minmax(220px,1fr)_auto]">
        <Field label="Name" htmlFor="evaluator-name">
          <Input
            id="evaluator-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Reviewer name"
          />
        </Field>
        <Field label="Email" htmlFor="evaluator-email">
          <Input
            id="evaluator-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="reviewer@example.com"
          />
        </Field>
        <Button
          className="self-end"
          variant="secondary"
          disabled={!email.includes('@') || add.isPending}
          onClick={() => add.mutate()}
        >
          <Plus />
          Add reviewer
        </Button>
      </div>
      {tracks.length > 0 && (
        <div className="mt-4 space-y-2">
          <Label>Tracks reviewed</Label>
          <TrackPicker tracks={tracks} value={trackIds} onChange={setTrackIds} />
          <p className="text-xs text-muted-foreground">
            {trackIds.length === 0
              ? 'No selection — this reviewer can review every track.'
              : `Assign by track will only give them ${trackIds.length === 1 ? 'this track' : 'these tracks'}.`}
          </p>
        </div>
      )}
      {add.error && <div className="mt-3"><InlineError>{add.error.message}</InlineError></div>}

      <div className="mt-5 overflow-hidden rounded-md border border-border">
        {evaluators.length === 0 ? (
          <div className="px-5 py-9 text-center">
            <Users className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium text-foreground">No reviewers yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Add at least one person before assigning sessions.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Reviewer</TableHead>
                {tracks.length > 0 && <TableHead className="w-[300px]">Tracks</TableHead>}
                <TableHead className="w-[130px]">Progress</TableHead>
                <TableHead className="w-[150px]">Invite</TableHead>
                <TableHead className="w-[44px]"><span className="sr-only">Remove</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {evaluators.map((evaluator) => (
                <TableRow key={evaluator.id}>
                  <TableCell>
                    <p className="font-medium text-foreground">{evaluator.name || evaluator.email}</p>
                    {evaluator.name && <p className="text-xs text-muted-foreground">{evaluator.email}</p>}
                  </TableCell>
                  {tracks.length > 0 && (
                    <TableCell>
                      <EvaluatorTracksCell
                        planId={plan.id}
                        evaluator={evaluator}
                        tracks={tracks}
                        onRefresh={onRefresh}
                      />
                    </TableCell>
                  )}
                  <TableCell className="text-sm tabular-nums text-muted-foreground">
                    {evaluator.complete_count ?? 0}/{evaluator.assignment_count ?? 0} complete
                  </TableCell>
                  <TableCell>
                    {evaluator.invited_at ? (
                      <Badge variant="success"><Mail /> Sent</Badge>
                    ) : (
                      <Badge variant="muted">Not sent</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${evaluator.name || evaluator.email}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(evaluator.id)}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  )
}

function EvaluatorTracksCell({
  planId,
  evaluator,
  tracks,
  onRefresh,
}: {
  planId: string
  evaluator: Evaluator
  tracks: EvaluationTrack[]
  onRefresh: () => Promise<void>
}) {
  const covered = useMemo(() => evaluator.track_ids ?? [], [evaluator.track_ids])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string[]>(covered)

  useEffect(() => {
    if (!editing) setDraft(covered)
  }, [covered, editing])

  const save = useMutation({
    mutationFn: () => updateEvaluator(planId, evaluator.id, { track_ids: draft }),
    onSuccess: async () => {
      setEditing(false)
      await onRefresh()
      toast({ title: 'Reviewer tracks updated' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not save tracks', description: error.message }),
  })

  const label = evaluator.name || evaluator.email

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2">
        <TrackChips
          tracks={
            evaluator.tracks ?? tracks.filter((track) => covered.includes(track.id))
          }
          empty={<AllTracksHint />}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit tracks for ${label}`}
          onClick={() => setEditing(true)}
        >
          <Tags />
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <TrackPicker
        tracks={tracks}
        value={draft}
        onChange={setDraft}
        disabled={save.isPending}
      />
      <div className="flex items-center gap-2">
        <Button size="xs" disabled={save.isPending} onClick={() => save.mutate()}>
          <Check />
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={save.isPending}
          onClick={() => {
            setDraft(covered)
            setEditing(false)
          }}
        >
          <X />
          Cancel
        </Button>
        {draft.length === 0 && <AllTracksHint />}
      </div>
    </div>
  )
}

/* ── per-submission assignment ─────────────────────────────────────────────
 * "Assign sessions" and "Assign by track" are bulk strokes. A program chair
 * also needs the deliberate single pairing — this reviewer reads THIS talk —
 * and needs to see, per submission, exactly who is on it. */

const REVIEW_STATUS_DOT: Record<ReviewerAssignmentStatus, string> = {
  pending: 'bg-muted-foreground/40',
  in_progress: 'bg-warning',
  reviewed: 'bg-success',
}

const REVIEW_STATUS_LABEL: Record<ReviewerAssignmentStatus, string> = {
  pending: 'not started',
  in_progress: 'in progress',
  reviewed: 'review complete',
}

function AssignmentsPanel({
  plan,
  onRefresh,
}: {
  plan: EvaluationPlan
  onRefresh: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const boardQuery = useQuery({
    queryKey: ['evaluation-assignments', plan.id],
    queryFn: () => getPlanAssignments(plan.id),
  })
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['evaluation-assignments', plan.id] }),
      onRefresh(),
    ])
  }
  const assign = useMutation({
    mutationFn: (input: { evaluator_id: string; session_id: string }) =>
      assignReviewerToSubmission(plan.id, input),
    onSuccess: async (assignment) => {
      await refresh()
      toast({
        title: 'Reviewer assigned',
        description: `${assignment.evaluator_name || assignment.evaluator_email} → ${
          assignment.session_title ?? 'submission'
        }`,
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not assign', description: error.message }),
  })
  const unassign = useMutation({
    mutationFn: (assignmentId: string) => unassignReviewerFromSubmission(plan.id, assignmentId),
    onSuccess: async () => {
      await refresh()
      toast({ title: 'Reviewer unassigned' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not unassign', description: error.message }),
  })

  if (boardQuery.isPending) {
    return (
      <div className="space-y-3 px-5 py-6 sm:px-6">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-14" />
        ))}
      </div>
    )
  }
  if (boardQuery.error) {
    return (
      <PageMessage
        icon={<AlertCircle className="h-6 w-6 text-destructive" />}
        title="Couldn't load assignments"
        description={boardQuery.error.message}
        action={<Button onClick={() => boardQuery.refetch()}>Try again</Button>}
      />
    )
  }

  const board = boardQuery.data
  const busy = assign.isPending || unassign.isPending

  return (
    <section className="px-5 py-6 sm:px-6">
      <div>
        <h3 className="text-base font-semibold text-foreground">Who reviews what</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign one reviewer to one submission — on top of, or instead of, the bulk assignment
          buttons above.
        </p>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border border-border">
        {board.evaluators.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Users className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium text-foreground">No reviewers yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add reviewers under Plan setup before assigning submissions.
            </p>
          </div>
        ) : board.sessions.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            No submissions are waiting for review yet.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Submission</TableHead>
                <TableHead>Reviewers</TableHead>
                <TableHead className="w-[230px]">Add a reviewer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {board.sessions.map((session) => (
                <SubmissionAssignmentRow
                  key={session.session_id}
                  session={session}
                  evaluators={board.evaluators}
                  busy={busy}
                  onAssign={(evaluatorId) =>
                    assign.mutate({ evaluator_id: evaluatorId, session_id: session.session_id })
                  }
                  onUnassign={(assignmentId) => unassign.mutate(assignmentId)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  )
}

function SubmissionAssignmentRow({
  session,
  evaluators,
  busy,
  onAssign,
  onUnassign,
}: {
  session: AssignableSubmission
  evaluators: Array<{ id: string; name: string; email: string | null }>
  busy: boolean
  onAssign: (evaluatorId: string) => void
  onUnassign: (assignmentId: string) => void
}) {
  const assigned = new Set(session.assignments.map((entry) => entry.evaluator_id))
  const available = evaluators.filter((evaluator) => !assigned.has(evaluator.id))

  return (
    <TableRow>
      <TableCell>
        <p className="font-medium text-foreground">{session.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {session.friendly_id && <span className="font-mono">{session.friendly_id}</span>}
          <TrackChips tracks={session.tracks} />
        </div>
      </TableCell>
      <TableCell>
        {session.assignments.length === 0 ? (
          <span className="text-xs text-muted-foreground">Nobody assigned</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {session.assignments.map((entry) => {
              const label = entry.name || entry.email || 'Reviewer'
              return (
                <span
                  key={entry.assignment_id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card py-0.5 pl-2 pr-1 text-xs font-medium text-foreground"
                  title={`${label} — ${REVIEW_STATUS_LABEL[entry.review_status]}`}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      REVIEW_STATUS_DOT[entry.review_status]
                    )}
                  />
                  <span className="truncate">{label}</span>
                  <button
                    type="button"
                    aria-label={`Unassign ${label} from ${session.title}`}
                    disabled={busy}
                    onClick={() => onUnassign(entry.assignment_id)}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )
            })}
          </div>
        )}
      </TableCell>
      <TableCell>
        <NativeSelect
          aria-label={`Assign a reviewer to ${session.title}`}
          // Stays on the placeholder: picking a name is the action, not a state.
          value=""
          placeholder={available.length === 0 ? 'All reviewers assigned' : 'Add reviewer…'}
          disabled={busy || available.length === 0}
          options={available.map((evaluator) => ({
            value: evaluator.id,
            label: evaluator.name || evaluator.email || 'Reviewer',
          }))}
          onValueChange={(value) => {
            if (value) onAssign(value)
          }}
        />
      </TableCell>
    </TableRow>
  )
}

function ReviewerLinksDialog({
  planId,
  open,
  onOpenChange,
}: {
  planId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Fresh links each time the dialog opens — old links stay valid, so no caching.
  const linksQuery = useQuery({
    queryKey: ['reviewer-links', planId],
    queryFn: () => getReviewerLinks(planId),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reviewer links</DialogTitle>
          <DialogDescription>
            Email delivery is pending your mail provider — copy a reviewer's private link and share it
            directly so they can open their scorecard.
          </DialogDescription>
        </DialogHeader>
        {linksQuery.isPending ? (
          <div className="space-y-2 py-1">
            {[0, 1].map((item) => (
              <Skeleton key={item} className="h-12" />
            ))}
          </div>
        ) : linksQuery.error ? (
          <InlineError>{linksQuery.error.message}</InlineError>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {(linksQuery.data ?? []).map((link) => (
              <li key={link.evaluator_id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{link.name || link.email}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{link.review_url}</p>
                </div>
                <CopyButton value={link.review_url} label={`Copy link for ${link.name || link.email}`} />
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SummaryPanel({ plan, onDecision }: { plan: EvaluationPlan; onDecision: () => void }) {
  const summaryQuery = useQuery({
    queryKey: ['evaluation-summary', plan.id],
    queryFn: () => getEvaluationSummary(plan.id),
  })
  const decision = useMutation({
    mutationFn: ({ sessionId, status }: { sessionId: string; status: 'accepted' | 'declined' }) =>
      updateEvaluationDecision(sessionId, status),
    onSuccess: (_result, variables) => {
      onDecision()
      toast({ title: variables.status === 'accepted' ? 'Session accepted' : 'Session declined' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Decision failed', description: error.message }),
  })

  if (summaryQuery.isPending) return <SummarySkeleton />
  if (summaryQuery.error) {
    return (
      <PageMessage
        icon={<AlertCircle className="h-6 w-6 text-destructive" />}
        title="Couldn't load the summary"
        description={summaryQuery.error.message}
        action={<Button onClick={() => summaryQuery.refetch()}>Try again</Button>}
      />
    )
  }

  const summary = summaryQuery.data
  return (
    <div className="px-5 py-6 sm:px-6">
      <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <Metric label="Assignments" value={summary.assignment_count} />
        <Metric label="Started" value={summary.started} />
        <Metric label="In progress" value={summary.in_progress} />
        <Metric label="Complete" value={summary.complete} accent />
      </div>

      <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1fr)_280px]">
        <section className="min-w-0">
          <div>
            <h3 className="text-base font-semibold text-foreground">Session scores</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Final, non-abstained reviews only. Decisions use the existing session status workflow.
            </p>
          </div>
          <div className="mt-4 overflow-hidden rounded-md border border-border">
            {summary.per_session.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                Assign sessions to reviewers to start the summary.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Session</TableHead>
                    <TableHead className="w-[90px] text-right">Average</TableHead>
                    <TableHead className="w-[90px] text-right">Reviews</TableHead>
                    <TableHead className="w-[200px]">Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.per_session.map((session) => (
                    <TableRow key={session.session_id}>
                      <TableCell>
                        <p className="font-medium text-foreground">{session.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {session.friendly_id && <span className="font-mono">{session.friendly_id}</span>}
                          {session.abstained_count > 0 && <span>{session.abstained_count} abstained</span>}
                          <TrackChips tracks={session.tracks} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">
                        {session.avg_overall === null ? '—' : session.avg_overall.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                        {session.review_count}
                      </TableCell>
                      <TableCell>
                        <DecisionControl
                          session={session}
                          disabled={decision.isPending}
                          onChange={(status) => decision.mutate({ sessionId: session.session_id, status })}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </section>

        <aside className="space-y-7">
          <RankedList
            icon={<ArrowDownWideNarrow className="h-4 w-4 text-primary" />}
            title="Top sessions"
            empty="No complete scores yet."
            rows={summary.top_sessions}
            value={(row) => row.avg_overall?.toFixed(2) ?? '—'}
          />
          <RankedList
            icon={<Users className="h-4 w-4 text-primary" />}
            title="Widest score range"
            empty="Two completed reviews are needed."
            rows={summary.thought_provoking}
            value={(row) => `${row.score_range.toFixed(2)} range`}
          />
        </aside>
      </div>
    </div>
  )
}

function DecisionControl({
  session,
  disabled,
  onChange,
}: {
  session: EvaluationSessionSummary
  disabled: boolean
  onChange: (status: 'accepted' | 'declined') => void
}) {
  if (session.status === 'accepted') return <Badge variant="success">Accepted</Badge>
  if (session.status === 'declined') return <Badge variant="destructive">Declined</Badge>
  return (
    <div className="flex gap-2">
      <Button size="xs" disabled={disabled} onClick={() => onChange('accepted')}>Accept</Button>
      <Button size="xs" variant="secondary" disabled={disabled} onClick={() => onChange('declined')}>
        Decline
      </Button>
    </div>
  )
}

function RankedList({
  icon,
  title,
  empty,
  rows,
  value,
}: {
  icon: ReactNode
  title: string
  empty: string
  rows: EvaluationSessionSummary[]
  value: (row: EvaluationSessionSummary) => string
}) {
  return (
    <section>
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ol className="mt-3 divide-y divide-border border-y border-border">
          {rows.map((row, index) => (
            <li key={row.session_id} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 py-3">
              <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
              <span className="truncate text-sm text-foreground">{row.title}</span>
              <span className="font-mono text-xs font-semibold text-foreground">{value(row)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function Metric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={cn('bg-card px-5 py-5', accent && 'bg-primary-subtle/60')}>
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('mt-2 font-mono text-3xl font-semibold tracking-tight text-foreground', accent && 'text-primary')}>
        {value}
      </p>
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

function InlineError({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function PageMessage({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="mt-7 rounded-lg border border-border bg-card px-6 py-14 text-center shadow-soft">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-muted">{icon}</div>
      <h2 className="mt-4 text-base font-semibold text-foreground">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}

function EvaluationSkeleton() {
  return (
    <div className="mt-7 grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Skeleton className="h-64 rounded-lg" />
      <PlanSkeleton />
    </div>
  )
}

function PlanSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  )
}

function SummarySkeleton() {
  return (
    <div className="space-y-6 p-6">
      <div className="grid gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-24" />)}
      </div>
      <Skeleton className="h-80" />
    </div>
  )
}
