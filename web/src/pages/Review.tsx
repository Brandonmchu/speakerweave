import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowRight, Check, ClipboardCheck, Save, ShieldCheck } from 'lucide-react'
import { useParams } from 'react-router-dom'

import {
  getReviewerHome,
  getReviewerSubmission,
  saveReviewerReview,
  type EvaluationCriterion,
  type ReviewerAssignment,
  type ReviewerHome,
} from '@/lib/evaluationApi'
import { fetchMe, redeemToken, scrubTokenFromUrl } from '@/lib/portalAuth'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Checkbox } from '@/ui/checkbox'
import { Skeleton } from '@/ui/skeleton'
import { Textarea } from '@/ui/textarea'
import { toast } from '@/ui/use-toast'

type AuthState = 'checking' | 'ready' | 'missing'

export function Review() {
  const { token } = useParams<{ token?: string }>()
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    async function authenticate() {
      setAuthState('checking')
      setAuthError(null)
      try {
        if (token) {
          await redeemToken(token)
          scrubTokenFromUrl()
          if (active) setAuthState('ready')
          return
        }
        const session = await fetchMe()
        if (!active) return
        setAuthState(session?.purpose === 'review' ? 'ready' : 'missing')
      } catch (error) {
        if (!active) return
        setAuthError(error instanceof Error ? error.message : 'This reviewer link could not be opened.')
        setAuthState('missing')
      }
    }
    authenticate()
    return () => {
      active = false
    }
  }, [token])

  if (authState === 'checking') return <ReviewLoading />
  if (authState === 'missing') {
    return (
      <PublicReviewShell>
        <StateMessage
          icon={<AlertCircle className="h-6 w-6 text-destructive" />}
          title="This review link isn't available"
          description={authError ?? 'Ask the event organizer for a new reviewer invitation.'}
        />
      </PublicReviewShell>
    )
  }
  return <ReviewerWorkspace />
}

function ReviewerWorkspace() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const homeQuery = useQuery({ queryKey: ['reviewer-home'], queryFn: getReviewerHome })
  const home = homeQuery.data

  useEffect(() => {
    if (!home?.assignments.length) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !home.assignments.some((item) => item.assignment_id === selectedId)) {
      const firstOpen = home.assignments.find((item) => item.review_status !== 'reviewed')
      setSelectedId((firstOpen ?? home.assignments[0]).assignment_id)
    }
  }, [home, selectedId])

  const detailQuery = useQuery({
    queryKey: ['reviewer-submission', selectedId],
    queryFn: () => getReviewerSubmission(selectedId!),
    enabled: Boolean(selectedId),
  })

  if (homeQuery.isPending) return <ReviewLoading />
  if (homeQuery.error) {
    return (
      <PublicReviewShell>
        <StateMessage
          icon={<AlertCircle className="h-6 w-6 text-destructive" />}
          title="Couldn't load your review queue"
          description={homeQuery.error.message}
          action={<Button onClick={() => homeQuery.refetch()}>Try again</Button>}
        />
      </PublicReviewShell>
    )
  }
  if (!home) return null

  const completed = home.assignments.filter((item) => item.review_status === 'reviewed').length
  return (
    <PublicReviewShell>
      <header className="border-b border-border pb-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant={home.plan.status === 'open' ? 'solid' : 'warning'}>
                {home.plan.status === 'open' ? 'Review open' : 'Review closed'}
              </Badge>
              {home.plan.anonymized && (
                <Badge variant="outline"><ShieldCheck /> Anonymized</Badge>
              )}
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">{home.plan.name}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Welcome{home.evaluator.name ? `, ${home.evaluator.name}` : ''}. You have completed {completed} of{' '}
              {home.assignments.length} assigned reviews.
            </p>
          </div>
          <div className="min-w-[170px] rounded-lg border border-border bg-muted/40 px-4 py-3">
            <div className="flex items-end justify-between gap-4">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Progress</span>
              <span className="font-mono text-sm font-semibold text-foreground">{completed}/{home.assignments.length}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-primary transition-transform duration-300 origin-left"
                style={{ transform: `scaleX(${home.assignments.length ? completed / home.assignments.length : 0})` }}
              />
            </div>
          </div>
        </div>
        {home.plan.instructions && (
          <div className="mt-5 max-w-3xl rounded-md border-l-2 border-primary bg-primary-subtle/45 px-4 py-3 text-sm leading-relaxed text-foreground">
            {home.plan.instructions}
          </div>
        )}
      </header>

      {home.assignments.length === 0 ? (
        <StateMessage
          icon={<ClipboardCheck className="h-6 w-6 text-muted-foreground" />}
          title="No submissions assigned"
          description="The organizer hasn't assigned any submissions to you yet."
        />
      ) : (
        <div className="grid gap-7 py-7 lg:grid-cols-[270px_minmax(0,1fr)]">
          <AssignmentList
            assignments={home.assignments}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          {detailQuery.isPending ? (
            <ScorecardSkeleton />
          ) : detailQuery.error ? (
            <StateMessage
              icon={<AlertCircle className="h-6 w-6 text-destructive" />}
              title="Couldn't load this submission"
              description={detailQuery.error.message}
              action={<Button onClick={() => detailQuery.refetch()}>Try again</Button>}
            />
          ) : detailQuery.data ? (
            <Scorecard
              key={detailQuery.data.assignment_id}
              home={home}
              assignmentId={detailQuery.data.assignment_id}
              session={detailQuery.data.session}
              existingReview={detailQuery.data.review}
              onSaved={async (advance) => {
                await queryClient.invalidateQueries({ queryKey: ['reviewer-home'] })
                await queryClient.invalidateQueries({
                  queryKey: ['reviewer-submission', detailQuery.data?.assignment_id],
                })
                if (advance) {
                  setSelectedId(nextAssignmentId(home.assignments, detailQuery.data!.assignment_id))
                }
              }}
            />
          ) : null}
        </div>
      )}
    </PublicReviewShell>
  )
}

