import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { AlertCircle, Check, Copy, ExternalLink, FileText, Plus } from 'lucide-react'

import { apiGet, unwrapList, type EventSummary } from '@/lib/api'
import { createForm, listForms, publicFormPath, publicFormUrl, type FormSummary } from '@/lib/adminApi'
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
import { EmptyState } from '@/ui/empty-state'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'
import { toast } from '@/ui/use-toast'

function formatCloseDate(value?: string | null): string {
  if (!value) return 'No close date'
  try {
    return format(parseISO(value), 'MMM d, yyyy')
  } catch {
    return 'No close date'
  }
}

function isClosed(value?: string | null): boolean {
  if (!value) return false
  const t = Date.parse(value)
  return Number.isFinite(t) && t < Date.now()
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

  const forms = formsQuery.data ?? []
  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && formsQuery.isPending)
  const error = eventsQuery.error ?? formsQuery.error

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

      <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        {error ? (
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
        ) : isLoading ? (
          <LoadingRows />
        ) : forms.length === 0 ? (
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
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[34%]">Form</TableHead>
                <TableHead>Public link</TableHead>
                <TableHead className="w-[130px]">Submissions</TableHead>
                <TableHead className="w-[170px]">Closes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forms.map((form) => (
                <FormRow key={form.id} form={form} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

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

function FormRow({ form }: { form: FormSummary }) {
  const closeAt = form.settings?.close_at ?? null
  const closed = isClosed(closeAt)

  return (
    <TableRow>
      <TableCell>
        <Link
          to={`/forms/${form.id}`}
          className="font-medium text-foreground transition-colors hover:text-primary"
        >
          {form.name || 'Untitled form'}
        </Link>
        <div className="mt-0.5 flex items-center gap-2">
          {form.kind && <span className="text-xs capitalize text-muted-foreground">{form.kind}</span>}
          {closed && <Badge variant="muted">Closed</Badge>}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
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
      </TableCell>
      <TableCell>
        <span className="text-sm tabular-nums text-foreground">{form.submission_count ?? 0}</span>
      </TableCell>
      <TableCell className="text-sm tabular-nums text-muted-foreground">
        {formatCloseDate(closeAt)}
      </TableCell>
    </TableRow>
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
