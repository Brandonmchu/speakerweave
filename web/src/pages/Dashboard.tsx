/**
 * The onboarding dashboard (requirement #6).
 *
 * One question, answered above the fold: which speakers still owe us
 * something. The table is sorted so the answer is the top of the list, and it
 * repolls every 5s (PLAN §3 — polling that visibly refreshes beats a
 * subscription that half-works), so an organizer can leave this open on a
 * second screen during onboarding week and watch it drain.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  LayoutDashboard,
  ListChecks,
  Mail,
  Users,
} from 'lucide-react'

import {
  getEventDashboard,
  listDashboardEvents,
  type SpeakerOnboarding,
  type SubmissionFunnel,
} from '@/lib/dashboardApi'
import { deliveryStatusLabel } from '@/lib/deliveryStatus'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Card } from '@/ui/card'
import { EmptyState } from '@/ui/empty-state'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'

/** Polling interval. Fast enough to read as live, slow enough to be free. */
const REFETCH_MS = 5000

type BadgeVariant = 'default' | 'success' | 'warning' | 'destructive' | 'muted' | 'outline'

/** The funnel, left to right, in the order an organizer reads it. */
const FUNNEL_STEPS: Array<{
  key: keyof Omit<SubmissionFunnel, 'total'>
  label: string
  variant: BadgeVariant
  bar: string
}> = [
  { key: 'pending', label: 'Pending', variant: 'warning', bar: 'bg-warning' },
  { key: 'accept_queue', label: 'Accept Queue', variant: 'default', bar: 'bg-primary/50' },
  { key: 'accepted', label: 'Accepted', variant: 'success', bar: 'bg-success' },
  { key: 'decline_queue', label: 'Decline Queue', variant: 'muted', bar: 'bg-foreground/20' },
  { key: 'declined', label: 'Declined', variant: 'destructive', bar: 'bg-destructive' },
  { key: 'withdrawn', label: 'Withdrawn', variant: 'muted', bar: 'bg-foreground/10' },
]

/** email_outbox.status ∈ (queued, sent, failed, cancelled). */
const EMAIL_STATUS_VARIANT: Record<string, BadgeVariant> = {
  sent: 'success',
  queued: 'warning',
  failed: 'destructive',
  cancelled: 'muted',
}

/** "acceptance" → "Acceptance". Template keys are snake_case machine names. */
function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key
}

function relativeDate(value?: string | null): string {
  if (!value) return 'Never'
  try {
    return formatDistanceToNow(parseISO(value), { addSuffix: true })
  } catch {
    return 'Never'
  }
}

function fullDate(value?: string | null): string | undefined {
  if (!value) return undefined
  try {
    return format(parseISO(value), "MMM d, yyyy 'at' h:mm a")
  } catch {
    return undefined
  }
}

function clockTime(value: number): string {
  try {
    return format(new Date(value), 'h:mm:ss a')
  } catch {
    return ''
  }
}

/**
 * "2 accepted · 1 pending". The per-speaker session mix matters here: chasing
 * someone whose only session is still pending is chasing the wrong person.
 */
