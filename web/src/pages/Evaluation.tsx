import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDownWideNarrow,
  Check,
  ClipboardCheck,
  ListChecks,
  Mail,
  Plus,
  Send,
  Trash2,
  Users,
} from 'lucide-react'

import { listEvents } from '@/lib/adminApi'
import {
  addEvaluator,
  assignEvaluationSessions,
  createEvaluationPlan,
  deleteEvaluator,
  getEvaluationPlan,
  getEvaluationSummary,
  listEvaluationPlans,
  openEvaluationPlan,
  updateEvaluationDecision,
  updateEvaluationPlan,
  type EvaluationCriterion,
  type EvaluationPlan,
  type EvaluationPlanStatus,
  type EvaluationScale,
  type EvaluationSessionSummary,
} from '@/lib/evaluationApi'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select'
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
  const create = useMutation({
    mutationFn: () =>
      createEvaluationPlan(eventId, { name: name.trim(), instructions, scale, anonymized }),
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
            <Select value={scale} onValueChange={(value) => setScale(value as EvaluationScale)}>
              <SelectTrigger id="evaluation-plan-scale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1_5">1–5</SelectItem>
                <SelectItem value="1_10">1–10</SelectItem>
              </SelectContent>
            </Select>
          </Field>
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
  const [tab, setTab] = useState('setup')
  const assign = useMutation({
    mutationFn: () => assignEvaluationSessions(plan.id),
    onSuccess: async (result) => {
      await onRefresh()
      toast({
        title: result.created ? 'Sessions assigned' : 'Assignments already up to date',
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
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => assign.mutate()}
            disabled={assign.isPending || detail.evaluators.length === 0}
          >
            <ListChecks />
            {assign.isPending ? 'Assigning…' : 'Assign sessions'}
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

      <Tabs value={tab} onValueChange={setTab}>
        <div className="border-b border-border px-5 sm:px-6">
          <TabsList variant="underline">
            <TabsTrigger value="setup">Plan setup</TabsTrigger>
            <TabsTrigger value="summary">Summary & decisions</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="setup" className="m-0">
          <PlanEditor plan={plan} onRefresh={onRefresh} />
          <EvaluatorEditor plan={plan} evaluators={detail.evaluators} onRefresh={onRefresh} />
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

  useEffect(() => {
    setName(plan.name)
    setInstructions(plan.instructions ?? '')
    setAnonymized(plan.anonymized)
    setCriteria(plan.criteria)
  }, [plan])

  const save = useMutation({
    mutationFn: () =>
      updateEvaluationPlan(plan.id, { name: name.trim(), instructions, anonymized, criteria }),
    onSuccess: async () => {
      await onRefresh()
      toast({ title: 'Plan settings saved' })
    },
  })
  const weightTotal = criteria.reduce((sum, criterion) => sum + Number(criterion.weight || 0), 0)
  const canSave =
    Boolean(name.trim()) &&
    criteria.every((item) => item.name.trim() && Number(item.weight) > 0) &&
    weightTotal === 100

  const updateCriterion = (index: number, patch: Partial<EvaluationCriterion>) => {
    setCriteria((current) =>
      current.map((criterion, criterionIndex) =>
        criterionIndex === index ? { ...criterion, ...patch } : criterion
      )
    )
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
                Scores are normalized by weight and stay on the {plan.scale === '1_10' ? '1–10' : '1–5'} scale.
              </p>
            </div>
            <Badge variant={weightTotal === 100 ? 'success' : 'destructive'}>{weightTotal}%</Badge>
          </div>
          <div className="mt-4 space-y-2">
            {criteria.map((criterion, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_84px_32px] gap-2">
                <Input
                  aria-label={`Criterion ${index + 1} name`}
                  value={criterion.name}
                  onChange={(event) => updateCriterion(index, { name: event.target.value })}
                />
                <Input
                  type="number"
                  aria-label={`${criterion.name || `Criterion ${index + 1}`} weight`}
                  min={1}
                  max={100}
                  value={criterion.weight}
                  onChange={(event) => updateCriterion(index, { weight: Number(event.target.value) })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${criterion.name || 'criterion'}`}
                  disabled={criteria.length === 1}
                  onClick={() => setCriteria((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
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
  onRefresh,
}: {
  plan: EvaluationPlan
  evaluators: Awaited<ReturnType<typeof getEvaluationPlan>>['evaluators']
  onRefresh: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const add = useMutation({
    mutationFn: () => addEvaluator(plan.id, { name: name.trim(), email: email.trim() }),
    onSuccess: async () => {
      setName('')
      setEmail('')
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
      <div>
        <h3 className="text-base font-semibold text-foreground">Review committee</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Add reviewers, assign every eligible submission, then open the plan to queue private links.
        </p>
      </div>
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
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          {session.friendly_id && <span className="font-mono">{session.friendly_id}</span>}
                          {session.abstained_count > 0 && <span>{session.abstained_count} abstained</span>}
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
