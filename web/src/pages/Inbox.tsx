import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import {
  AlertCircle,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Eye,
  FileDown,
  Filter,
  Inbox as InboxIcon,
  Layers,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Upload,
} from 'lucide-react'

import {
  apiGet,
  decideSubmission,
  getSessionDetail,
  unwrapList,
  updateSessionStatus,
  type EventSummary,
  type SessionAnswer,
  type SessionDetail,
  type SessionParticipant,
  type Submission,
  type SubmissionDecision,
  type SubmissionDecisionResult,
  type SubmissionStatus,
} from '@/lib/api'
import { looseEquals, type AnswerValue } from '@/lib/rules'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Checkbox } from '@/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import { Input } from '@/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
import { Textarea } from '@/ui/textarea'
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

/** Rows per page in the footer's "Show:" control. */
const PAGE_SIZES = [10, 25, 50, 100]

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

/** The event runner's minimum review workflow, mapped onto the DB statuses. */
const DECISIONS: Array<{
  decision: SubmissionDecision
  targetStatus: SubmissionStatus
  label: string
  variant: 'default' | 'secondary' | 'destructive'
}> = [
  { decision: 'approve', targetStatus: 'accepted', label: 'Approve', variant: 'default' },
  { decision: 'maybe', targetStatus: 'accept_queue', label: 'Maybe', variant: 'secondary' },
  { decision: 'deny', targetStatus: 'declined', label: 'Deny', variant: 'destructive' },
]

const DECISION_STATUS: Record<SubmissionDecision, SubmissionStatus> = {
  approve: 'accepted',
  maybe: 'accept_queue',
  deny: 'declined',
}

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

/**
 * We never fetched the form catalog here, so "Source" is derived from whether a
 * submission carries a form id: a public CFP submission has one, an operator's
 * manual add does not. Enough to read like Sessionboard's Form/Manual column.
 */
