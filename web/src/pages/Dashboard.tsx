/**
 * The onboarding dashboard (requirement #6).
 *
 * One question, answered above the fold: which speakers still owe us
 * something. The table is sorted so the answer is the top of the list, and it
 * repolls every 5s (PLAN §3 — polling that visibly refreshes beats a
 * subscription that half-works), so an organizer can leave this open on a
 * second screen during onboarding week and watch it drain.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { AlertCircle, Users } from 'lucide-react'

import {
  getEventDashboard,
  listDashboardEvents,
  type SpeakerOnboarding,
  type SubmissionFunnel,
} from '@/lib/dashboardApi'
import { deliveryStatusLabel } from '@/lib/deliveryStatus'
import { GradientAvatar } from '@/ui/avatar'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { EmptyState } from '@/ui/empty-state'
import { Progress } from '@/ui/progress'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'

/** Polling interval. Fast enough to read as live, slow enough to be free. */
const REFETCH_MS = 5000

/** The funnel, left to right, in the order an organizer reads it. */
const FUNNEL_STEPS: Array<{
  key: keyof Omit<SubmissionFunnel, 'total'>
  label: string
  dot: string
}> = [
  { key: 'pending', label: 'Pending', dot: 'before:bg-warning' },
  { key: 'accept_queue', label: 'Accept queue', dot: 'before:bg-status-queue' },
  { key: 'accepted', label: 'Accepted', dot: 'before:bg-success' },
  { key: 'decline_queue', label: 'Decline queue', dot: 'before:bg-status-queue' },
  { key: 'declined', label: 'Declined', dot: 'before:bg-destructive' },
  { key: 'withdrawn', label: 'Withdrawn', dot: 'before:bg-status-neutral' },
]

/** email_outbox.status ∈ (queued, sent, failed, cancelled). */
const EMAIL_STATUS_DOT: Record<string, string> = {
  sent: 'before:bg-success',
  queued: 'before:bg-warning',
  failed: 'before:bg-destructive',
  cancelled: 'before:bg-status-neutral',
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
        <div>
          <h1 className="page-title">Today</h1>
          <p className="page-subtitle">
            Speaker onboarding at a glance{event ? ` for ${event.name}` : ''}.
          </p>
        </div>
        {/* Proof of life for a polled page. Deliberately not aria-live: it
            re-stamps every 5s and would hijack a screen reader all session. */}
        {data && !error && (
          <div className="flex items-center gap-2 font-mono text-[10.5px] text-placeholder">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Live · updated {clockTime(dashboardQuery.dataUpdatedAt)}
          </div>
        )}
      </header>

      {error ? (
        <div className="mt-6 overflow-hidden bg-card">
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
        <div className="mt-6 overflow-hidden bg-card">
          <EmptyState
            icon={<Users className="h-6 w-6 text-muted-foreground" />}
            title="No events yet"
            description="Create an event and share your call-for-papers form — speakers show up here as soon as they submit."
          />
        </div>
      ) : (
        <>
          <div className="mt-6 grid border-y border-border bg-card sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_1.6fr]">
            <StatBlock
              label="Total speakers"
              value={totals?.speakers ?? 0}
            />
            <StatBlock
              label="Onboarded"
              value={totals?.onboarded ?? 0}
              hint={
                totals?.speakers
                  ? `${Math.round(((totals.onboarded ?? 0) / totals.speakers) * 100)}% of speakers`
                  : undefined
              }
            />
            <StatBlock
              label="Outstanding tasks"
              value={totals?.outstanding_tasks ?? 0}
            />
            <FunnelCard funnel={funnel} />
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="section-label">Speaker onboarding</h2>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                Sorted by what&rsquo;s still owed — the top of this list is your call sheet.
              </p>
            </div>
            <Button
              size="sm"
              variant={onlyOutstanding ? 'default' : 'secondary'}
              aria-pressed={onlyOutstanding}
              onClick={() => setOnlyOutstanding((on) => !on)}
            >
              Only outstanding
            </Button>
          </div>

          <div className="mt-3 bg-card">
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
        <div className="flex min-w-0 items-center gap-2.5">
          <GradientAvatar id={speaker.contact_id} name={speaker.name} size={24} />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{speaker.name}</div>
            {speaker.email && (
              <div className="truncate text-[11.5px] text-muted-foreground">{speaker.email}</div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="font-mono text-[11px] tabular-nums text-foreground">
          {speaker.session_count} {speaker.session_count === 1 ? 'session' : 'sessions'}
        </div>
        {mix && <div className="truncate text-[11px] capitalize text-muted-foreground">{mix}</div>}
      </TableCell>
      <TableCell>
        <OnboardingProgress speaker={speaker} />
      </TableCell>
      <TableCell
        className="font-mono text-[10.5px] text-muted-foreground"
        title={fullDate(speaker.last_portal_access_at)}
      >
        {speaker.last_portal_access_at ? (
          relativeDate(speaker.last_portal_access_at)
        ) : (
          <span>Never signed in</span>
        )}
      </TableCell>
      <TableCell>
        {speaker.last_email ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12.5px] text-foreground">
              {humanize(speaker.last_email.template_key ?? 'Email')}
            </span>
            {speaker.last_email.status && (
              <Badge
                variant="dot"
                className={EMAIL_STATUS_DOT[speaker.last_email.status] ?? 'before:bg-status-neutral'}
                title={fullDate(speaker.last_email.sent_at)}
              >
                {deliveryStatusLabel(speaker.last_email.status, speaker.last_email.last_error)}
              </Badge>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
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
      <Badge variant="dot" className="before:bg-success">
        Onboarded
      </Badge>
    )
  }

  if (total === 0) {
    return <Badge variant="dot">No tasks assigned</Badge>
  }

  return (
    <div className="flex items-center gap-3">
      <Progress
        value={done}
        max={total}
        aria-label={`${speaker.name} onboarding progress`}
      />
      <div className="flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground">
        <span>
          {done}/{total} done
        </span>
        <span>· {outstanding} outstanding</span>
      </div>
    </div>
  )
}

function StatBlock({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint?: string
}) {
  return (
    <div className="border-b border-border px-5 py-4 last:border-b-0 sm:[&:nth-child(odd)]:border-r lg:border-b-0 lg:border-r lg:last:border-r-0">
      <p className="font-mono text-[21px] font-medium tabular-nums leading-6 text-foreground">{value}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        {label}{hint ? <span> · {hint}</span> : null}
      </p>
    </div>
  )
}

function FunnelCard({ funnel }: { funnel?: SubmissionFunnel }) {
  const steps = FUNNEL_STEPS.map((step) => ({ ...step, count: funnel?.[step.key] ?? 0 }))
  return (
    <div className="border-b border-border px-5 py-4 last:border-b-0 sm:[&:nth-child(odd)]:border-r lg:border-b-0 lg:border-r lg:last:border-r-0">
      <p className="font-mono text-[21px] font-medium tabular-nums leading-6 text-foreground">
        {funnel?.total ?? 0}
      </p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">Submission funnel</p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {steps.map((step) => (
          <Badge key={step.key} variant="dot" className={`${step.dot} text-[11px]`}>
            {step.label}
            <span className="font-mono tabular-nums">{step.count}</span>
          </Badge>
        ))}
      </div>
    </div>
  )
}

function LoadingDashboard() {
  return (
    <>
      <div className="mt-6 grid border-y border-border bg-card sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border-b border-border px-5 py-4 lg:border-b-0 lg:border-r lg:last:border-r-0">
            <Skeleton className="h-6 w-16" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="mt-6 divide-y divide-border bg-card">
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
