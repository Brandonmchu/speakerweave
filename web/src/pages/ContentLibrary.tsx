import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format as formatDate, formatDistanceToNow, parseISO } from 'date-fns'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bell,
  CalendarClock,
  CheckCircle2,
  Download,
  FileArchive,
  FileText,
  History,
  Loader2,
  MessageSquare,
  RotateCcw,
  Send,
} from 'lucide-react'

import { apiGet, unwrapList, type EventSummary } from '@/lib/api'
import { dueLabel, dueSortKey, formatDueDate, isOverdue } from '@/lib/dueDate'
import {
  addContentComment,
  downloadContentBundle,
  getContentItem,
  listContent,
  remindOutstanding,
  reviewContentItem,
  restoreContentVersion,
  type ContentItem,
  type ContentStatus,
  type ContentType,
} from '@/lib/contentApi'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { EmptyState } from '@/ui/empty-state'
import { NativeSelect } from '@/ui/native-select'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'
import { Textarea } from '@/ui/textarea'
import { toast } from '@/ui/use-toast'

const TYPE_OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'slides', label: 'Slides' },
  { value: 'headshot', label: 'Headshot' },
  { value: 'bio', label: 'Bio' },
  { value: 'other', label: 'Other' },
]

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'received', label: 'Received' },
  { value: 'needs_changes', label: 'Needs changes' },
  { value: 'missing', label: 'Missing' },
]

const STATUS_META: Record<string, { label: string; dot: string }> = {
  received: { label: 'Received', dot: 'before:bg-success' },
  needs_changes: { label: 'Needs changes', dot: 'before:bg-warning' },
  missing: { label: 'Missing', dot: 'before:bg-destructive' },
}

/** Off (server order) -> soonest first -> latest first -> off. */
type DueSort = 'none' | 'asc' | 'desc'

const NEXT_DUE_SORT: Record<DueSort, DueSort> = { none: 'asc', asc: 'desc', desc: 'none' }
const DUE_SORT_LABEL: Record<DueSort, string> = {
  none: 'Sort by due date',
  asc: 'Sorted by due date, soonest first',
  desc: 'Sorted by due date, latest first',
}

