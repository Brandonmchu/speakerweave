import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import {
  AlertCircle,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDown,
  Filter,
  Inbox as InboxIcon,
  Layers,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'

import {
  addSessionParticipant,
  apiGet,
  createSubmission,
  decideSubmission,
  getSessionDetail,
  removeSessionParticipant,
  setPrimaryParticipant,
  unwrapList,
  updateSession,
  updateSessionStatus,
  type EventSummary,
  type ParticipantRole,
  type SessionAnswer,
  type SessionDetail,
  type SessionParticipant,
  type SessionReviewAggregate,
  type Submission,
  type SubmissionDecision,
  type SubmissionDecisionResult,
  type SubmissionStatus,
} from '@/lib/api'
import { listTaxonomy, type TaxonomyRow } from '@/lib/adminApi'
import { looseEquals, type AnswerValue } from '@/lib/rules'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import { Input } from '@/ui/input'
import { NativeSelect } from '@/ui/native-select'
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

/** Client-side sort orders for the fetched rows. */
type SortKey = 'newest' | 'oldest' | 'title' | 'status' | 'score_desc' | 'score_asc'

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'status', label: 'Status' },
  { value: 'score_desc', label: 'Highest score' },
  { value: 'score_asc', label: 'Lowest score' },
]

/** Tab order doubles as the sort order when sorting by status. */
const STATUS_RANK: Record<SubmissionStatus, number> = {
  draft: 0,
  pending: 1,
  accept_queue: 2,
  accepted: 3,
  decline_queue: 4,
  declined: 5,
  withdrawn: 6,
}

