import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { AlertCircle, ChevronDown, Inbox as InboxIcon, Layers, Mail } from 'lucide-react'

import {
  apiGet,
  getSessionDetail,
  unwrapList,
  updateSessionStatus,
  type EventSummary,
  type SessionAnswer,
  type SessionDetail,
  type SessionParticipant,
  type Submission,
  type SubmissionStatus,
} from '@/lib/api'
import { looseEquals, type AnswerValue } from '@/lib/rules'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
import { toast } from '@/ui/use-toast'

type TabKey = 'all' | SubmissionStatus

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'accept_queue', label: 'Accept Queue' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'decline_queue', label: 'Decline Queue' },
  { key: 'declined', label: 'Declined' },
]

const STATUS_META: Record<
  SubmissionStatus,
  { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' | 'muted' }
> = {
  draft: { label: 'Draft', variant: 'muted' },
  pending: { label: 'Pending', variant: 'warning' },
  accept_queue: { label: 'Accept Queue', variant: 'default' },
  accepted: { label: 'Accepted', variant: 'success' },
  decline_queue: { label: 'Decline Queue', variant: 'muted' },
  declined: { label: 'Declined', variant: 'destructive' },
  withdrawn: { label: 'Withdrawn', variant: 'muted' },
}

/** The decisions an operator can make from the inbox row menu. */
const STATUS_ACTIONS: SubmissionStatus[] = [
  'pending',
  'accept_queue',
  'accepted',
  'decline_queue',
  'declined',
]

/**
 * The same decisions as buttons, in the order a reviewer works through them:
 * queue first (reversible), final call second. Accept and Decline are the two
 * that send email downstream, so they read as the emphatic ones.
 */
const DECISIONS: Array<{
  status: SubmissionStatus
  label: string
  variant: 'default' | 'secondary' | 'destructive'
}> = [
  { status: 'accept_queue', label: 'Accept queue', variant: 'secondary' },
  { status: 'accepted', label: 'Accept', variant: 'default' },
  { status: 'decline_queue', label: 'Decline queue', variant: 'secondary' },
  { status: 'declined', label: 'Decline', variant: 'destructive' },
]

function statusLabel(status: SubmissionStatus): string {
  return STATUS_META[status]?.label ?? status
}

function StatusBadge({ status }: { status: SubmissionStatus }) {
  const meta = STATUS_META[status] ?? { label: status, variant: 'muted' as const }
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

function contactName(
  person: { first_name?: string | null; last_name?: string | null; email?: string | null } | null | undefined
): string {
  if (!person) return '—'
  const name = [person.first_name, person.last_name].filter(Boolean).join(' ').trim()
  return name || person.email || '—'
}

function submitterName(submission: Submission): string {
  return contactName(submission.submitter)
}

/** "3 days ago" — the inbox question is freshness, not the exact timestamp. */
function relativeDate(value?: string | null): string {
  if (!value) return '—'
  try {
    return formatDistanceToNow(parseISO(value), { addSuffix: true })
  } catch {
    return '—'
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

/**
 * Answers arrive as raw JSON. A checkbox may be `true` from the renderer or
 * `"true"` from a hand-rolled POST — `looseEquals` is the same coercion the
 * rules engine uses on both sides, so the inbox can't disagree with the form
 * about what an answer meant.
 */
function formatAnswer(value: unknown, fieldType?: string): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean' || fieldType === 'checkbox') {
    return looseEquals(value as AnswerValue, true) ? 'Yes' : 'No'
  }
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  const text = String(value)
  return text.trim() === '' ? '—' : text
}

export function Inbox() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<TabKey>('all')
  const [openId, setOpenId] = useState<string | null>(null)

  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = eventsQuery.data?.[0]

  const submissionsKey = ['submissions', event?.id]

  const submissionsQuery = useQuery({
    queryKey: submissionsKey,
    queryFn: () => apiGet<Submission[]>(`/api/events/${event!.id}/submissions`).then(unwrapList),
    enabled: Boolean(event?.id),
  })

  const submissions = useMemo(() => submissionsQuery.data ?? [], [submissionsQuery.data])

  const counts = useMemo(() => {
    const byStatus = new Map<string, number>()
    for (const s of submissions) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1)
    return (key: TabKey) => (key === 'all' ? submissions.length : (byStatus.get(key) ?? 0))
  }, [submissions])

  const rows = useMemo(
    () => (tab === 'all' ? submissions : submissions.filter((s) => s.status === tab)),
    [submissions, tab]
  )

  /** The row that opened the panel — renders instantly while the detail loads. */
  const openSubmission = useMemo(
    () => submissions.find((s) => s.id === openId) ?? null,
    [submissions, openId]
  )

  const detailQuery = useQuery({
    queryKey: ['session', openId],
    queryFn: () => getSessionDetail(openId!),
    enabled: Boolean(openId),
  })

  /**
   * Status moves are optimistic: the badge and the tab counts update on click,
   * and a failure rolls both back with the reason in a toast. Triaging a
   * hundred submissions shouldn't mean waiting on a hundred round trips.
   */
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SubmissionStatus }) =>
      updateSessionStatus(id, status),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: submissionsKey })
      const previousList = queryClient.getQueryData<Submission[]>(submissionsKey)
      queryClient.setQueryData<Submission[]>(submissionsKey, (current) =>
        current?.map((row) => (row.id === id ? { ...row, status } : row))
      )

      const detailKey = ['session', id]
      const previousDetail = queryClient.getQueryData<SessionDetail>(detailKey)
      if (previousDetail) {
        queryClient.setQueryData<SessionDetail>(detailKey, {
          ...previousDetail,
          session: { ...previousDetail.session, status },
        })
      }
      return { previousList, previousDetail }
    },
    onSuccess: (_data, variables) => {
      toast({ title: `Moved to ${statusLabel(variables.status)}` })
    },
    onError: (error: Error, variables, context) => {
      if (context?.previousList) queryClient.setQueryData(submissionsKey, context.previousList)
      if (context?.previousDetail) {
        queryClient.setQueryData(['session', variables.id], context.previousDetail)
      }
      toast({ variant: 'destructive', title: 'Update failed', description: error.message })
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: submissionsKey })
      queryClient.invalidateQueries({ queryKey: ['session', variables.id] })
    },
  })

  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && submissionsQuery.isPending)
  const error = eventsQuery.error ?? submissionsQuery.error

  const detailSession = detailQuery.data?.session ?? openSubmission

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Submissions</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Review and triage session submissions{event ? ` for ${event.name}` : ''}.
            </p>
          </div>
        </div>
        <Button variant="secondary" size="sm" disabled>
          Add submission
        </Button>
      </header>

      <div className="mt-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList variant="underline">
            {TABS.map(({ key, label }) => (
              <TabsTrigger key={key} value={key}>
                {label}
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-xs font-medium tabular-nums',
                    tab === key ? 'bg-primary-subtle text-primary' : 'bg-muted text-muted-foreground'
                  )}
                >
                  {counts(key)}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        {error ? (
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load submissions"
            description={error.message}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  eventsQuery.refetch()
                  submissionsQuery.refetch()
                }}
              >
                Try again
              </Button>
            }
          />
        ) : isLoading ? (
          <LoadingRows />
        ) : !event ? (
          <EmptyState
            icon={<InboxIcon className="h-6 w-6 text-muted-foreground" />}
            title="No events yet"
            description="Create an event in the API, then submissions will land here."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<InboxIcon className="h-6 w-6 text-muted-foreground" />}
            title={tab === 'all' ? 'No submissions yet' : 'Nothing in this queue'}
            description={
              tab === 'all'
                ? 'Share your call-for-papers form and submissions will show up here the moment they arrive.'
                : 'Move a submission into this queue from the row menu.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[110px]">ID</TableHead>
                <TableHead className="w-[38%]">Title</TableHead>
                <TableHead>Submitter</TableHead>
                <TableHead className="w-[150px]">Status</TableHead>
                <TableHead className="w-[140px]">Submitted</TableHead>
                <TableHead className="w-[60px] text-right sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((submission) => (
                <TableRow
                  key={submission.id}
                  className="cursor-pointer"
                  data-state={openId === submission.id ? 'selected' : undefined}
                  tabIndex={0}
                  onClick={() => setOpenId(submission.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpenId(submission.id)
                    }
                  }}
                >
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {submission.friendly_id ?? '—'}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-foreground">{submission.title || 'Untitled'}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-foreground">{submitterName(submission)}</div>
                    {submission.submitter?.email && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {submission.submitter.email}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={submission.status} />
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    title={fullDate(submission.submitted_at ?? submission.created_at)}
                  >
                    {relativeDate(submission.submitted_at ?? submission.created_at)}
                  </TableCell>
                  {/* The row opens the panel; the menu inside it must not. */}
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={updateStatus.isPending && updateStatus.variables?.id === submission.id}
                        >
                          Status
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Move to</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {STATUS_ACTIONS.map((status) => (
                          <DropdownMenuItem
                            key={status}
                            disabled={status === submission.status}
                            onSelect={() => updateStatus.mutate({ id: submission.id, status })}
                          >
                            {STATUS_META[status].label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {rows.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {rows.length} of {submissions.length} submissions
        </p>
      )}

      <Dialog
        open={Boolean(openId)}
        onOpenChange={(open) => {
          if (!open) setOpenId(null)
        }}
      >
        {/* A right-edge sheet: the list stays visible behind it, so triaging
            one submission never loses the reviewer's place in the queue. */}
        <DialogContent
          className={cn(
            'left-auto right-0 top-0 h-screen max-h-screen w-full max-w-none translate-x-0 translate-y-0',
            'flex flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-xl',
            'data-[state=open]:slide-in-from-right-8 data-[state=closed]:slide-out-to-right-8'
          )}
        >
          {detailSession ? (
            <>
              <div className="border-b border-border px-6 py-5 pr-12">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={detailSession.status} />
                  {detailSession.friendly_id && (
                    <span className="font-mono text-xs text-muted-foreground">
                      {detailSession.friendly_id}
                    </span>
                  )}
                </div>
                <DialogTitle className="mt-2 text-xl leading-snug">
                  {detailSession.title || 'Untitled'}
                </DialogTitle>
                <DialogDescription className="mt-1.5">
                  {submitterName(detailSession)}
                  {detailSession.submitter?.email ? ` · ${detailSession.submitter.email}` : ''}
                  {' · '}
                  <span title={fullDate(detailSession.submitted_at ?? detailSession.created_at)}>
                    submitted {relativeDate(detailSession.submitted_at ?? detailSession.created_at)}
                  </span>
                </DialogDescription>
              </div>

              {/* min-h-0 so this pane, not the sheet, is what scrolls — the
                  header and the decision buttons stay put. */}
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-app px-6 py-5">
                <SubmissionDetail
                  detail={detailQuery.data}
                  isPending={detailQuery.isPending}
                  error={detailQuery.error}
                  description={detailSession.description}
                />
              </div>

              <div className="border-t border-border px-6 py-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Decision
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {DECISIONS.map(({ status, label, variant }) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={variant}
                      disabled={detailSession.status === status || updateStatus.isPending}
                      onClick={() => updateStatus.mutate({ id: detailSession.id, status })}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="px-6 py-5">
              <DialogTitle className="text-xl">Submission</DialogTitle>
              <DialogDescription className="mt-1">Loading…</DialogDescription>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// --- detail panel body ----------------------------------------------------

function SubmissionDetail({
  detail,
  isPending,
  error,
  description,
}: {
  detail?: SessionDetail
  isPending: boolean
  error: Error | null
  description?: string | null
}) {
  if (error) {
    return (
      <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div>
          <p className="text-sm font-medium text-foreground">Couldn't load this submission</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    )
  }

  if (isPending || !detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {description && (
        <section>
          <PanelHeading title="Description" />
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground">
            {description}
          </p>
        </section>
      )}

      <section>
        <PanelHeading title="Answers" />
        {detail.answers.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This submission came in without any form answers.
          </p>
        ) : (
          // Definition list, in the form's own field order — an organizer reads
          // it top to bottom the way the speaker filled it in.
          <dl className="mt-2 divide-y divide-border">
            {detail.answers.map((answer: SessionAnswer) => (
              <div key={answer.field_id} className="py-3 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {answer.label}
                </dt>
                <dd className="mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground">
                  {formatAnswer(answer.value, answer.field_type)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section>
        <PanelHeading title="Participants" />
        {detail.participants.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No participants linked yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {detail.participants.map((participant: SessionParticipant) => (
              <li
                key={`${participant.contact_id}-${participant.role}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {contactName(participant)}
                  </p>
                  {participant.email && (
                    <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <Mail className="h-3 w-3 shrink-0" />
                      {participant.email}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {participant.is_primary && <Badge variant="default">Primary</Badge>}
                  <Badge variant="outline" className="capitalize">
                    {participant.role}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function PanelHeading({ title }: { title: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
  )
}

function LoadingRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="h-4 w-[38%]" />
          <Skeleton className="h-4 w-[22%]" />
          <Skeleton className="h-5 w-20 rounded-md" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  )
}

function EmptyState({
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
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">{icon}</div>
      <p className="mt-4 text-base font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