export function ContentLibrary() {
  const queryClient = useQueryClient()
  const [type, setType] = useState<ContentType | 'all'>('all')
  const [status, setStatus] = useState<ContentStatus | 'all'>('all')
  const [dueSort, setDueSort] = useState<DueSort>('none')
  const [openItem, setOpenItem] = useState<ContentItem | null>(null)

  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = eventsQuery.data?.[0]

  const libraryKey = ['content', event?.id, type, status]
  const libraryQuery = useQuery({
    queryKey: libraryKey,
    queryFn: () => listContent(event!.id, { type, status }),
    enabled: Boolean(event?.id),
  })

  const library = libraryQuery.data
  const rawItems = useMemo(() => library?.items ?? [], [library])
  // Sorting is a *view* over the server's order, so turning it off restores that
  // order exactly rather than leaving the table in whatever the last sort was.
  const items = useMemo(() => {
    if (dueSort === 'none') return rawItems
    const direction = dueSort === 'asc' ? 1 : -1
    return [...rawItems].sort((a, b) => {
      const keyA = dueSortKey(a.due_at)
      const keyB = dueSortKey(b.due_at)
      if (keyA !== keyB) return keyA < keyB ? -direction : direction
      return a.speaker.name.localeCompare(b.speaker.name) || a.title.localeCompare(b.title)
    })
  }, [rawItems, dueSort])
  const outstanding = library?.outstanding ?? []

  // ── multi-select export ───────────────────────────────────────────────────
  // Only an item with a file behind it can be bundled; a "missing" row has
  // nothing to put in the ZIP, so it isn't selectable.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const downloadableIds = useMemo(
    () => items.filter((i) => i.current_file).map((i) => i.item_id),
    [items]
  )
  // A filter change can hide a ticked row — keep the selection honest by
  // pruning it to what is actually on screen.
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = prev.filter((id) => downloadableIds.includes(id))
      return next.length === prev.length ? prev : next
    })
  }, [downloadableIds])

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const allSelected = downloadableIds.length > 0 && selectedIds.length === downloadableIds.length

  const toggleItem = (itemId: string, checked: boolean) =>
    setSelectedIds((prev) =>
      checked ? (prev.includes(itemId) ? prev : [...prev, itemId]) : prev.filter((id) => id !== itemId)
    )
  const toggleAll = (checked: boolean) => setSelectedIds(checked ? downloadableIds : [])

  const remind = useMutation({
    mutationFn: () => remindOutstanding(event!.id, { required_only: true }),
    onSuccess: (result) => {
      toast({
        title: 'Reminders queued',
        description:
          result.reminded > 0
            ? `Emailed ${result.reminded} speaker${result.reminded === 1 ? '' : 's'} still missing required content.`
            : 'Everyone is caught up — no reminders needed.',
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't send reminders", description: error.message }),
  })

  const exporting = useMutation({
    mutationFn: () => downloadContentBundle(event!.id, `content-${event!.slug ?? event!.id}.zip`),
    onSuccess: () => toast({ title: 'Export ready', description: 'Your content bundle is downloading.' }),
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't export", description: error.message }),
  })

  // The same export endpoint, narrowed to the ticked rows — one ZIP of just
  // those items' current versions.
  const exportingSelected = useMutation({
    mutationFn: () =>
      downloadContentBundle(
        event!.id,
        `content-${event!.slug ?? event!.id}-selected.zip`,
        selectedIds
      ),
    onSuccess: () =>
      toast({
        title: 'Download started',
        description: `Bundling ${selectedIds.length} selected item${selectedIds.length === 1 ? '' : 's'}.`,
      }),
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't export", description: error.message }),
  })

  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && libraryQuery.isPending)
  const error = eventsQuery.error ?? libraryQuery.error

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Content</h1>
          <p className="page-subtitle">
            Every slide deck, headshot and bio your speakers have sent
            {event ? ` for ${event.name}` : ''}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => remind.mutate()}
            disabled={!event || remind.isPending || outstanding.length === 0}
          >
            {remind.isPending ? <Loader2 className="animate-spin" /> : <Bell />}
            Remind outstanding{outstanding.length ? ` (${outstanding.length})` : ''}
          </Button>
          <Button
            variant="secondary"
            data-testid="download-selected"
            onClick={() => exportingSelected.mutate()}
            disabled={!event || exportingSelected.isPending || selectedIds.length === 0}
          >
            {exportingSelected.isPending ? <Loader2 className="animate-spin" /> : <Download />}
            Download selected{selectedIds.length ? ` (${selectedIds.length})` : ''}
          </Button>
          <Button
            data-testid="export-all"
            onClick={() => exporting.mutate()}
            disabled={!event || exporting.isPending || items.length === 0}
          >
            {exporting.isPending ? <Loader2 className="animate-spin" /> : <Download />}
            Export all content
          </Button>
        </div>
      </header>

      {library && (
        <div className="mt-6 grid border-y border-border bg-card sm:grid-cols-4">
          <ContentStat label="Total" value={rawItems.length} />
          <ContentStat label="Received" value={library.counts.received ?? 0} />
          <ContentStat label="Needs changes" value={library.counts.needs_changes ?? 0} />
          <ContentStat label="Missing" value={library.counts.missing ?? 0} />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="w-44">
          <NativeSelect
            aria-label="Filter by type"
            className="bg-transparent px-0 pr-5 hover:bg-transparent"
            value={type}
            onValueChange={(v) => setType(v as ContentType | 'all')}
            options={TYPE_OPTIONS}
          />
        </div>
        <div className="w-44">
          <NativeSelect
            aria-label="Filter by status"
            className="bg-transparent px-0 pr-5 hover:bg-transparent"
            value={status}
            onValueChange={(v) => setStatus(v as ContentStatus | 'all')}
            options={STATUS_OPTIONS}
          />
        </div>
        {library && (
          <div className="ml-auto font-mono text-[10.5px] tabular-nums text-placeholder">
            {items.length} of {rawItems.length}
          </div>
        )}
      </div>

      <div className="mt-4 bg-card">
        {error ? (
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load content"
            description={error.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => libraryQuery.refetch()}>
                Try again
              </Button>
            }
          />
        ) : isLoading ? (
          <LoadingRows />
        ) : !event ? (
          <EmptyState
            icon={<FileArchive className="h-6 w-6 text-muted-foreground" />}
            title="No events yet"
            description="Create an event and invite speakers — their content shows up here."
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<FileArchive className="h-6 w-6 text-muted-foreground" />}
            title="Nothing to show"
            description="No content items match these filters. Assign file-request tasks to your speakers to start collecting."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[44px]">
                  <SelectBox
                    checked={allSelected}
                    disabled={downloadableIds.length === 0}
                    label="Select all downloadable content"
                    testId="select-all-content"
                    onChange={toggleAll}
                  />
                </TableHead>
                <TableHead>Speaker</TableHead>
                <TableHead className="w-[120px]">Type</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Session</TableHead>
                <TableHead className="w-[150px]">
                  {/* Sortable: the organizer's real question here is "what is
                      due next", which the server's speaker order can't answer. */}
                  <button
                    type="button"
                    data-testid="sort-due"
                    data-sort={dueSort}
                    aria-label={DUE_SORT_LABEL[dueSort]}
                    title={DUE_SORT_LABEL[dueSort]}
                    onClick={() => setDueSort(NEXT_DUE_SORT[dueSort])}
                    className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-inherit transition-colors hover:text-foreground"
                  >
                    Due
                    {dueSort === 'asc' ? (
                      <ArrowUp className="h-3.5 w-3.5" />
                    ) : dueSort === 'desc' ? (
                      <ArrowDown className="h-3.5 w-3.5" />
                    ) : (
                      <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
                    )}
                  </button>
                </TableHead>
                <TableHead className="w-[140px]">Status</TableHead>
                <TableHead className="w-[150px]">Uploaded</TableHead>
                <TableHead className="w-[90px]">Version</TableHead>
                <TableHead className="w-[110px]">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const selectable = Boolean(item.current_file)
                return (
                  <TableRow key={item.item_id} data-state={selectedSet.has(item.item_id) ? 'selected' : undefined}>
                    <TableCell>
                      <SelectBox
                        checked={selectedSet.has(item.item_id)}
                        disabled={!selectable}
                        label={
                          selectable
                            ? `Select ${item.title} from ${item.speaker.name}`
                            : `${item.title} has nothing to download yet`
                        }
                        testId={`select-item-${item.item_id}`}
                        onChange={(checked) => toggleItem(item.item_id, checked)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">{item.speaker.name}</div>
                        {item.speaker.email && (
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {item.speaker.email}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="capitalize text-foreground">
                        {item.type}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-foreground">{item.title}</span>
                        {item.required && (
                          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive-strong">
                            Required
                          </span>
                        )}
                        {item.comment_count > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                            <MessageSquare className="h-3 w-3" />
                            {item.comment_count}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell data-testid={`session-cell-${item.item_id}`}>
                      {item.session_title ?? item.session?.title ? (
                        item.session_id ?? item.session?.id ? (
                          <Link
                            to={`/agenda?session=${encodeURIComponent(item.session_id ?? item.session!.id)}`}
                            className="line-clamp-2 text-sm font-medium text-primary hover:underline"
                          >
                            {item.session_title ?? item.session?.title}
                          </Link>
                        ) : (
                          <span className="line-clamp-2 text-sm text-foreground">
                            {item.session_title ?? item.session?.title}
                          </span>
                        )
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell data-testid={`due-cell-${item.item_id}`}>
                      <DueCell dueAt={item.due_at} done={item.status === 'received'} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={item.status} approved={item.approved} />
                    </TableCell>
                    <TableCell data-testid={`uploaded-cell-${item.item_id}`}>
                      <UploadedCell uploadedAt={item.uploaded_at} />
                    </TableCell>
                    <TableCell
                      className="font-mono text-[10.5px] tabular-nums text-muted-foreground"
                      data-testid="content-version-cell"
                    >
                      {item.current_version > 0 ? `v${item.current_version}` : '—'}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="secondary" onClick={() => setOpenItem(item)}>
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
        {outstanding.length > 0 && (
          <p>
            {outstanding.length} speaker{outstanding.length === 1 ? '' : 's'} still outstanding on
            required content.
          </p>
        )}
        {selectedIds.length > 0 && (
          <p className="ml-auto flex items-center gap-2" data-testid="selection-summary">
            <span className="font-medium text-foreground">
              {selectedIds.length} item{selectedIds.length === 1 ? '' : 's'} selected
            </span>
            <button
              type="button"
              data-testid="clear-selection"
              onClick={() => setSelectedIds([])}
              className="font-medium text-primary hover:underline"
            >
              Clear selection
            </button>
          </p>
        )}
      </div>

      <ItemDialog
        item={openItem}
        onOpenChange={(open) => !open && setOpenItem(null)}
        onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ['content', event?.id] })
        }}
      />
    </div>
  )
}

// ── item detail dialog ────────────────────────────────────────────────────────

function ItemDialog({
  item,
  onOpenChange,
  onChanged,
}: {
  item: ContentItem | null
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')

  const detailQuery = useQuery({
    queryKey: ['content-item', item?.item_id],
    queryFn: () => getContentItem(item!.item_id),
    enabled: Boolean(item),
  })

  // Restore is a pointer move on the server — nothing is deleted, so this is
  // safe to offer inline. Refetch the item (history + thread now carry the
  // change) and the library list (its Version column moves with it).
  const restore = useMutation({
    mutationFn: (version: number) => restoreContentVersion(item!.item_id, version),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['content-item', item?.item_id] })
      onChanged()
      toast({
        title: `Restored v${result.restored.version}`,
        description: 'That version is current again. Every other version is still here.',
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't restore", description: error.message }),
  })

  const comment = useMutation({
    mutationFn: (body: string) => addContentComment(item!.item_id, body),
    onSuccess: () => {
      setDraft('')
      queryClient.invalidateQueries({ queryKey: ['content-item', item?.item_id] })
      onChanged()
      toast({ title: 'Feedback sent', description: 'The speaker will see it in their portal.' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't send feedback", description: error.message }),
  })

  const review = useMutation({
    mutationFn: (decision: 'approved' | 'denied') =>
      reviewContentItem(item!.item_id, decision),
    onSuccess: (_result, decision) => {
      queryClient.invalidateQueries({ queryKey: ['content-item', item?.item_id] })
      onChanged()
      toast({
        title: decision === 'approved' ? 'Content approved' : 'Changes requested',
        description:
          decision === 'approved'
            ? 'The speaker can see that this item is approved.'
            : 'The speaker can see that this item needs changes.',
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't update review", description: error.message }),
  })

  const detail = detailQuery.data
  // The detail payload carries its own due date; the row that opened the dialog
  // is the fallback so the deadline is on screen before the fetch lands.
  const dueAt = detail?.item.due_at ?? item?.due_at ?? null
  const received = (detail?.item.status ?? item?.status) === 'received'
  const late = Boolean(dueAt) && !received && isOverdue(dueAt)

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item?.title}</DialogTitle>
          <DialogDescription>
            {item?.speaker.name}
            {item ? ` · ${item.type}` : ''}
            {item?.session ? ` · ${item.session.title}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div
          data-testid="content-item-due"
          data-overdue={late ? 'true' : undefined}
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm',
            late
              ? 'border-destructive/40 bg-destructive/5 text-destructive-strong'
              : 'border-border bg-muted/30 text-foreground'
          )}
        >
          <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{dueAt ? dueLabel(dueAt) : 'No due date set'}</span>
          {late && (
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium">
              overdue
            </span>
          )}
        </div>

        {!detail ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : (
          <div className="space-y-5">
            <section
              data-testid="content-review-control"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/25 px-3 py-3"
            >
              <div>
                <p className="text-sm font-medium text-foreground">Review status</p>
                <div className="mt-1">
                  <StatusBadge status={detail.item.status} approved={detail.item.approved} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={review.isPending || detail.versions.length === 0 || detail.item.assignment_status === 'denied'}
                  onClick={() => review.mutate('denied')}
                >
                  Needs changes
                </Button>
                <Button
                  size="sm"
                  disabled={review.isPending || detail.versions.length === 0 || detail.item.approved}
                  onClick={() => review.mutate('approved')}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Approve
                </Button>
              </div>
            </section>

            {/* change history — every upload, newest first, with an undo */}
            <section data-testid="content-version-list">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <History className="h-4 w-4 text-muted-foreground" />
                History ({detail.versions.length} version
                {detail.versions.length === 1 ? '' : 's'})
                {detail.item.current_version > 0 && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    Current: v{detail.item.current_version}
                  </span>
                )}
              </h3>
              <p className="mb-2 text-xs text-muted-foreground">
                Every upload is kept. Restoring an earlier version makes it current again — nothing
                is deleted.
              </p>
              {detail.versions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.versions.map((version) => (
                    <li
                      key={version.file_id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                      data-testid="content-version-row"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm text-foreground">{version.filename}</span>
                        <Badge variant={version.is_current ? 'success' : 'muted'}>
                          v{version.version}
                          {version.is_current ? ' · current' : ''}
                        </Badge>
                        {version.source === 'profile' && (
                          <Badge variant="outline" data-testid="version-source-profile">
                            From portal profile
                          </Badge>
                        )}
                        <span
                          className="shrink-0 text-xs text-muted-foreground"
                          data-testid="version-timestamp"
                          title={absolute(version.created_at)}
                        >
                          {version.created_at
                            ? `Uploaded ${absolute(version.created_at)} (${relative(version.created_at)})`
                            : 'Upload time not recorded'}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        {!version.is_current && version.source !== 'profile' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            data-testid={`restore-version-${version.version}`}
                            onClick={() => restore.mutate(version.version)}
                            disabled={restore.isPending}
                          >
                            {restore.isPending ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                            Restore
                          </Button>
                        )}
                        {version.url && (
                          <a
                            href={version.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary-strong"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Download
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* comments */}
            <section>
              <h3 className="mb-2 text-sm font-semibold text-foreground">Feedback &amp; comments</h3>
              {detail.comments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No comments yet.</p>
              ) : (
                <ul className="space-y-2" data-testid="content-comment-thread">
                  {detail.comments.map((c) => (
                    <li key={c.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {c.author_label ?? (c.author_role === 'organizer' ? 'Organizer' : 'Speaker')}
                        </span>
                        <Badge variant={c.author_role === 'organizer' ? 'default' : 'outline'}>
                          {c.author_role}
                        </Badge>
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid="comment-timestamp"
                          title={absolute(c.created_at)}
                        >
                          {c.created_at
                            ? `${absolute(c.created_at)} · ${relative(c.created_at)}`
                            : 'Time not recorded'}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{c.body}</p>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 space-y-2">
                <Textarea
                  value={draft}
                  autoResize
                  data-testid="content-add-comment"
                  placeholder="Leave feedback for the speaker (e.g. “Headshot is too low-res — please re-upload”)."
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => comment.mutate(draft.trim())}
                    disabled={!draft.trim() || comment.isPending}
                  >
                    {comment.isPending ? <Loader2 className="animate-spin" /> : <Send />}
                    Send feedback
                  </Button>
                </div>
              </div>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── bits ──────────────────────────────────────────────────────────────────────

function ContentStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-b border-border px-5 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <p className="font-mono text-[21px] font-medium tabular-nums leading-6 text-foreground">{value}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{label}</p>
    </div>
  )
}

/**
 * A real `<input type="checkbox">`, not the Radix widget.
 *
 * The row selection is how an organizer (or a browser agent driving this page)
 * picks what goes into the ZIP, so it has to be an element a form-filling tool
 * can actually tick — same reasoning as ui/native-select.
 */
function SelectBox({
  checked,
  disabled,
  label,
  testId,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  testId: string
  onChange: (checked: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testId}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 cursor-pointer rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-40"
    />
  )
}

/**
 * A deliverable's deadline, as a calendar date.
 *
 * Rendered through `formatDueDate`, which reads the stored UTC calendar day
 * rather than converting an instant into the viewer's zone — "due 2027-05-01"
 * must not read "Apr 30" for an organizer in California.
 *
 * "Overdue" is a claim about work that is still OUTSTANDING: once the file is in,
 * the deadline is history, not a problem, so a received item never turns red.
 */
function DueCell({ dueAt, done }: { dueAt: string | null; done: boolean }) {
  if (!dueAt) return <span className="text-sm text-muted-foreground">—</span>
  const late = !done && isOverdue(dueAt)
  return (
    <span
      data-overdue={late ? 'true' : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums',
        late ? 'font-medium text-destructive' : 'text-foreground'
      )}
    >
      {late && <CalendarClock className="h-3.5 w-3.5 shrink-0" />}
      {formatDueDate(dueAt)}
      {late && (
        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive-strong">
          overdue
        </span>
      )}
    </span>
  )
}

function UploadedCell({ uploadedAt }: { uploadedAt: string | null }) {
  if (!uploadedAt) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <span className="font-mono text-[10.5px] text-muted-foreground" title={absolute(uploadedAt)}>
      {absolute(uploadedAt)}
    </span>
  )
}

function StatusBadge({ status, approved = false }: { status: string; approved?: boolean }) {
  if (approved) return <Badge variant="dot" className="before:bg-success">Approved</Badge>
  const meta = STATUS_META[status] ?? { label: status, dot: 'before:bg-status-neutral' }
  return <Badge variant="dot" className={meta.dot}>{meta.label}</Badge>
}

function relative(value: string): ReactNode {
  try {
    return formatDistanceToNow(parseISO(value), { addSuffix: true })
  } catch {
    // An unparseable stamp still tells the reader more than a blank does.
    return value
  }
}

/** The exact timestamp — a version row and a comment both say WHEN, not just what. */
function absolute(value: string | null | undefined): string {
  if (!value) return ''
  try {
    return formatDate(parseISO(value), "d MMM yyyy 'at' HH:mm")
  } catch {
    return value
  }
}

function LoadingRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="h-4 w-[24%]" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-[28%]" />
          <Skeleton className="ml-auto h-8 w-20 rounded-md" />
        </div>
      ))}
    </div>
  )
}
