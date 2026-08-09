import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import {
  AlertCircle,
  Bell,
  Download,
  FileArchive,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Send,
  User,
} from 'lucide-react'

import { apiGet, unwrapList, type EventSummary } from '@/lib/api'
import {
  addContentComment,
  downloadContentBundle,
  getContentItem,
  listContent,
  remindOutstanding,
  type ContentItem,
  type ContentStatus,
  type ContentType,
} from '@/lib/contentApi'
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

const STATUS_META: Record<string, { label: string; variant: 'success' | 'warning' | 'muted' }> = {
  received: { label: 'Received', variant: 'success' },
  needs_changes: { label: 'Needs changes', variant: 'warning' },
  missing: { label: 'Missing', variant: 'muted' },
}

const TYPE_ICON: Record<string, typeof FileText> = {
  slides: FileText,
  headshot: ImageIcon,
  bio: User,
  other: FileText,
}

export function ContentLibrary() {
  const queryClient = useQueryClient()
  const [type, setType] = useState<ContentType | 'all'>('all')
  const [status, setStatus] = useState<ContentStatus | 'all'>('all')
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
  const items = useMemo(() => library?.items ?? [], [library])
  const outstanding = library?.outstanding ?? []

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

  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && libraryQuery.isPending)
  const error = eventsQuery.error ?? libraryQuery.error

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <FileArchive className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Content library</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every slide deck, headshot and bio your speakers have sent
              {event ? ` for ${event.name}` : ''}.
            </p>
          </div>
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
            onClick={() => exporting.mutate()}
            disabled={!event || exporting.isPending || items.length === 0}
          >
            {exporting.isPending ? <Loader2 className="animate-spin" /> : <Download />}
            Export all content
          </Button>
        </div>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="w-44">
          <NativeSelect
            aria-label="Filter by type"
            value={type}
            onValueChange={(v) => setType(v as ContentType | 'all')}
            options={TYPE_OPTIONS}
          />
        </div>
        <div className="w-44">
          <NativeSelect
            aria-label="Filter by status"
            value={status}
            onValueChange={(v) => setStatus(v as ContentStatus | 'all')}
            options={STATUS_OPTIONS}
          />
        </div>
        {library && (
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span>{library.counts.received ?? 0} received</span>
            <span>{library.counts.needs_changes ?? 0} needs changes</span>
            <span>{library.counts.missing ?? 0} missing</span>
          </div>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
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
                <TableHead>Speaker</TableHead>
                <TableHead className="w-[120px]">Type</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="w-[140px]">Status</TableHead>
                <TableHead className="w-[90px] text-center">Version</TableHead>
                <TableHead className="w-[110px] text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const Icon = TYPE_ICON[item.type] ?? FileText
                return (
                  <TableRow key={item.item_id}>
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
                      <span className="inline-flex items-center gap-1.5 text-sm capitalize text-foreground">
                        <Icon className="h-4 w-4 text-muted-foreground" />
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
                    <TableCell>
                      <StatusBadge status={item.status} />
                    </TableCell>
                    <TableCell className="text-center tabular-nums text-sm text-muted-foreground">
                      {item.current_version > 0 ? `v${item.current_version}` : '—'}
                    </TableCell>
                    <TableCell className="text-right">
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

      {outstanding.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {outstanding.length} speaker{outstanding.length === 1 ? '' : 's'} still outstanding on
          required content.
        </p>
      )}

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

  const detail = detailQuery.data

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item?.title}</DialogTitle>
          <DialogDescription>
            {item?.speaker.name}
            {item ? ` · ${item.type}` : ''}
          </DialogDescription>
        </DialogHeader>

        {!detail ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* versions */}
            <section>
              <h3 className="mb-2 text-sm font-semibold text-foreground">
                Versions ({detail.versions.length})
              </h3>
              {detail.versions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.versions.map((version) => (
                    <li
                      key={version.file_id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm text-foreground">{version.filename}</span>
                        <Badge variant={version.is_current ? 'success' : 'muted'}>
                          v{version.version}
                          {version.is_current ? ' · current' : ''}
                        </Badge>
                      </div>
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
                <ul className="space-y-2">
                  {detail.comments.map((c) => (
                    <li key={c.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {c.author_label ?? (c.author_role === 'organizer' ? 'Organizer' : 'Speaker')}
                        </span>
                        <Badge variant={c.author_role === 'organizer' ? 'default' : 'outline'}>
                          {c.author_role}
                        </Badge>
                        {c.created_at && (
                          <span className="text-xs text-muted-foreground">{relative(c.created_at)}</span>
                        )}
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

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, variant: 'muted' as const }
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

function relative(value: string): ReactNode {
  try {
    return formatDistanceToNow(parseISO(value), { addSuffix: true })
  } catch {
    return ''
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
