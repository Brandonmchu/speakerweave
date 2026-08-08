import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { AlertCircle, ArrowUpDown, Check, ChevronDown, Copy, ExternalLink, FileText, Plus } from 'lucide-react'

import { apiGet, unwrapList, type EventSummary } from '@/lib/api'
import { createForm, listForms, publicFormPath, publicFormUrl, type FormSummary } from '@/lib/adminApi'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import { EmptyState } from '@/ui/empty-state'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Skeleton } from '@/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
import { toast } from '@/ui/use-toast'

type TabKey = 'all' | 'open' | 'closed'
type SortKey = 'newest' | 'submissions'

/** The forms-list wire row carries a created_at the typed summary omits — read
 * it here (never editing adminApi) so the card can show a created date and the
 * "Newest" sort has something to order by. Optional: absent → gracefully hidden. */
type FormWithMeta = FormSummary & { created_at?: string | null }

function isClosed(value?: string | null): boolean {
  if (!value) return false
  const t = Date.parse(value)
  return Number.isFinite(t) && t < Date.now()
}

function formatCreated(value?: string | null): string | null {
  if (!value) return null
  try {
    return `Created ${format(parseISO(value), 'MMM d, yyyy')}`
  } catch {
    return null
  }
}

/** Trailing segment for the card meta line: "· Closes …" / "· Closed …". */
function closeMeta(closeAt: string | null, closed: boolean): string {
  if (!closeAt) return ''
  try {
    const d = format(parseISO(closeAt), 'MMM d, yyyy')
    return closed ? ` · Closed ${d}` : ` · Closes ${d}`
  } catch {
    return ''
  }
}

/** Copy-to-clipboard that degrades quietly where the API is missing (http, jsdom). */
export function CopyButton({ value, label = 'Copy link' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
          toast({ title: 'Link copied' })
        } catch {
          toast({ variant: 'destructive', title: "Couldn't copy", description: value })
        }
      }}
    >
      {copied ? <Check className="h-4 w-4 text-success-strong" /> : <Copy className="h-4 w-4" />}
    </Button>
  )
}

