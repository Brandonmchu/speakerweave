import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { AlertCircle, ChevronDown, Inbox as InboxIcon, Layers } from 'lucide-react'

import {
  apiGet,
  apiPatch,
  unwrapList,
  type EventSummary,
  type Submission,
  type SubmissionStatus,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
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

function StatusBadge({ status }: { status: SubmissionStatus }) {
  const meta = STATUS_META[status] ?? { label: status, variant: 'muted' as const }
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

function submitterName(submission: Submission): string {
  const s = submission.submitter
  if (!s) return '—'
  const name = [s.first_name, s.last_name].filter(Boolean).join(' ').trim()
  return name || s.email || '—'
}

function formatDate(value?: string | null): string {
  if (!value) return '—'
  try {
    return format(parseISO(value), 'MMM d, yyyy')
  } catch {
    return '—'
  }
}

export function Inbox() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<TabKey>('all')

  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = eventsQuery.data?.[0]

  const submissionsQuery = useQuery({
    queryKey: ['submissions', event?.id],
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

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SubmissionStatus }) =>
      apiPatch<Submission>(`/api/sessions/${id}`, { status }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['submissions', event?.id] })
      toast({ title: `Moved to ${STATUS_META[variables.status].label}` })
    },
    onError: (error: Error) => {
      toast({ variant: 'destructive', title: 'Update failed', description: error.message })
    },
  })

  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && submissionsQuery.isPending)
  const error = eventsQuery.error ?? submissionsQuery.error

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
                <TableHead className="w-[45%]">Title</TableHead>
                <TableHead>Submitter</TableHead>
                <TableHead className="w-[150px]">Status</TableHead>
                <TableHead className="w-[140px]">Submitted</TableHead>
                <TableHead className="w-[60px] text-right sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((submission) => (
                <TableRow key={submission.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{submission.title || 'Untitled'}</div>
                    {submission.friendly_id && (
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {submission.friendly_id}
                      </div>
                    )}
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
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    {formatDate(submission.submitted_at ?? submission.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
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
    </div>
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