function submittedTime(submission: Submission): number {
  const value = submission.submitted_at ?? submission.created_at
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Max score on the plan's scale — reviewers score 1–5 or 1–10. */
function scaleMax(scale?: string | null): number {
  return scale === '1_10' ? 10 : 5
}

function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(1)
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

/** Resolves a submission's track id to its human name (blank when unknown). */
export type TrackNameFn = (id?: string | null) => string

/**
 * Build the scores CSV for the given (already-filtered) rows — one line per
 * submission carrying its review score and count, so an organizer can rank and
 * archive decisions offline. Every cell is quoted, so commas in a title never
 * shift a column.
 */
export function buildSubmissionsCsv(rows: Submission[], trackName?: TrackNameFn): string {
  const header = [
    'ID',
    'Title',
    'Submitter',
    'Track',
    'Status',
    'Review score',
    'Review count',
    'Submitted',
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const s of rows) {
    const submitter = submitterName(s)
    lines.push(
      [
        s.friendly_id ?? '',
        s.title ?? '',
        submitter === '—' ? '' : submitter,
        trackName ? trackName(s.track_id) : (s.track_id ?? ''),
        statusLabel(s.status),
        s.review_score ?? '',
        s.review_count ?? '',
        s.submitted_at ?? s.created_at ?? '',
      ]
        .map((v) => csvCell(String(v)))
        .join(',')
    )
  }
  return lines.join('\n')
}

/** Export the currently filtered rows — the one Options action that's live. */
function downloadCsv(rows: Submission[], trackName?: TrackNameFn): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([buildSubmissionsCsv(rows, trackName)], {
    type: 'text/csv;charset=utf-8;',
  })
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
  const [sortKey, setSortKey] = useState<SortKey>('newest')
  const [filterTrack, setFilterTrack] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [addOpen, setAddOpen] = useState(false)
  // The drawer's edit mode (CNT-09). `editIntent` is the request to edit; the
  // form only opens once the authoritative detail has loaded, so a Save can
  // never write a half-known row back over the real one.
  const [editIntent, setEditIntent] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editAbstract, setEditAbstract] = useState('')

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

  // Tracks and formats power the Add-submission selects and the track filter.
  // They are small per-event lists; a failure just leaves those controls empty.
  const tracksQuery = useQuery({
    queryKey: ['tracks', event?.id],
    queryFn: () => listTaxonomy(event!.id, 'tracks'),
    enabled: Boolean(event?.id),
  })
  const formatsQuery = useQuery({
    queryKey: ['formats', event?.id],
    queryFn: () => listTaxonomy(event!.id, 'formats'),
    enabled: Boolean(event?.id),
  })
  const tracks = useMemo(() => tracksQuery.data ?? [], [tracksQuery.data])
  const formats = useMemo(() => formatsQuery.data ?? [], [formatsQuery.data])

  // Resolves a submission's track id to its name for the CSV export; the row
  // only carries `track_id`, and a blank reads cleaner than a raw uuid.
  const trackNameById = useMemo<TrackNameFn>(() => {
    const byId = new Map(tracks.map((t) => [t.id, t.name]))
    return (id) => (id ? (byId.get(id) ?? '') : '')
  }, [tracks])

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

  /**
   * Search, filter, and sort are all client-side over the already-fetched rows.
   * Search matches title + submitter; the filters narrow by track and status;
   * the sort reorders what's left. Kept in one memo so pagination sees the final
   * list.
   */
  const query = search.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    let rows = tabRows
    if (query) {
      rows = rows.filter((s) => {
        const haystack = [s.title, submitterName(s), s.submitter?.email]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(query)
      })
    }
    if (filterTrack !== 'all') {
      rows = rows.filter((s) => (s.track_id ?? null) === filterTrack)
    }
    if (filterStatus !== 'all') {
      rows = rows.filter((s) => s.status === filterStatus)
    }
    const sorted = [...rows]
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'oldest':
          return submittedTime(a) - submittedTime(b)
        case 'title':
          return (a.title || '').localeCompare(b.title || '')
        case 'status':
          return (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)
        case 'score_desc':
        case 'score_asc': {
          // Rank by review score; submissions without a score always sort to the
          // bottom, whichever direction the reader picked.
          const av = a.review_score ?? null
          const bv = b.review_score ?? null
          if (av === null && bv === null) return submittedTime(b) - submittedTime(a)
          if (av === null) return 1
          if (bv === null) return -1
          return sortKey === 'score_desc' ? bv - av : av - bv
        }
        case 'newest':
        default:
          return submittedTime(b) - submittedTime(a)
      }
    })
    return sorted
  }, [tabRows, query, filterTrack, filterStatus, sortKey])

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

  // Seed the edit form from the loaded detail — never from the list row, which
  // carries no abstract and would blank it on save.
  const loadedDetail = detailQuery.data
  useEffect(() => {
    if (!editIntent || !loadedDetail) return
    setEditTitle(loadedDetail.session.title ?? '')
    setEditAbstract(loadedDetail.session.description ?? '')
    setEditing(true)
    setEditIntent(false)
  }, [editIntent, loadedDetail])

  const closeEditor = () => {
    setEditIntent(false)
    setEditing(false)
  }

  /** Open the drawer on a row, optionally straight into edit mode. */
  const openRow = (id: string, edit = false) => {
    closeEditor()
    setOpenId(id)
    if (edit) setEditIntent(true)
  }

  /**
   * The central session edit (CNT-09): title + abstract, saved from the drawer
   * the organizer is already reading the submission in. On success both the
   * drawer and the list row are refetched, so the new title is visible in the
   * queue without a reload.
   */
  const saveSessionEdits = useMutation({
    mutationFn: ({ id, title, description }: { id: string; title: string; description: string }) =>
      updateSession(id, { title, description }),
    onSuccess: (session) => {
      toast({ title: 'Session updated', description: `Saved “${session.title || 'Untitled'}”.` })
      closeEditor()
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save", description: error.message }),
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: submissionsKey })
      queryClient.invalidateQueries({ queryKey: ['session', variables.id] })
    },
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

  const addSubmission = useMutation({
    mutationFn: (input: Parameters<typeof createSubmission>[1]) =>
      createSubmission(event!.id, input),
    onSuccess: (session) => {
      toast({ title: 'Submission added', description: `${session.title || 'Untitled'} is now pending.` })
      setAddOpen(false)
      queryClient.invalidateQueries({ queryKey: submissionsKey })
    },
    onError: (mutationError: Error) => {
      toast({ variant: 'destructive', title: "Couldn't add submission", description: mutationError.message })
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

  // Any reorder/narrow sends the reader back to page 1 — page 3 of the old list
  // is meaningless against the new one.
  const changeSort = (next: SortKey) => {
    setSortKey(next)
    setPage(1)
  }
  const changeFilterTrack = (next: string) => {
    setFilterTrack(next)
    setPage(1)
  }
  const changeFilterStatus = (next: string) => {
    setFilterStatus(next)
    setPage(1)
  }
  const filtersActive = filterTrack !== 'all' || filterStatus !== 'all'

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
        <Button onClick={() => setAddOpen(true)} disabled={!event}>
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
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <ArrowUpDown className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">Sort</span>
              <NativeSelect
                aria-label="Sort submissions"
                value={sortKey}
                onValueChange={(value) => changeSort(value as SortKey)}
                options={SORT_OPTIONS}
                className="h-9 w-[150px]"
              />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Filter className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">Track</span>
              <NativeSelect
                aria-label="Filter by track"
                value={filterTrack}
                onValueChange={changeFilterTrack}
                options={[
                  { value: 'all', label: 'All tracks' },
                  ...tracks.map((t) => ({ value: t.id, label: t.name })),
                ]}
                className="h-9 w-[150px]"
              />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="sr-only sm:not-sr-only">Status</span>
              <NativeSelect
                aria-label="Filter by status"
                value={filterStatus}
                onValueChange={changeFilterStatus}
                options={[
                  { value: 'all', label: 'All statuses' },
                  ...STATUS_ACTIONS.map((status) => ({
                    value: status,
                    label: STATUS_META[status].label,
                  })),
                ]}
                className="h-9 w-[150px]"
              />
            </label>
            {filtersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  changeFilterTrack('all')
                  changeFilterStatus('all')
                }}
              >
                Clear filters
              </Button>
            )}
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
                    downloadCsv(filteredRows, trackNameById)
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
                <TableHead className="w-[30%]">Title</TableHead>
                <TableHead>Submitter</TableHead>
                <TableHead className="w-[90px]">Score</TableHead>
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
                  onClick={() => openRow(submission.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openRow(submission.id)
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
                  {/* The row opens the drawer to read; the pencil opens the same
                      drawer already in edit mode, so "fix this title" is one
                      click from the queue. */}
                  <TableCell className="px-0" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${submission.title || 'submission'}`}
                      data-testid={`edit-row-${submission.id}`}
                      onClick={() => openRow(submission.id, true)}
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
                    <ReviewScoreBadge
                      score={submission.review_score}
                      count={submission.review_count}
                    />
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
            closeEditor()
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
                  {!editing && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="ml-auto"
                      data-testid="edit-session"
                      disabled={saveSessionEdits.isPending}
                      // The form opens as soon as the detail lands (see the
                      // seeding effect) — never disabled on a pending load, so
                      // the click is always accepted.
                      onClick={() => setEditIntent(true)}
                    >
                      <Pencil />
                      Edit
                    </Button>
                  )}
                </div>
                {editing ? (
                  <>
                    {/* Radix needs a title for the sheet's accessible name even
                        while the visible one is an input. */}
                    <DialogTitle className="sr-only">Edit submission</DialogTitle>
                    <div className="mt-2 space-y-1.5">
                      <label
                        htmlFor="session-title"
                        className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
                      >
                        Title
                      </label>
                      <Input
                        id="session-title"
                        data-testid="session-title-input"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        placeholder="Session title"
                        className="text-base font-medium"
                      />
                    </div>
                  </>
                ) : (
                  <DialogTitle className="mt-2 text-xl leading-snug">
                    {detailSession.title || 'Untitled'}
                  </DialogTitle>
                )}
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
                {editing && (
                  <form
                    className="mb-6 rounded-lg border border-border bg-muted/40 p-4"
                    onSubmit={(formEvent) => {
                      formEvent.preventDefault()
                      if (!editTitle.trim()) return
                      saveSessionEdits.mutate({
                        id: detailSession.id,
                        title: editTitle.trim(),
                        description: editAbstract,
                      })
                    }}
                  >
                    <div className="space-y-1.5">
                      <label
                        htmlFor="session-abstract"
                        className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
                      >
                        Abstract
                      </label>
                      <Textarea
                        id="session-abstract"
                        data-testid="session-abstract-input"
                        value={editAbstract}
                        onChange={(e) => setEditAbstract(e.target.value)}
                        placeholder="A short description of the session."
                        className="min-h-[140px] bg-card text-sm"
                        disabled={saveSessionEdits.isPending}
                      />
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      {!editTitle.trim() && (
                        <span className="mr-auto text-xs text-destructive">
                          A session needs a title.
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={saveSessionEdits.isPending}
                        onClick={closeEditor}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!editTitle.trim() || saveSessionEdits.isPending}
                      >
                        {saveSessionEdits.isPending ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </form>
                )}
                <SubmissionDetail
                  detail={detailQuery.data}
                  isPending={detailQuery.isPending}
                  error={detailQuery.error}
                  description={editing ? null : detailSession.description}
                  // In edit mode the read-only roster is replaced by the
                  // editable one, so the drawer never shows two of them.
                  participantsEditor={
                    editing && detailQuery.data ? (
                      <ParticipantsEditor
                        sessionId={detailSession.id}
                        participants={detailQuery.data.participants}
                        onChanged={() =>
                          queryClient.invalidateQueries({ queryKey: ['session', detailSession.id] })
                        }
                      />
                    ) : null
                  }
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
                      {/* A NATIVE checkbox, not the Radix one. Radix renders a
                          <button role="checkbox"> beside an aria-hidden input,
                          so anything that drives the page by its form controls
                          (a test, a screen reader shortcut, an eval script)
                          finds an input it cannot click. This is the real
                          control, wired to its own <label htmlFor>. */}
                      <input
                        type="checkbox"
                        id="email-decision"
                        data-testid="email-decision"
                        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                        checked={emailDecision}
                        disabled={!speakerMessage.trim() || submitDecision.isPending}
                        onChange={(event) => setEmailDecision(event.target.checked)}
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

      <AddSubmissionDialog
        open={addOpen}
        onOpenChange={(next) => {
          if (!addSubmission.isPending) setAddOpen(next)
        }}
        tracks={tracks}
        formats={formats}
        isSubmitting={addSubmission.isPending}
        onSubmit={(input) => addSubmission.mutate(input)}
      />
    </div>
  )
}

// --- add submission dialog -------------------------------------------------

function AddSubmissionDialog({
  open,
  onOpenChange,
  tracks,
  formats,
  isSubmitting,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tracks: TaxonomyRow[]
  formats: TaxonomyRow[]
  isSubmitting: boolean
  onSubmit: (input: Parameters<typeof createSubmission>[1]) => void
}) {
  const [title, setTitle] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [abstract, setAbstract] = useState('')
  const [trackId, setTrackId] = useState('')
  const [formatId, setFormatId] = useState('')

  // Reset the form each time the dialog opens, so a second add never starts
  // pre-filled with the last one.
  const reset = () => {
    setTitle('')
    setName('')
    setEmail('')
    setAbstract('')
    setTrackId('')
    setFormatId('')
  }

  const canSubmit = title.trim() !== '' && email.trim() !== '' && !isSubmitting

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add submission</DialogTitle>
          <DialogDescription>
            Enter a submission by hand. It lands in Pending, exactly like a form submission.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            onSubmit({
              title: title.trim(),
              submitter_name: name.trim(),
              submitter_email: email.trim(),
              abstract: abstract.trim(),
              track_id: trackId || undefined,
              format_id: formatId || undefined,
            })
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="add-title" className="text-sm font-medium text-foreground">
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              id="add-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Talk title"
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="add-name" className="text-sm font-medium text-foreground">
                Submitter name
              </label>
              <Input
                id="add-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ada Lovelace"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="add-email" className="text-sm font-medium text-foreground">
                Submitter email <span className="text-destructive">*</span>
              </label>
              <Input
                id="add-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="ada@example.com"
                required
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="add-track" className="text-sm font-medium text-foreground">
                Track
              </label>
              <NativeSelect
                id="add-track"
                value={trackId}
                onValueChange={setTrackId}
                placeholder="No track"
                options={tracks.map((track) => ({ value: track.id, label: track.name }))}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="add-format" className="text-sm font-medium text-foreground">
                Format
              </label>
              <NativeSelect
                id="add-format"
                value={formatId}
                onValueChange={setFormatId}
                placeholder="No format"
                options={formats.map((format) => ({ value: format.id, label: format.name }))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="add-abstract" className="text-sm font-medium text-foreground">
              Abstract
            </label>
            <Textarea
              id="add-abstract"
              value={abstract}
              onChange={(event) => setAbstract(event.target.value)}
              placeholder="A short description of the session."
              className="min-h-[96px]"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? 'Adding…' : 'Add submission'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- detail panel body ----------------------------------------------------

function SubmissionDetail({
  detail,
  isPending,
  error,
  description,
  participantsEditor,
}: {
  detail?: SessionDetail
  isPending: boolean
  error: Error | null
  description?: string | null
  /** Replaces the read-only roster while the drawer is in edit mode. */
  participantsEditor?: ReactNode
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

  const people = dedupeParticipants(detail.participants)

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

      <ReviewsSection reviews={detail.reviews} />

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
        {participantsEditor ? (
          participantsEditor
        ) : people.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No participants linked yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {people.map((person) => (
              <li
                key={person.key}
                data-testid={`participant-${person.key}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {contactName(person)}
                  </p>
                  {person.email && (
                    <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <Mail className="h-3 w-3 shrink-0" />
                      {person.email}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {person.is_primary && <Badge variant="default">Primary</Badge>}
                  <Badge variant="outline" className="capitalize">
                    {person.roleLabel}
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

/**
 * The drawer's participants editor (ABS-11).
 *
 * Co-speakers were writable at submission time and frozen forever after, which
 * is exactly backwards: the CFP form is filled in once, while people join a
 * talk, drop off it and hand over the lead for months afterwards. This is the
 * organizer's side of that — add, remove, and re-point the primary speaker —
 * on the same deduped view the read-only panel shows, so the storage encoding
 * (primary speaker + submitter-of-record rows for the same human) stays an
 * implementation detail rather than something to explain in the UI.
 */
function ParticipantsEditor({
  sessionId,
  participants,
  onChanged,
}: {
  sessionId: string
  participants: SessionParticipant[]
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const people = dedupeParticipants(participants)

  const settle = (title: string) => async () => {
    setName('')
    setEmail('')
    onChanged()
    toast({ title })
  }
  const fail = (title: string) => (error: Error) =>
    toast({ variant: 'destructive', title, description: error.message })

  const add = useMutation({
    mutationFn: () =>
      addSessionParticipant(sessionId, { name: name.trim(), email: email.trim() }),
    onSuccess: settle('Co-speaker added'),
    onError: fail("Couldn't add that person"),
  })
  const remove = useMutation({
    mutationFn: (contactId: string) => removeSessionParticipant(sessionId, contactId),
    onSuccess: settle('Participant removed'),
    onError: fail("Couldn't remove that person"),
  })
  const promote = useMutation({
    mutationFn: (contactId: string) => setPrimaryParticipant(sessionId, contactId),
    onSuccess: settle('Primary speaker updated'),
    onError: fail("Couldn't change the primary speaker"),
  })

  const busy = add.isPending || remove.isPending || promote.isPending

  return (
    <div className="mt-2 space-y-3">
      {people.length === 0 ? (
        <p className="text-sm text-muted-foreground">No participants linked yet.</p>
      ) : (
        <ul className="space-y-2">
          {people.map((person) => (
            <li
              key={person.key}
              data-testid={`edit-participant-${person.key}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {contactName(person)}
                </p>
                {person.email && (
                  <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <Mail className="h-3 w-3 shrink-0" />
                    {person.email}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {person.is_primary ? (
                  <Badge variant="default">Primary</Badge>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy || !person.contact_id}
                    onClick={() => promote.mutate(String(person.contact_id))}
                  >
                    Make primary
                  </Button>
                )}
                <Badge variant="outline" className="capitalize">
                  {person.roleLabel}
                </Badge>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${contactName(person)}`}
                  // The primary speaker can't just be dropped — hand the lead
                  // over first, which is the same rule the server enforces.
                  disabled={busy || Boolean(person.is_primary) || !person.contact_id}
                  title={
                    person.is_primary
                      ? 'Make someone else primary before removing this speaker'
                      : `Remove ${contactName(person)}`
                  }
                  onClick={() => remove.mutate(String(person.contact_id))}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border border-dashed border-border p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Add a co-speaker
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]">
          <Input
            aria-label="Co-speaker name"
            placeholder="Marcus Okafor"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            aria-label="Co-speaker email"
            type="email"
            placeholder="marcus@example.com"
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !email.includes('@')}
            onClick={() => add.mutate()}
          >
            <Plus />
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function PanelHeading({ title }: { title: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
  )
}

/** One participant row as the drawer shows it: one PERSON, all their roles. */
interface DedupedParticipant extends SessionParticipant {
  key: string
  roles: ParticipantRole[]
  roleLabel: string
}

const PARTICIPANT_ROLE_ORDER: ParticipantRole[] = ['speaker', 'submitter', 'moderator', 'panelist']

function roleRank(role: ParticipantRole | undefined): number {
  const index = PARTICIPANT_ROLE_ORDER.indexOf(role as ParticipantRole)
  return index === -1 ? PARTICIPANT_ROLE_ORDER.length : index
}

/**
 * Collapse a session's participant rows to one entry per contact.
 *
 * A CFP submitter is deliberately stored TWICE — as the primary 'speaker' and
 * as the 'submitter' of record — so that adding a co-speaker can't drop them
 * from the public program. That is a storage decision, not something to show:
 * printed verbatim the drawer listed the same human as "Primary speaker" and
 * again as "submitter". Here their roles merge into one label ("Speaker ·
 * Submitter") on a single row.
 */
function dedupeParticipants(participants: SessionParticipant[]): DedupedParticipant[] {
  const byContact = new Map<string, DedupedParticipant>()
  participants.forEach((participant, index) => {
    const key = String(
      participant.contact_id || participant.email || `${participant.role ?? 'participant'}-${index}`
    )
    const existing = byContact.get(key)
    if (!existing) {
      byContact.set(key, {
        ...participant,
        key,
        roles: participant.role ? [participant.role] : [],
        roleLabel: '',
      })
      return
    }
    if (participant.role && !existing.roles.includes(participant.role)) {
      existing.roles.push(participant.role)
    }
    existing.is_primary = Boolean(existing.is_primary) || Boolean(participant.is_primary)
    // Keep whichever row carried the contact details.
    existing.first_name = existing.first_name || participant.first_name
    existing.last_name = existing.last_name || participant.last_name
    existing.email = existing.email || participant.email
  })

  return [...byContact.values()]
    .map((person) => {
      const roles = [...person.roles].sort((a, b) => roleRank(a) - roleRank(b))
      return {
        ...person,
        roles,
        role: roles[0] ?? person.role,
        roleLabel: roles.length ? roles.join(' · ') : String(person.role ?? ''),
      }
    })
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || roleRank(a.role) - roleRank(b.role))
}

/** The average review score shown in the table's Score column. */
function ReviewScoreBadge({
  score,
  count,
}: {
  score?: number | null
  count?: number | null
}) {
  if (score === null || score === undefined) {
    return <span className="text-sm text-muted-foreground">—</span>
  }
  return (
    <Badge
      variant="default"
      className="gap-1 tabular-nums"
      title={`${formatScore(score)} average across ${count ?? 0} review${count === 1 ? '' : 's'}`}
    >
      <Star className="h-3 w-3" />
      {formatScore(score)}
    </Badge>
  )
}

/**
 * The organizer's read of what reviewers scored and wrote — the far side of the
 * review roundtrip. Reviewer identity is already anonymized server-side when the
 * plan requires it, so this only has to render what it's given.
 */
function ReviewsSection({ reviews }: { reviews: SessionReviewAggregate }) {
  const max = scaleMax(reviews.scale)
  const scored = reviews.criteria.filter((criterion) => criterion.average !== null)

  return (
    <section>
      <PanelHeading title="Reviews" />
      {reviews.review_count === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No reviews yet. Scores appear here once reviewers submit their scorecards.
        </p>
      ) : (
        <div className="mt-2 space-y-4">
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                <span className="text-lg font-semibold tabular-nums">
                  {formatScore(reviews.avg_overall)}
                </span>
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {formatScore(reviews.avg_overall)}{' '}
                  <span className="font-normal text-muted-foreground">/ {max} average</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {reviews.review_count} review{reviews.review_count === 1 ? '' : 's'}
                  {reviews.any_abstained
                    ? ` · ${reviews.abstained_count} abstained`
                    : ''}
                </p>
              </div>
            </div>
            {scored.length > 0 && (
              <dl className="mt-3 flex flex-wrap gap-2">
                {scored.map((criterion) => (
                  <div
                    key={criterion.name}
                    className="rounded-md border border-border bg-card px-2.5 py-1.5"
                  >
                    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {criterion.name}
                    </dt>
                    <dd className="text-sm font-medium tabular-nums text-foreground">
                      {formatScore(criterion.average)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          <ul className="space-y-2">
            {reviews.reviews.map((verdict, index) => (
              <li
                key={`${verdict.reviewer}-${index}`}
                className="rounded-lg border border-border px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium text-foreground">{verdict.reviewer}</p>
                  {verdict.abstained ? (
                    <Badge variant="muted">Abstained</Badge>
                  ) : (
                    <Badge variant="default" className="gap-1 tabular-nums">
                      <Star className="h-3 w-3" />
                      {formatScore(verdict.overall)}
                    </Badge>
                  )}
                </div>
                {verdict.comment && (
                  <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                    {verdict.comment}
                  </p>
                )}
                {verdict.internal_comment && (
                  <p className="mt-1.5 whitespace-pre-line rounded-md border border-dashed border-border bg-muted/40 px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">Internal note:</span>{' '}
                    {verdict.internal_comment}
                  </p>
                )}
                {verdict.abstained && verdict.abstain_reason && (
                  <p className="mt-1.5 text-sm italic leading-relaxed text-muted-foreground">
                    {verdict.abstain_reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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