export function Forms() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')

  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = eventsQuery.data?.[0]

  const formsQuery = useQuery({
    queryKey: ['forms', event?.id],
    queryFn: () => listForms(event!.id),
    enabled: Boolean(event?.id),
  })

  const create = useMutation({
    mutationFn: (formName: string) => createForm(event!.id, formName),
    onSuccess: (form) => {
      queryClient.invalidateQueries({ queryKey: ['forms', event?.id] })
      setDialogOpen(false)
      setName('')
      toast({ title: 'Form created', description: `“${form.name}” is ready to edit.` })
      navigate(`/forms/${form.id}`)
    },
    onError: (error: Error) => {
      toast({ variant: 'destructive', title: "Couldn't create form", description: error.message })
    },
  })

  // A fresh Clerk org has no event yet — there is nothing to build a form on.
  if (!eventsQuery.isPending && !eventsQuery.error && !event) {
    return <Navigate to="/onboarding" replace />
  }

  const forms: FormWithMeta[] = formsQuery.data ?? []
  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && formsQuery.isPending)
  const error = eventsQuery.error ?? formsQuery.error

  const panelClass = 'mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft'

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Forms</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Build the call for papers{event ? ` for ${event.name}` : ''} — questions, conditional logic
              and a public link to share.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)} disabled={!event}>
          <Plus className="h-4 w-4" />
          New form
        </Button>
      </header>

      {error ? (
        <div className={panelClass}>
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load forms"
            description={error.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => formsQuery.refetch()}>
                Try again
              </Button>
            }
          />
        </div>
      ) : isLoading ? (
        <div className={panelClass}>
          <LoadingRows />
        </div>
      ) : forms.length === 0 ? (
        <div className={panelClass}>
          <EmptyState
            icon={<FileText className="h-6 w-6 text-muted-foreground" />}
            title="No forms yet"
            description="Create your first call-for-papers form, add the questions you need, then share the public link."
            action={
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                New form
              </Button>
            }
          />
        </div>
      ) : (
        <FormsList forms={forms} />
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New form</DialogTitle>
            <DialogDescription>
              Name it something submitters will recognise — it shows at the top of the public page.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = name.trim()
              if (!trimmed) return
              create.mutate(trimmed)
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="form-name" required>
                Form name
              </Label>
              <Input
                id="form-name"
                autoFocus
                value={name}
                placeholder="Call for Speakers 2026"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create form'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FormsList({ forms }: { forms: FormWithMeta[] }) {
  const [tab, setTab] = useState<TabKey>('all')
  const [sort, setSort] = useState<SortKey>('newest')

  const decorated = forms.map((form) => ({ form, closed: isClosed(form.settings?.close_at ?? null) }))
  const counts = {
    all: decorated.length,
    open: decorated.filter((d) => !d.closed).length,
    closed: decorated.filter((d) => d.closed).length,
  }

  const filtered = decorated.filter((d) => (tab === 'all' ? true : tab === 'open' ? !d.closed : d.closed))
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'submissions') return (b.form.submission_count ?? 0) - (a.form.submission_count ?? 0)
    const ta = a.form.created_at ? Date.parse(a.form.created_at) : 0
    const tb = b.form.created_at ? Date.parse(b.form.created_at) : 0
    return tb - ta
  })

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList variant="underline" className="w-auto border-b-0">
            <TabsTrigger value="all">
              All
              <TabCount n={counts.all} active={tab === 'all'} />
            </TabsTrigger>
            <TabsTrigger value="open">
              Open
              <TabCount n={counts.open} active={tab === 'open'} />
            </TabsTrigger>
            <TabsTrigger value="closed">
              Closed
              <TabCount n={counts.closed} active={tab === 'closed'} />
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center pb-2">
          <SortMenu value={sort} onChange={setSort} />
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No {tab} forms.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {sorted.map(({ form, closed }) => (
            <FormCard key={form.id} form={form} closed={closed} />
          ))}
        </div>
      )}
    </div>
  )
}

function TabCount({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
        active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
      )}
    >
      {n}
    </span>
  )
}

function SortMenu({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const label = value === 'submissions' ? 'Most submissions' : 'Newest'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-full">
          <ArrowUpDown className="h-4 w-4" />
          {label}
          <ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as SortKey)}>
          <DropdownMenuRadioItem value="newest">Newest</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="submissions">Most submissions</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FormCard({ form, closed }: { form: FormWithMeta; closed: boolean }) {
  const count = form.submission_count ?? 0
  const closeAt = form.settings?.close_at ?? null
  const created = formatCreated(form.created_at)

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-soft transition-colors hover:border-primary/40">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground">
            {count}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={`/forms/${form.id}`}
                className="font-medium text-foreground transition-colors hover:text-primary"
              >
                {form.name || 'Untitled form'}
              </Link>
              <Badge variant="solid" className="rounded-full">
                {closed ? 'Closed' : 'Open'}
              </Badge>
              {form.kind && (
                <Badge variant="outline" className="rounded-full capitalize">
                  {form.kind}
                </Badge>
              )}
            </div>

            <div className="mt-1.5 flex items-center gap-1">
              <a
                href={publicFormPath(form.slug)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 truncate font-mono text-xs text-primary hover:underline"
              >
                {publicFormPath(form.slug)}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              <CopyButton value={publicFormUrl(form.slug)} />
            </div>

            <div className="mt-1 text-xs text-muted-foreground">
              {count} {count === 1 ? 'submission' : 'submissions'}
              {closeMeta(closeAt, closed)}
            </div>
          </div>
        </div>

        {created && (
          <div className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{created}</div>
        )}
      </div>
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="h-4 w-[30%]" />
          <Skeleton className="h-4 w-[34%]" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  )
}
