import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDownWideNarrow,
  BellRing,
  CalendarClock,
  Check,
  ClipboardCheck,
  FileDown,
  Layers,
  Link2,
  ListChecks,
  Mail,
  Plus,
  Send,
  Sparkles,
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
  bulkUnassignReviewers,
  createEvaluationPlan,
  criterionKind,
  deleteEvaluator,
  getAiTriage,
  getEvaluationPlan,
  getEvaluationSummary,
  getPlanAssignments,
  getReviewerLinks,
  listEvaluationPlans,
  openEvaluationPlan,
  overrideAiTriageScore,
  remindLaggingReviewers,
  runAiTriage,
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
  type TriageItem,
  type TriageSuggestion,
} from '@/lib/evaluationApi'
import { CopyButton } from '@/ui/copy-button'
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

const TRACK_FALLBACK_COLOR = '#7E8AA8'

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
            <h1 className="page-title">Evaluation</h1>
            <p className="page-subtitle">
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
          <aside className="self-start overflow-hidden rounded-lg border border-border bg-card lg:sticky lg:top-5">
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
  const [assignOpen, setAssignOpen] = useState(false)
  const [triageOpen, setTriageOpen] = useState(false)
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
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{plan.name}</h2>
            <PlanStatusBadge status={plan.status} />
            {plan.anonymized && <Badge variant="outline">Anonymized</Badge>}
          </div>
          {/* Progress sits beside the nudge on purpose: the number that says
              who is behind and the button that chases them belong together. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-sm text-muted-foreground">
              {detail.assignments.total} assignments · {detail.evaluators.length} reviewers ·{' '}
              {detail.assignments.complete}/{detail.assignments.total} reviews complete ·{' '}
              {plan.scale === '1_10' ? '10-point' : '5-point'} scale
            </p>
            <RemindLaggardsButton plan={plan} evaluators={detail.evaluators} />
          </div>
          <div className="mt-1">
            <ReviewWindowNote plan={plan} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => setAssignOpen(true)}
            disabled={detail.evaluators.length === 0}
            title="Choose which submissions go to which reviewers"
          >
            <ListChecks />
            Assign sessions
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
          <Button variant="secondary" onClick={() => setTriageOpen(true)}>
            <Sparkles />
            AI triage
          </Button>
          <Button
            onClick={() => openPlan.mutate()}
            disabled={openPlan.isPending || detail.evaluators.length === 0}
          >
            <Send />
            {openPlan.isPending ? 'Queuing…' : plan.status === 'open' ? 'Resend invites' : 'Open plan'}
          </Button>
        </div>
      </div>

      <AssignSessionsDialog
        plan={plan}
        open={assignOpen}
        onOpenChange={setAssignOpen}
        onAssigned={async () => {
          await queryClient.invalidateQueries({ queryKey: ['evaluation-assignments', plan.id] })
          await onRefresh()
        }}
      />
      <AiTriageDialog plan={plan} open={triageOpen} onOpenChange={setTriageOpen} />

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

/**
 * The nudge for the reviewers who are behind — in the plan header, next to the
 * progress it acts on.
 *
 * It used to live at the bottom of the committee table, which is where nobody
 * looked: an organizer reading "3/10 reviews complete" wants the chase button
 * in the same glance, not two sections down. The reminder still goes to
 * exactly the laggards (server-side, deduped per reviewer per day) and the
 * toast names them, so it is never mistaken for "email the whole committee".
 */
function RemindLaggardsButton({
  plan,
  evaluators,
}: {
  plan: EvaluationPlan
  evaluators: Evaluator[]
}) {
  // Behind = at least one assignment without a submitted review.
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

  if (evaluators.length === 0) return null

  return (
    <Button
      variant="outline"
      size="xs"
      disabled={laggards.length === 0 || remind.isPending}
      title={
        laggards.length === 0
          ? 'Every reviewer has finished'
          : 'Email only the reviewers with unfinished reviews'
      }
      onClick={() => remind.mutate()}
    >
      <BellRing />
      {remind.isPending ? 'Reminding…' : `Remind incomplete reviewers (${laggards.length})`}
    </Button>
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

/** A submission whose decision is already made — reviewable only on request. */
function isDecided(status?: string | null): boolean {
  return status === 'accepted' || status === 'declined'
}

/**
 * "Assign sessions", with a say in what actually gets assigned.
 *
 * The one-click version handed every eligible submission to every reviewer,
 * and taking one back off meant unassigning it by hand — so a chair who wanted
 * nine of ten got a lot of clicking. This dialog opens with everything ticked
 * (the old behaviour is still one confirm away) and lets them untick the rest.
 *
 * "Include decided submissions" is the second half: round one reviews what is
 * undecided, but a later round often wants exactly the accepted work back in
 * front of a different committee.
 */
function AssignSessionsDialog({
  plan,
  open,
  onOpenChange,
  onAssigned,
}: {
  plan: EvaluationPlan
  open: boolean
  onOpenChange: (open: boolean) => void
  onAssigned: () => Promise<void>
}) {
  const [includeDecided, setIncludeDecided] = useState(false)
  const [sessionIds, setSessionIds] = useState<string[]>([])
  const [evaluatorIds, setEvaluatorIds] = useState<string[]>([])

  const boardQuery = useQuery({
    queryKey: ['evaluation-assignments', plan.id, includeDecided],
    queryFn: () => getPlanAssignments(plan.id, { includeDecided }),
    enabled: open,
  })
  const board = boardQuery.data

  // Select-all is the default so the fast path stays one confirm away; the
  // effect re-runs when the candidate list changes (e.g. decided work joins).
  useEffect(() => {
    if (!board) return
    setSessionIds(board.sessions.map((session) => session.session_id))
    setEvaluatorIds(board.evaluators.map((evaluator) => evaluator.id))
  }, [board])

  const assign = useMutation({
    mutationFn: (scope: 'all' | 'selected') =>
      assignEvaluationSessions(plan.id, {
        mode: 'all_to_all',
        include_decided: includeDecided,
        ...(scope === 'selected'
          ? { session_ids: sessionIds, evaluator_ids: evaluatorIds }
          : {}),
      }),
    onSuccess: async (result) => {
      await onAssigned()
      onOpenChange(false)
      toast({
        title: result.created ? 'Sessions assigned' : 'Assignments already up to date',
        description: `${result.created} new · ${result.total} assignments across ${result.session_count} submissions.`,
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Assignment failed', description: error.message }),
  })

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((value) => value !== id) : [...list, id]

  const allSelected = Boolean(board) && sessionIds.length === (board?.sessions.length ?? 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Assign sessions to reviewers</DialogTitle>
          <DialogDescription>
            Everything is selected to start. Untick what this round shouldn't cover — existing
            assignments are never duplicated.
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-start gap-3 rounded-md border border-border p-3">
          <Checkbox
            checked={includeDecided}
            onCheckedChange={(value) => setIncludeDecided(value === true)}
            aria-label="Include decided submissions"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">
              Include decided submissions
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Accepted and declined talks can join this round — for a second pass over work round
              one already decided.
            </span>
          </span>
        </label>

        {boardQuery.isPending ? (
          <div className="space-y-2 py-1">
            {[0, 1, 2].map((item) => (
              <Skeleton key={item} className="h-10" />
            ))}
          </div>
        ) : boardQuery.error ? (
          <InlineError>{boardQuery.error.message}</InlineError>
        ) : !board || board.sessions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No submissions are eligible for this round yet.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Submissions ({sessionIds.length}/{board.sessions.length})
              </p>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setSessionIds(
                    allSelected ? [] : board.sessions.map((session) => session.session_id)
                  )
                }
              >
                {allSelected ? 'Clear all' : 'Select all'}
              </Button>
            </div>
            <ul className="max-h-64 divide-y divide-border overflow-y-auto scrollbar-app rounded-md border border-border">
              {board.sessions.map((session) => (
                <li key={session.session_id}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-accent/50">
                    <Checkbox
                      className="mt-0.5"
                      checked={sessionIds.includes(session.session_id)}
                      onCheckedChange={() =>
                        setSessionIds((current) => toggle(current, session.session_id))
                      }
                      aria-label={`Assign ${session.title}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {session.title}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {session.friendly_id && (
                          <span className="font-mono">{session.friendly_id}</span>
                        )}
                        {isDecided(session.status) && (
                          <Badge variant="outline" className="capitalize">
                            {session.status}
                          </Badge>
                        )}
                        {session.assignments.length > 0 && (
                          <span>{session.assignments.length} already assigned</span>
                        )}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {board.evaluators.length > 1 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Reviewers ({evaluatorIds.length}/{board.evaluators.length})
                </p>
                <div className="flex flex-wrap gap-2">
                  {board.evaluators.map((evaluator) => {
                    const label = evaluator.name || evaluator.email || 'Reviewer'
                    const picked = evaluatorIds.includes(evaluator.id)
                    return (
                      <label
                        key={evaluator.id}
                        className={cn(
                          'inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium',
                          picked ? 'bg-primary-subtle/70 text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        <Checkbox
                          checked={picked}
                          onCheckedChange={() =>
                            setEvaluatorIds((current) => toggle(current, evaluator.id))
                          }
                          aria-label={`Assign to ${label}`}
                        />
                        {label}
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {assign.error && <InlineError>{assign.error.message}</InlineError>}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* The old one-click behaviour, kept as the fast path. */}
          <Button
            variant="outline"
            disabled={assign.isPending}
            onClick={() => assign.mutate('all')}
          >
            Assign all to everyone
          </Button>
          <Button
            disabled={assign.isPending || sessionIds.length === 0 || evaluatorIds.length === 0}
            onClick={() => assign.mutate('selected')}
          >
            {assign.isPending
              ? 'Assigning…'
              : `Assign ${sessionIds.length} selected`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssignmentsPanel({
  plan,
  onRefresh,
}: {
  plan: EvaluationPlan
  onRefresh: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const [includeDecided, setIncludeDecided] = useState(false)
  // Which pairings are ticked for removal. Kept by assignment id, so it
  // survives a refetch that reorders rows.
  const [selected, setSelected] = useState<string[]>([])
  const boardQuery = useQuery({
    queryKey: ['evaluation-assignments', plan.id, includeDecided],
    queryFn: () => getPlanAssignments(plan.id, { includeDecided }),
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
  const unassignMany = useMutation({
    mutationFn: (assignmentIds: string[]) => bulkUnassignReviewers(plan.id, assignmentIds),
    onSuccess: async (result) => {
      setSelected([])
      await refresh()
      toast({
        title: `Removed ${result.removed} ${result.removed === 1 ? 'assignment' : 'assignments'}`,
      })
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
  const busy = assign.isPending || unassign.isPending || unassignMany.isPending
  const toggleSelected = (assignmentId: string) =>
    setSelected((current) =>
      current.includes(assignmentId)
        ? current.filter((value) => value !== assignmentId)
        : [...current, assignmentId]
    )

  return (
    <section className="px-5 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Who reviews what</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Assign one reviewer to one submission — on top of, or instead of, the bulk assignment
            buttons above. Tick reviewers to take several off at once.
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground">
          <Checkbox
            checked={includeDecided}
            onCheckedChange={(value) => setIncludeDecided(value === true)}
            aria-label="Include decided submissions"
          />
          Include decided submissions
        </label>
      </div>

      {selected.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary-subtle/50 px-4 py-2.5">
          <p className="text-sm font-medium text-foreground">
            {selected.length} {selected.length === 1 ? 'assignment' : 'assignments'} selected
          </p>
          <div className="flex gap-2">
            <Button size="xs" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={unassignMany.isPending}
              onClick={() => unassignMany.mutate(selected)}
            >
              <Trash2 />
              {unassignMany.isPending ? 'Removing…' : 'Unassign selected'}
            </Button>
          </div>
        </div>
      )}

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
                  selected={selected}
                  onToggleSelected={toggleSelected}
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
  selected,
  onToggleSelected,
  onAssign,
  onUnassign,
}: {
  session: AssignableSubmission
  evaluators: Array<{ id: string; name: string; email: string | null }>
  busy: boolean
  selected: string[]
  onToggleSelected: (assignmentId: string) => void
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
          {isDecided(session.status) && (
            <Badge variant="outline" className="capitalize">
              {session.status}
            </Badge>
          )}
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
                  className={cn(
                    'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card py-0.5 pl-1.5 pr-1 text-xs font-medium text-foreground',
                    selected.includes(entry.assignment_id) && 'border-primary bg-primary-subtle/70'
                  )}
                  title={`${label} — ${REVIEW_STATUS_LABEL[entry.review_status]}`}
                >
                  <Checkbox
                    className="h-3.5 w-3.5"
                    checked={selected.includes(entry.assignment_id)}
                    onCheckedChange={() => onToggleSelected(entry.assignment_id)}
                    aria-label={`Select ${label} on ${session.title}`}
                  />
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

/* ── exporting the scores ──────────────────────────────────────────────────
 * The scores CSV also lives behind Options on the submissions inbox, but a
 * chair reading the results table is not going to go looking for it there —
 * so the same export sits next to the numbers it exports. */

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** One row per submission: title, id, status, aggregate, review count. */
export function buildScoresCsv(rows: EvaluationSessionSummary[]): string {
  const header = ['ID', 'Session', 'Status', 'Average score', 'Reviews', 'Abstained', 'Score range']
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.friendly_id ?? '',
        row.title ?? '',
        row.status ?? '',
        row.avg_overall === null || row.avg_overall === undefined ? '' : row.avg_overall.toFixed(2),
        row.review_count ?? 0,
        row.abstained_count ?? 0,
        (row.score_range ?? 0).toFixed(2),
      ]
        .map((value) => csvCell(String(value)))
        .join(',')
    )
  }
  return lines.join('\n')
}

function downloadScoresCsv(planName: string, rows: EvaluationSessionSummary[]): string {
  const filename = `${planName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'plan'}-scores.csv`
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return filename
  }
  const blob = new Blob([buildScoresCsv(rows)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return filename
}

function SummaryPanel({ plan, onDecision }: { plan: EvaluationPlan; onDecision: () => void }) {
  const summaryQuery = useQuery({
    queryKey: ['evaluation-summary', plan.id],
    queryFn: () => getEvaluationSummary(plan.id),
  })
  // A read, never a model call — the AI column only shows what a previous
  // triage run stored, clearly separated from the human average beside it.
  const triageQuery = useQuery({
    queryKey: ['ai-triage', plan.id],
    queryFn: () => getAiTriage(plan.id),
  })
  const aiById = useMemo(() => {
    const map = new Map<string, TriageItem>()
    for (const item of triageQuery.data?.triage?.items ?? []) map.set(item.session_id, item)
    return map
  }, [triageQuery.data])
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">Session scores</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Final, non-abstained reviews only. Decisions use the existing session status
                workflow.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={summary.per_session.length === 0}
              onClick={() => {
                const filename = downloadScoresCsv(plan.name, summary.per_session)
                toast({
                  title: 'Exported scores',
                  description: `${summary.per_session.length} rows → ${filename}`,
                })
              }}
            >
              <FileDown />
              Export scores
            </Button>
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
                    {aiById.size > 0 && (
                      <TableHead className="w-[110px] text-right" title="AI-generated first pass">
                        AI score
                      </TableHead>
                    )}
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
                      {aiById.size > 0 && (
                        <TableCell className="text-right">
                          <AiScoreCell item={aiById.get(session.session_id)} />
                        </TableCell>
                      )}
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

/* ── AI triage (ABS-14) ────────────────────────────────────────────────────
 * Machine judgement is only useful if it is never mistaken for the
 * committee's. Everything here is labelled: the score carries an "AI" tag in
 * the results table, the dialog says which engine wrote it, and a chair's
 * override is shown as a correction OF the AI value rather than replacing it. */

const SUGGESTION_BADGE: Record<
  TriageSuggestion,
  { label: string; variant: 'solid' | 'warning' | 'destructive' }
> = {
  advance: { label: 'Advance', variant: 'solid' },
  discuss: { label: 'Discuss', variant: 'warning' },
  decline: { label: 'Decline', variant: 'destructive' },
}

/** The AI's number in the results table — never confusable with the human one. */
function AiScoreCell({ item }: { item?: TriageItem }) {
  if (!item) return <span className="text-sm text-muted-foreground">—</span>
  const overridden = item.override_score !== null && item.override_score !== undefined
  const shown = overridden ? item.override_score! : item.score
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <Badge variant={overridden ? 'outline' : 'muted'} className="font-normal">
        {overridden ? 'Override' : 'AI'}
      </Badge>
      <span className="font-mono text-sm font-semibold text-foreground">
        {shown === null || shown === undefined ? '—' : shown.toFixed(2)}
      </span>
    </span>
  )
}

function AiTriageDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: EvaluationPlan
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [includeDecided, setIncludeDecided] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const triageQuery = useQuery({
    queryKey: ['ai-triage', plan.id],
    queryFn: () => getAiTriage(plan.id),
    enabled: open,
  })
  const triage = triageQuery.data?.triage ?? null

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['ai-triage', plan.id] })

  const run = useMutation({
    mutationFn: () => runAiTriage(plan.id, { include_decided: includeDecided }),
    onSuccess: async (response) => {
      queryClient.setQueryData(['ai-triage', plan.id], response)
      await invalidate()
      const count = response.triage?.items.length ?? 0
      toast({
        title: `AI triage ready — ${count} ${count === 1 ? 'submission' : 'submissions'}`,
        description:
          response.triage?.source === 'anthropic'
            ? `Generated by ${response.triage.model}.`
            : 'No AI key configured — ranked from reviewer scores instead.',
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Triage failed', description: error.message }),
  })

  const override = useMutation({
    mutationFn: ({ sessionId, score }: { sessionId: string; score: number | null }) =>
      overrideAiTriageScore(plan.id, sessionId, score),
    onSuccess: async (response, variables) => {
      queryClient.setQueryData(['ai-triage', plan.id], response)
      setDrafts((current) => {
        const next = { ...current }
        delete next[variables.sessionId]
        return next
      })
      await invalidate()
      toast({
        title: variables.score === null ? 'Override cleared' : 'AI score overridden',
        description:
          variables.score === null
            ? 'The AI score stands again.'
            : `Saved ${variables.score} in place of the AI value.`,
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not save', description: error.message }),
  })

  const top = plan.scale === '1_10' ? 10 : 5

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>AI triage</DialogTitle>
          <DialogDescription>
            A first pass over every submission in this plan — a summary, a 1–{top} score and a
            suggested disposition, ranked. Advisory only: your reviewers still decide.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={includeDecided}
              onCheckedChange={(value) => setIncludeDecided(value === true)}
              aria-label="Include decided submissions in triage"
            />
            Include decided submissions
          </label>
          <Button disabled={run.isPending} onClick={() => run.mutate()}>
            <Sparkles />
            {run.isPending ? 'Analyzing…' : triage ? 'Re-run triage' : 'Run AI triage'}
          </Button>
        </div>

        {triage && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2 text-xs text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="font-medium">AI-generated — review before acting.</span>
            <span className="text-muted-foreground">
              {triage.source === 'anthropic'
                ? `Model ${triage.model} · ${new Date(triage.generated_at).toLocaleString()}`
                : 'No AI key configured: ranked from reviewer scores (heuristic, not model-written).'}
            </span>
            {triage.degraded && (
              <Badge variant="warning">The model call failed — fell back to scores</Badge>
            )}
            {triage.stored === false && (
              <Badge variant="warning">Not saved (migration 012 pending)</Badge>
            )}
          </div>
        )}

        {run.error && <InlineError>{run.error.message}</InlineError>}

        {triageQuery.isPending ? (
          <div className="space-y-2 py-1">
            {[0, 1, 2].map((item) => (
              <Skeleton key={item} className="h-20" />
            ))}
          </div>
        ) : !triage || triage.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No triage yet. Run it to get a ranked first pass over this plan's submissions.
          </p>
        ) : (
          <ol className="max-h-[26rem] space-y-2 overflow-y-auto scrollbar-app pr-1">
            {triage.items.map((item, index) => {
              const overridden =
                item.override_score !== null && item.override_score !== undefined
              const draft = drafts[item.session_id]
              const badge = SUGGESTION_BADGE[item.suggestion]
              return (
                <li
                  key={item.session_id}
                  data-testid={`triage-${item.session_id}`}
                  className="rounded-lg border border-border bg-card px-4 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2">
                      <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <p className="min-w-0 text-sm font-semibold text-foreground">{item.title}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      <AiScoreCell item={item} />
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-foreground">{item.summary}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">Why: </span>
                    {item.rationale}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Label htmlFor={`override-${item.session_id}`} className="text-xs">
                      Override score
                    </Label>
                    <Input
                      id={`override-${item.session_id}`}
                      className="h-8 w-24"
                      type="number"
                      min={1}
                      max={top}
                      step="0.5"
                      placeholder={item.score === null ? '—' : String(item.score)}
                      value={
                        draft ?? (overridden ? String(item.override_score) : '')
                      }
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [item.session_id]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      size="xs"
                      disabled={override.isPending || draft === undefined || draft.trim() === ''}
                      onClick={() =>
                        override.mutate({
                          sessionId: item.session_id,
                          score: Number(draft),
                        })
                      }
                    >
                      Save override
                    </Button>
                    {overridden && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={override.isPending}
                        onClick={() =>
                          override.mutate({ sessionId: item.session_id, score: null })
                        }
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <div className="mt-7 rounded-lg border border-border bg-card px-6 py-14 text-center">
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