function sourceLabel(submission: Submission): string {
  return submission.source_form_id ? 'Form' : 'Manual'
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

/** Which page numbers to render — windowed with ellipsis once there are many. */
function pageItems(current: number, count: number): Array<number | 'gap'> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1)
  const items: Array<number | 'gap'> = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(count - 1, current + 1)
  if (start > 2) items.push('gap')
  for (let p = start; p <= end; p++) items.push(p)
  if (end < count - 1) items.push('gap')
  items.push(count)
  return items
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Export the currently filtered rows — the one Options action that's live. */
function downloadCsv(rows: Submission[]): void {
  if (typeof document === 'undefined') return
  const header = ['ID', 'Title', 'Source', 'Submitter', 'Email', 'Status', 'Submitted']
  const lines = [header.map(csvCell).join(',')]
  for (const s of rows) {
    const submitter = submitterName(s)
    lines.push(
      [
        s.friendly_id ?? '',
        s.title ?? '',
        sourceLabel(s),
        submitter === '—' ? '' : submitter,
        s.submitter?.email ?? '',
        statusLabel(s.status),
        s.submitted_at ?? s.created_at ?? '',
      ]
        .map((v) => csvCell(String(v)))
        .join(',')
    )
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'submissions.csv'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function Inbox() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<TabKey>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [pendingDecision, setPendingDecision] = useState<SubmissionDecision | null>(null)
  const [speakerMessage, setSpeakerMessage] = useState('')
  const [emailDecision, setEmailDecision] = useState(false)

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

  const tabRows = useMemo(
    () => (tab === 'all' ? submissions : submissions.filter((s) => s.status === tab)),
    [submissions, tab]
  )

  /** Search is client-side over the already-fetched rows: title + submitter. */
  const query = search.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!query) return tabRows
    return tabRows.filter((s) => {
      const haystack = [s.title, submitterName(s), s.submitter?.email]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  }, [tabRows, query])

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pagedRows = useMemo(
    () => filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredRows, safePage, pageSize]
  )

  const rangeStart = filteredRows.length === 0 ? 0 : (safePage - 1) * pageSize + 1
  const rangeEnd = Math.min(safePage * pageSize, filteredRows.length)

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

  const resetDecisionForm = () => {
    setPendingDecision(null)
    setSpeakerMessage('')
    setEmailDecision(false)
  }

  const submitDecision = useMutation({
    mutationFn: ({
      id,
      decision,
      feedback,
      emailSpeaker,
    }: {
      id: string
      decision: SubmissionDecision
      feedback: string
      emailSpeaker: boolean
    }) =>
      decideSubmission(id, {
        decision,
        feedback: feedback || undefined,
        email_speaker: emailSpeaker,
      }),
    onMutate: async ({ id, decision }) => {
      const status = DECISION_STATUS[decision]
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
    onSuccess: (data: SubmissionDecisionResult, variables) => {
      if (variables.decision === 'approve') {
        toast({
          title: `Accepted — ${data.onboarding.tasks_assigned} onboarding tasks assigned to the speaker`,
        })
      } else {
        toast({
          title: variables.decision === 'maybe' ? 'Marked as maybe' : 'Submission denied',
          description: data.emailed ? 'The speaker was emailed with your message.' : undefined,
        })
      }
      resetDecisionForm()
    },
    onError: (error: Error, variables, context) => {
      if (context?.previousList) queryClient.setQueryData(submissionsKey, context.previousList)
      if (context?.previousDetail) {
        queryClient.setQueryData(['session', variables.id], context.previousDetail)
      }
      toast({ variant: 'destructive', title: 'Decision failed', description: error.message })
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: submissionsKey })
      queryClient.invalidateQueries({ queryKey: ['session', variables.id] })
    },
  })

  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && submissionsQuery.isPending)
  const error = eventsQuery.error ?? submissionsQuery.error

  const detailSession = detailQuery.data?.session ?? openSubmission
  const pendingDecisionMeta = pendingDecision
    ? DECISIONS.find((action) => action.decision === pendingDecision)
    : null

  const showToolbar = Boolean(event) && !error && !isLoading

  const notReady = (feature: string) =>
    toast({ title: `${feature} is coming soon`, description: 'Wiring this up is on the roadmap.' })

  const changeTab = (next: TabKey) => {
    setTab(next)
    setPage(1)
  }

  const changeSearch = (next: string) => {
    setSearch(next)
    setPage(1)
  }

  const allPageSelected = pagedRows.length > 0 && pagedRows.every((r) => selected.has(r.id))
  const somePageSelected = pagedRows.some((r) => selected.has(r.id))
  const headerChecked: boolean | 'indeterminate' = allPageSelected
    ? true
    : somePageSelected
      ? 'indeterminate'
      : false

  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (pagedRows.every((r) => next.has(r.id))) {
        pagedRows.forEach((r) => next.delete(r.id))
      } else {
        pagedRows.forEach((r) => next.add(r.id))
      }
      return next
    })
  }

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
        <Button
          onClick={() =>
            toast({
              title: 'Manual add is coming soon',
              description: 'Share your call-for-papers form to start collecting submissions.',
            })
          }
        >
          <Plus />
          Add submission
        </Button>
      </header>

      <div className="mt-6">
        <Tabs value={tab} onValueChange={(v) => changeTab(v as TabKey)}>
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

      {showToolbar && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => changeSearch(e.target.value)}
              placeholder="Search all submissions…"
              aria-label="Search all submissions"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => notReady('Saved views')}>
              <Eye />
              Saved Views
              <ChevronDown />
            </Button>
            <Button variant="outline" size="sm" onClick={() => notReady('Column settings')}>
              <Columns3 />
              Columns
            </Button>
            <Button variant="outline" size="sm" onClick={() => notReady('Sorting')}>
              <ArrowUpDown />
              Sort
            </Button>
            <Button variant="outline" size="sm" onClick={() => notReady('Filters')}>
              <Filter />
              Filter
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <MoreHorizontal />
                  Options
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Data</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => notReady('Importing sessions')}>
                  <Upload />
                  Import sessions
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    downloadCsv(filteredRows)
                    toast({ title: 'Exported CSV', description: `${filteredRows.length} rows.` })
                  }}
                >
                  <Download />
                  Export .CSV
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => notReady('XLSX export')}>
                  <FileDown />
                  Export .XLSX
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => notReady('File bundle download')}>
                  <Download />
                  Download files bundle…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

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
        ) : filteredRows.length === 0 ? (
          query ? (
            <EmptyState
              icon={<Search className="h-6 w-6 text-muted-foreground" />}
              title="No matches"
              description={`Nothing here matches “${search.trim()}”. Try a different search.`}
            />
          ) : (
            <EmptyState
              icon={<InboxIcon className="h-6 w-6 text-muted-foreground" />}
              title={tab === 'all' ? 'No submissions yet' : 'Nothing in this queue'}
              description={
                tab === 'all'
                  ? 'Share your call-for-papers form and submissions will show up here the moment they arrive.'
                  : 'Move a submission into this queue from the row menu.'
              }
            />
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[44px] pr-0">
                  <Checkbox
                    checked={headerChecked}
                    onCheckedChange={toggleAllOnPage}
                    aria-label="Select all submissions on this page"
                  />
                </TableHead>
                <TableHead className="w-[40px] px-0">
                  <span className="sr-only">Edit</span>
                </TableHead>
                <TableHead className="w-[110px]">ID</TableHead>
                <TableHead className="w-[100px]">Source</TableHead>
                <TableHead className="w-[34%]">Title</TableHead>
                <TableHead>Submitter</TableHead>
                <TableHead className="w-[150px]">Status</TableHead>
                <TableHead className="w-[140px]">Submitted</TableHead>
                <TableHead className="w-[60px] text-right sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedRows.map((submission) => (
                <TableRow
                  key={submission.id}
                  className="cursor-pointer"
                  data-state={
                    openId === submission.id || selected.has(submission.id) ? 'selected' : undefined
                  }
                  tabIndex={0}
                  onClick={() => setOpenId(submission.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpenId(submission.id)
                    }
                  }}
                >
                  <TableCell
                    className="pr-0"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selected.has(submission.id)}
                      onCheckedChange={() => toggleOne(submission.id)}
                      aria-label={`Select ${submission.title || 'submission'}`}
                    />
                  </TableCell>
                  {/* Same destination as the row click; present because Sessionboard
                      surfaces an explicit edit affordance per row. */}
                  <TableCell className="px-0" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${submission.title || 'submission'}`}
                      onClick={() => setOpenId(submission.id)}
                    >
                      <Pencil />
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {submission.friendly_id ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {sourceLabel(submission)}
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

      {!error && !isLoading && filteredRows.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>
              {rangeStart}–{rangeEnd} of {filteredRows.length} rows
            </span>
            {selected.size > 0 && (
              <span className="text-foreground">· {selected.size} selected</span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft />
              </Button>
              {pageItems(safePage, pageCount).map((item, i) =>
                item === 'gap' ? (
                  <span key={`gap-${i}`} className="px-1.5 text-muted-foreground">
                    …
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setPage(item)}
                    aria-current={item === safePage ? 'page' : undefined}
                    className={cn(
                      'inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-sm tabular-nums transition-colors',
                      item === safePage
                        ? 'border-primary-strong bg-primary text-primary-foreground'
                        : 'border-input bg-card text-foreground hover:bg-accent'
                    )}
                  >
                    {item}
                  </button>
                )
              )}
              <Button
                variant="outline"
                size="icon-sm"
                disabled={safePage >= pageCount}
                onClick={() => setPage(safePage + 1)}
                aria-label="Next page"
              >
                <ChevronRight />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span>Show:</span>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v))
                  setPage(1)
                }}
              >
                <SelectTrigger className="h-8 w-[74px]" aria-label="Rows per page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={Boolean(openId)}
        onOpenChange={(open) => {
          if (!open) {
            setOpenId(null)
            resetDecisionForm()
          }
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
                  {DECISIONS.map(({ decision, targetStatus, label, variant }) => (
                    <Button
                      key={decision}
                      size="sm"
                      variant={variant}
                      disabled={
                        detailSession.status === targetStatus ||
                        updateStatus.isPending ||
                        submitDecision.isPending
                      }
                      aria-pressed={pendingDecision === decision}
                      onClick={() => {
                        setPendingDecision(decision)
                        setSpeakerMessage('')
                        setEmailDecision(false)
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>

                {pendingDecision && pendingDecisionMeta && (
                  <form
                    className="mt-3 rounded-lg border border-border bg-muted/40 p-4"
                    onSubmit={(event) => {
                      event.preventDefault()
                      submitDecision.mutate({
                        id: detailSession.id,
                        decision: pendingDecision,
                        feedback: speakerMessage.trim(),
                        emailSpeaker: emailDecision && Boolean(speakerMessage.trim()),
                      })
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          Confirm {pendingDecisionMeta.label.toLowerCase()}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          This moves the submission to {statusLabel(pendingDecisionMeta.targetStatus)}.
                        </p>
                      </div>
                      <StatusBadge status={pendingDecisionMeta.targetStatus} />
                    </div>

                    <div className="mt-3 space-y-1.5">
                      <label
                        htmlFor="decision-message"
                        className="text-xs font-medium text-foreground"
                      >
                        Message to speaker (optional)
                      </label>
                      <Textarea
                        id="decision-message"
                        value={speakerMessage}
                        onChange={(event) => {
                          const message = event.target.value
                          setSpeakerMessage(message)
                          if (!message.trim()) setEmailDecision(false)
                        }}
                        placeholder="Add context, requested changes, or a personal note."
                        className="min-h-[88px] bg-card text-sm"
                        disabled={submitDecision.isPending}
                      />
                    </div>

                    <div className="mt-3 flex items-start gap-2.5">
                      <Checkbox
                        id="email-decision"
                        checked={emailDecision}
                        disabled={!speakerMessage.trim() || submitDecision.isPending}
                        onCheckedChange={(checked) => setEmailDecision(checked === true)}
                        aria-describedby="email-decision-help"
                      />
                      <div>
                        <label
                          htmlFor="email-decision"
                          className={cn(
                            'block text-sm font-medium',
                            speakerMessage.trim()
                              ? 'cursor-pointer text-foreground'
                              : 'text-muted-foreground'
                          )}
                        >
                          Email this decision to the speaker
                        </label>
                        <p id="email-decision-help" className="mt-0.5 text-xs text-muted-foreground">
                          {speakerMessage.trim()
                            ? 'The submitter and any linked speakers receive your message.'
                            : 'Add a message above to enable email.'}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={submitDecision.isPending}
                        onClick={resetDecisionForm}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        variant={pendingDecisionMeta.variant}
                        disabled={submitDecision.isPending}
                      >
                        {submitDecision.isPending
                          ? 'Saving decision…'
                          : `Confirm ${pendingDecisionMeta.label.toLowerCase()}`}
                      </Button>
                    </div>
                  </form>
                )}
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