function sessionMix(summary: Record<string, number>): string {
  const entries = Object.entries(summary ?? {})
  if (!entries.length) return ''
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${count} ${status.replace(/_/g, ' ')}`)
    .join(' · ')
}

export function Dashboard() {
  const [onlyOutstanding, setOnlyOutstanding] = useState(false)

  const eventsQuery = useQuery({ queryKey: ['events'], queryFn: listDashboardEvents })
  const event = eventsQuery.data?.[0]

  const dashboardQuery = useQuery({
    queryKey: ['dashboard', event?.id],
    queryFn: () => getEventDashboard(event!.id),
    enabled: Boolean(event?.id),
    // The whole point of the screen. `refetchIntervalInBackground` stays off:
    // a hidden tab burning requests helps nobody.
    refetchInterval: REFETCH_MS,
  })

  const data = dashboardQuery.data
  const speakers = useMemo(() => data?.speakers ?? [], [data])

  /**
   * The server already returns this order; re-sorting here keeps the guarantee
   * local to the component that depends on it (and keeps the filter toggle
   * from ever showing a shuffled list).
   */
  const ordered = useMemo(() => {
    const rows = onlyOutstanding ? speakers.filter((s) => s.tasks_outstanding > 0) : speakers
    return [...rows].sort(
      (a, b) =>
        Number(a.onboarding_complete) - Number(b.onboarding_complete) ||
        b.tasks_outstanding - a.tasks_outstanding ||
        a.name.localeCompare(b.name)
    )
  }, [speakers, onlyOutstanding])

  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && dashboardQuery.isPending)
  const error = eventsQuery.error ?? dashboardQuery.error
  const totals = data?.totals
  const funnel = data?.submission_funnel

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <LayoutDashboard className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Speaker onboarding at a glance{event ? ` for ${event.name}` : ''}.
            </p>
          </div>
        </div>
        {/* Proof of life for a polled page. Deliberately not aria-live: it
            re-stamps every 5s and would hijack a screen reader all session. */}
        {data && !error && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Live · updated {clockTime(dashboardQuery.dataUpdatedAt)}
          </div>
        )}
      </header>

      {error ? (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load the dashboard"
            description={error.message}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  eventsQuery.refetch()
                  dashboardQuery.refetch()
                }}
              >
                Try again
              </Button>
            }
          />
        </div>
      ) : isLoading ? (
        <LoadingDashboard />
      ) : !event ? (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          <EmptyState
            icon={<Users className="h-6 w-6 text-muted-foreground" />}
            title="No events yet"
            description="Create an event and share your call-for-papers form — speakers show up here as soon as they submit."
          />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-4 lg:grid-cols-[repeat(3,minmax(0,1fr))_1.4fr]">
            <StatCard
              label="Total speakers"
              value={totals?.speakers ?? 0}
              icon={<Users className="h-4 w-4" />}
            />
            <StatCard
              label="Onboarded"
              value={totals?.onboarded ?? 0}
              tone="success"
              icon={<CheckCircle2 className="h-4 w-4" />}
              hint={
                totals?.speakers
                  ? `${Math.round(((totals.onboarded ?? 0) / totals.speakers) * 100)}% of speakers`
                  : undefined
              }
            />
            <StatCard
              label="Outstanding tasks"
              value={totals?.outstanding_tasks ?? 0}
              tone={totals?.outstanding_tasks ? 'warning' : 'default'}
              icon={<ListChecks className="h-4 w-4" />}
            />
            <FunnelCard funnel={funnel} />
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">Speaker onboarding</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Sorted by what&rsquo;s still owed — the top of this list is your call sheet.
              </p>
            </div>
            <Button
              size="sm"
              variant={onlyOutstanding ? 'default' : 'secondary'}
              aria-pressed={onlyOutstanding}
              onClick={() => setOnlyOutstanding((on) => !on)}
            >
              <CircleDashed />
              Only outstanding
            </Button>
          </div>

          <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            {ordered.length === 0 ? (
              <EmptyState
                icon={<Users className="h-6 w-6 text-muted-foreground" />}
                title={onlyOutstanding ? 'Nothing outstanding' : 'No speakers yet'}
                description={
                  onlyOutstanding
                    ? 'Every speaker has finished the tasks assigned to them.'
                    : 'Speakers appear here once a submission names them — no manual import needed.'
                }
                action={
                  onlyOutstanding ? (
                    <Button size="sm" variant="secondary" onClick={() => setOnlyOutstanding(false)}>
                      Show everyone
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[28%]">Speaker</TableHead>
                    <TableHead className="w-[150px]">Sessions</TableHead>
                    <TableHead className="w-[26%]">Onboarding</TableHead>
                    <TableHead className="w-[160px]">Last portal access</TableHead>
                    <TableHead>Last email</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ordered.map((speaker) => (
                    <SpeakerRow key={speaker.contact_id} speaker={speaker} />
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// --- rows & cards ---------------------------------------------------------

function SpeakerRow({ speaker }: { speaker: SpeakerOnboarding }) {
  const mix = sessionMix(speaker.status_summary)
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium text-foreground">{speaker.name}</div>
        {speaker.email && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{speaker.email}</div>
        )}
      </TableCell>
      <TableCell>
        <div className="text-sm tabular-nums text-foreground">
          {speaker.session_count} {speaker.session_count === 1 ? 'session' : 'sessions'}
        </div>
        {mix && <div className="mt-0.5 truncate text-xs capitalize text-muted-foreground">{mix}</div>}
      </TableCell>
      <TableCell>
        <OnboardingProgress speaker={speaker} />
      </TableCell>
      <TableCell
        className="text-sm text-muted-foreground"
        title={fullDate(speaker.last_portal_access_at)}
      >
        {speaker.last_portal_access_at ? (
          relativeDate(speaker.last_portal_access_at)
        ) : (
          <span className="text-warning-strong">Never signed in</span>
        )}
      </TableCell>
      <TableCell>
        {speaker.last_email ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="flex items-center gap-1 text-sm text-foreground">
              <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
              {humanize(speaker.last_email.template_key ?? 'Email')}
            </span>
            {speaker.last_email.status && (
              <Badge
                variant={EMAIL_STATUS_VARIANT[speaker.last_email.status] ?? 'muted'}
                title={fullDate(speaker.last_email.sent_at)}
              >
                {deliveryStatusLabel(speaker.last_email.status, speaker.last_email.last_error)}
              </Badge>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}

/**
 * The cell the whole page exists for. Three states, deliberately distinct at a
 * glance: done (green badge), owing (bar + count), not started (no tasks yet —
 * which is the organizer's problem, not the speaker's).
 */
function OnboardingProgress({ speaker }: { speaker: SpeakerOnboarding }) {
  const { tasks_total: total, tasks_done: done, tasks_outstanding: outstanding } = speaker

  if (speaker.onboarding_complete) {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" />
        Onboarded
      </Badge>
    )
  }

  if (total === 0) {
    return <span className="text-sm text-muted-foreground">No tasks assigned</span>
  }

  const percent = Math.round((done / total) * 100)
  return (
    <div className="max-w-[220px]">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="tabular-nums text-muted-foreground">
          {done}/{total} done
        </span>
        <span className="font-medium text-warning-strong">{outstanding} outstanding</span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${speaker.name} onboarding progress`}
      >
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
}: {
  label: string
  value: number
  hint?: string
  icon?: ReactNode
  tone?: 'default' | 'success' | 'warning'
}) {
  return (
    <Card className="gap-0 py-5">
      <div className="flex items-center justify-between gap-2 px-5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        {icon && (
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md',
              // Tailwind's opacity scale steps by 5 — /12 silently compiles to
              // nothing (as it does in ui/badge.tsx today).
              tone === 'success' && 'bg-success/10 text-success-strong',
              tone === 'warning' && 'bg-warning/15 text-warning-strong',
              tone === 'default' && 'bg-primary-subtle text-primary'
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
      </div>
      <p className="mt-3 px-5 text-3xl font-semibold tabular-nums leading-none text-foreground">
        {value}
      </p>
      <p className="mt-1.5 h-4 px-5 text-xs text-muted-foreground">{hint ?? ''}</p>
    </Card>
  )
}