function AssignmentList({
  assignments,
  selectedId,
  onSelect,
}: {
  assignments: ReviewerAssignment[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <aside className="self-start overflow-hidden rounded-lg border border-border bg-card lg:sticky lg:top-6">
      <div className="border-b border-border px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your submissions</p>
      </div>
      <div className="divide-y divide-border">
        {assignments.map((assignment, index) => (
          <button
            key={assignment.assignment_id}
            type="button"
            onClick={() => onSelect(assignment.assignment_id)}
            className={cn(
              'w-full px-4 py-4 text-left transition-colors hover:bg-accent/60',
              selectedId === assignment.assignment_id && 'bg-primary-subtle/65'
            )}
          >
            <div className="flex items-start gap-3">
              <span className="pt-0.5 font-mono text-xs text-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block line-clamp-2 text-sm font-medium leading-snug text-foreground">
                  {assignment.session.title}
                </span>
                <span className="mt-2 block">
                  <ReviewStatus status={assignment.review_status} />
                </span>
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}

function ReviewStatus({ status }: { status: ReviewerAssignment['review_status'] }) {
  if (status === 'reviewed') return <Badge variant="success"><Check /> Reviewed</Badge>
  if (status === 'in_progress') return <Badge variant="warning">In progress</Badge>
  return <Badge variant="muted">Pending</Badge>
}

function Scorecard({
  home,
  assignmentId,
  session,
  existingReview,
  onSaved,
}: {
  home: ReviewerHome
  assignmentId: string
  session: Awaited<ReturnType<typeof getReviewerSubmission>>['session']
  existingReview: Awaited<ReturnType<typeof getReviewerSubmission>>['review']
  onSaved: (advance: boolean) => Promise<void>
}) {
  const [scores, setScores] = useState<Record<string, number>>(existingReview?.scores ?? {})
  const [comment, setComment] = useState(existingReview?.comment ?? '')
  const [abstained, setAbstained] = useState(Boolean(existingReview?.abstained))
  const [abstainReason, setAbstainReason] = useState(existingReview?.abstain_reason ?? '')

  const save = useMutation({
    mutationFn: ({ isDraft, advance }: { isDraft: boolean; advance: boolean }) =>
      saveReviewerReview(assignmentId, {
        scores,
        comment,
        abstained,
        abstain_reason: abstainReason,
        is_draft: isDraft,
      }).then((review) => ({ review, advance, isDraft })),
    onSuccess: async ({ advance, isDraft }) => {
      toast({ title: isDraft ? 'Draft saved' : abstained ? 'Abstention submitted' : 'Review saved' })
      await onSaved(advance)
    },
  })

  const maximum = home.plan.scale === '1_10' ? 10 : 5
  const completeScores = home.plan.criteria.every((criterion) => scores[criterion.name] !== undefined)
  const canSubmit = home.plan.status === 'open' && (abstained ? Boolean(abstainReason.trim()) : completeScores)
  const speakerNames = !home.plan.anonymized
    ? (session.speakers ?? [])
        .map((speaker) => [speaker.first_name, speaker.last_name].filter(Boolean).join(' '))
        .filter(Boolean)
    : []

  return (
    <article className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
      <div className="border-b border-border px-5 py-6 sm:px-7">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {session.friendly_id && <span className="font-mono">{session.friendly_id}</span>}
          <span>Submission</span>
        </div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{session.title}</h2>
        {!home.plan.anonymized && speakerNames.length > 0 && (
          <p className="mt-2 text-sm text-muted-foreground">Presented by {speakerNames.join(', ')}</p>
        )}
        <div className="mt-5 whitespace-pre-wrap text-sm leading-7 text-foreground/90">
          {session.description || 'No description was provided.'}
        </div>
        <SubmissionMetadata values={session.form_answers} />
      </div>

      <div className="px-5 py-6 sm:px-7">
        <div>
          <h3 className="text-base font-semibold text-foreground">Score this proposal</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose one score per criterion. Your weighted overall is calculated automatically.
          </p>
        </div>
        <div className={cn('mt-6 space-y-7', abstained && 'pointer-events-none opacity-45')}>
          {home.plan.criteria.map((criterion) => (
            <RatingRow
              key={criterion.name}
              criterion={criterion}
              maximum={maximum}
              value={scores[criterion.name]}
              disabled={abstained}
              onChange={(value) => setScores((current) => ({ ...current, [criterion.name]: value }))}
            />
          ))}
        </div>

        <div className="mt-8 space-y-2 border-t border-border pt-6">
          <label htmlFor="review-comment" className="text-sm font-medium text-foreground">
            Reviewer comment <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Textarea
            id="review-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Share concise feedback for the selection committee."
          />
        </div>

        <div className="mt-5 rounded-md border border-border bg-muted/30 p-4">
          <label className="flex items-start gap-3">
            <Checkbox
              checked={abstained}
              onCheckedChange={(value) => setAbstained(value === true)}
            />
            <span>
              <span className="block text-sm font-medium text-foreground">Abstain from this review</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Use this for conflicts of interest or insufficient subject expertise.
              </span>
            </span>
          </label>
          {abstained && (
            <div className="mt-4 space-y-2">
              <label htmlFor="abstain-reason" className="text-sm font-medium text-foreground">Reason</label>
              <Textarea
                id="abstain-reason"
                value={abstainReason}
                onChange={(event) => setAbstainReason(event.target.value)}
                placeholder="Briefly explain why you're abstaining."
                className="min-h-[80px]"
              />
            </div>
          )}
        </div>

        {save.error && (
          <div className="mt-5 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{save.error.message}</span>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-5">
          <Button
            variant="ghost"
            disabled={save.isPending || home.plan.status !== 'open'}
            onClick={() => save.mutate({ isDraft: true, advance: false })}
          >
            <Save />
            Save draft
          </Button>
          <Button
            variant="secondary"
            disabled={save.isPending || !canSubmit}
            onClick={() => save.mutate({ isDraft: false, advance: false })}
          >
            <Check />
            Save review
          </Button>
          <Button
            disabled={save.isPending || !canSubmit}
            onClick={() => save.mutate({ isDraft: false, advance: true })}
          >
            {save.isPending ? 'Saving…' : 'Save & next'}
            {!save.isPending && <ArrowRight />}
          </Button>
        </div>
      </div>
    </article>
  )
}

function RatingRow({
  criterion,
  maximum,
  value,
  disabled,
  onChange,
}: {
  criterion: EvaluationCriterion
  maximum: number
  value?: number
  disabled?: boolean
  onChange: (value: number) => void
}) {
  return (
    <fieldset disabled={disabled}>
      <div className="flex items-end justify-between gap-3">
        <legend className="text-sm font-medium text-foreground">{criterion.name}</legend>
        <span className="text-xs text-muted-foreground">{criterion.weight}% weight</span>
      </div>
      <div className={cn('mt-2 grid gap-1.5', maximum === 10 ? 'grid-cols-10' : 'grid-cols-5')}>
        {Array.from({ length: maximum }, (_, index) => index + 1).map((score) => (
          <button
            key={score}
            type="button"
            aria-label={`${criterion.name}: ${score} of ${maximum}`}
            aria-pressed={value === score}
            onClick={() => onChange(score)}
            className={cn(
              'h-10 rounded-md border text-sm font-semibold tabular-nums transition-[color,background-color,border-color,transform] active:scale-[0.97]',
              value === score
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card text-muted-foreground hover:border-primary/60 hover:bg-primary-subtle hover:text-primary'
            )}
          >
            {score}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        <span>Low</span>
        <span>High</span>
      </div>
    </fieldset>
  )
}

function SubmissionMetadata({ values }: { values?: Record<string, unknown> }) {
  const entries = useMemo(
    () => Object.entries(values ?? {}).filter(([, value]) => value !== null && value !== ''),
    [values]
  )
  if (!entries.length) return null
  return (
    <details className="mt-5 rounded-md border border-border bg-muted/25 px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-foreground">Additional submission details</summary>
      <dl className="mt-4 space-y-3 border-t border-border pt-4">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt className="font-mono text-[11px] text-muted-foreground">{key}</dt>
            <dd className="mt-1 text-sm text-foreground">{formatMetadata(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function formatMetadata(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function nextAssignmentId(assignments: ReviewerAssignment[], currentId: string): string {
  const currentIndex = assignments.findIndex((item) => item.assignment_id === currentId)
  const after = assignments.slice(currentIndex + 1).find((item) => item.review_status !== 'reviewed')
  const before = assignments.slice(0, Math.max(currentIndex, 0)).find((item) => item.review_status !== 'reviewed')
  return (after ?? before ?? assignments[(currentIndex + 1) % assignments.length]).assignment_id
}

function PublicReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-[#FBFBFB]">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-7 sm:px-6 sm:py-10">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">d</div>
          <span className="text-sm font-semibold tracking-tight text-foreground">dais</span>
          <span className="text-border">/</span>
          <span className="text-sm text-muted-foreground">Reviewer portal</span>
        </div>
        {children}
        <p className="mt-7 text-center text-xs text-muted-foreground">Private review workspace powered by dais</p>
      </div>
    </div>
  )
}

function StateMessage({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-6 py-16 text-center shadow-soft">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-muted">{icon}</div>
      <h1 className="mt-4 text-lg font-semibold text-foreground">{title}</h1>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}

function ReviewLoading() {
  return (
    <PublicReviewShell>
      <div className="rounded-lg border border-border bg-card p-6 shadow-soft sm:p-8">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-28" />
        </div>
        <Skeleton className="mt-5 h-9 w-80 max-w-full" />
        <Skeleton className="mt-3 h-4 w-96 max-w-full" />
        <div className="mt-9 grid gap-6 lg:grid-cols-[270px_minmax(0,1fr)]">
          <Skeleton className="h-72" />
          <ScorecardSkeleton />
        </div>
      </div>
    </PublicReviewShell>
  )
}

function ScorecardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="mt-4 h-24 w-full" />
      <div className="mt-8 space-y-6">
        {[0, 1, 2].map((item) => (
          <div key={item}>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-2 h-10 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