function FunnelCard({ funnel }: { funnel?: SubmissionFunnel }) {
  const steps = FUNNEL_STEPS.map((step) => ({ ...step, count: funnel?.[step.key] ?? 0 }))
  const charted = steps.reduce((sum, step) => sum + step.count, 0)

  return (
    <Card className="gap-0 py-5">
      <div className="flex items-center justify-between gap-2 px-5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Submission funnel
        </p>
        <span className="text-xs tabular-nums text-muted-foreground">
          {funnel?.total ?? 0} total
        </span>
      </div>

      {/* One bar, six segments. Zero submissions reads as an empty track rather
          than a divide-by-zero. */}
      <div className="mt-3 px-5">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {charted > 0 &&
            steps.map(
              (step) =>
                step.count > 0 && (
                  <div
                    key={step.key}
                    className={step.bar}
                    style={{ width: `${(step.count / charted) * 100}%` }}
                    title={`${step.label}: ${step.count}`}
                  />
                )
            )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 px-5">
        {steps.map((step) => (
          <Badge key={step.key} variant={step.variant} className="gap-1">
            {step.label}
            <span className="tabular-nums">{step.count}</span>
          </Badge>
        ))}
      </div>
    </Card>
  )
}

function LoadingDashboard() {
  return (
    <>
      <div className="mt-6 grid gap-4 lg:grid-cols-[repeat(3,minmax(0,1fr))_1.4fr]">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="gap-0 py-5">
            <Skeleton className="mx-5 h-3 w-24" />
            <Skeleton className="mx-5 mt-4 h-7 w-16" />
          </Card>
        ))}
      </div>
      <div className="mt-6 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-4">
            <Skeleton className="h-4 w-[26%]" />
            <Skeleton className="h-4 w-[14%]" />
            <Skeleton className="h-4 w-[22%]" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </>
  )
}
