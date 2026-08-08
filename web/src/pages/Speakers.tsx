import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import {
  AlertCircle,
  CheckCircle2,
  Mail,
  Plus,
  Send,
  Users,
} from 'lucide-react'

import { apiGet, unwrapList, type EventSummary } from '@/lib/api'
import {
  createSpeakerTask,
  listEventSpeakers,
  sendPortalInvite,
  type EventSpeaker,
  type TaskKind,
} from '@/lib/speakersApi'
import { CopyButton } from '@/pages/Forms'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Checkbox } from '@/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog'
import { EmptyState } from '@/ui/empty-state'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'
import { Textarea } from '@/ui/textarea'
import { toast } from '@/ui/use-toast'

export function Speakers() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [taskOpen, setTaskOpen] = useState(false)
  const [inviteLink, setInviteLink] = useState<{ name: string; url: string } | null>(null)

  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = eventsQuery.data?.[0]

  const speakersKey = ['speakers', event?.id]
  const speakersQuery = useQuery({
    queryKey: speakersKey,
    queryFn: () => listEventSpeakers(event!.id),
    enabled: Boolean(event?.id),
  })

  const speakers = useMemo(() => speakersQuery.data?.speakers ?? [], [speakersQuery.data])

  const invite = useMutation({
    mutationFn: (contactId: string) => sendPortalInvite(contactId),
    onSuccess: (data, contactId) => {
      const speaker = speakers.find((s) => s.contact_id === contactId)
      const name = speaker?.name ?? 'the speaker'
      toast({ title: 'Invite queued', description: `Portal link ready for ${name}.` })
      setInviteLink({ name, url: data.invite_url })
      queryClient.invalidateQueries({ queryKey: speakersKey })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't send invite", description: error.message }),
  })

  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && speakersQuery.isPending)
  const error = eventsQuery.error ?? speakersQuery.error

  const allSelected = speakers.length > 0 && speakers.every((s) => selected.has(s.contact_id))
  const someSelected = speakers.some((s) => selected.has(s.contact_id))
  const headerChecked: boolean | 'indeterminate' = allSelected ? true : someSelected ? 'indeterminate' : false

  const toggleAll = () =>
    setSelected((prev) => {
      if (speakers.every((s) => prev.has(s.contact_id))) return new Set()
      return new Set(speakers.map((s) => s.contact_id))
    })

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Speakers</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Invite speakers to the portal and track onboarding{event ? ` for ${event.name}` : ''}.
            </p>
          </div>
        </div>
        <Button onClick={() => setTaskOpen(true)} disabled={!event || speakers.length === 0}>
          <Plus />
          Add task
        </Button>
      </header>

      <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        {error ? (
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load speakers"
            description={error.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => speakersQuery.refetch()}>
                Try again
              </Button>
            }
          />
        ) : isLoading ? (
          <LoadingRows />
        ) : !event ? (
          <EmptyState
            icon={<Users className="h-6 w-6 text-muted-foreground" />}
            title="No events yet"
            description="Create an event and collect submissions — your speakers show up here."
          />
        ) : speakers.length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6 text-muted-foreground" />}
            title="No speakers yet"
            description="Once sessions have speakers or submitters, they'll appear here to invite and onboard."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[44px] pr-0">
                  <Checkbox checked={headerChecked} onCheckedChange={toggleAll} aria-label="Select all speakers" />
                </TableHead>
                <TableHead>Speaker</TableHead>
                <TableHead className="w-[90px] text-center">Sessions</TableHead>
                <TableHead className="w-[180px]">Onboarding</TableHead>
                <TableHead className="w-[150px]">Last portal visit</TableHead>
                <TableHead className="w-[160px] text-right">Invite</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {speakers.map((speaker) => (
                <TableRow key={speaker.contact_id} data-state={selected.has(speaker.contact_id) ? 'selected' : undefined}>
                  <TableCell className="pr-0">
                    <Checkbox
                      checked={selected.has(speaker.contact_id)}
                      onCheckedChange={() => toggleOne(speaker.contact_id)}
                      aria-label={`Select ${speaker.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">{speaker.name}</div>
                        {speaker.email && (
                          <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                            <Mail className="h-3 w-3 shrink-0" />
                            {speaker.email}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center tabular-nums text-foreground">
                    {speaker.session_count}
                  </TableCell>
                  <TableCell>
                    <OnboardingCell speaker={speaker} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {relative(speaker.last_portal_access_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant={speaker.invited ? 'outline' : 'default'}
                      size="sm"
                      disabled={invite.isPending && invite.variables === speaker.contact_id}
                      onClick={() => invite.mutate(speaker.contact_id)}
                    >
                      <Send />
                      {speaker.invited ? 'Resend' : 'Send invite'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {someSelected && (
        <p className="mt-3 text-sm text-muted-foreground">{selected.size} selected</p>
      )}

      {event && (
        <AddTaskDialog
          open={taskOpen}
          onOpenChange={setTaskOpen}
          eventId={event.id}
          speakers={speakers}
          selected={selected}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: speakersKey })
            setSelected(new Set())
          }}
        />
      )}

      <InviteLinkDialog invite={inviteLink} onOpenChange={(open) => !open && setInviteLink(null)} />
    </div>
  )
}

// ── invite-link dialog ────────────────────────────────────────────────────────

/** Shown after a portal invite is queued: surfaces the minted magic link so the
 * organizer can share it directly while email delivery is pending. */
function InviteLinkDialog({
  invite,
  onOpenChange,
}: {
  invite: { name: string; url: string } | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={Boolean(invite)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Portal link ready</DialogTitle>
          <DialogDescription>
            Email delivery is pending your mail provider — share this link with {invite?.name ?? 'the speaker'} directly.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{invite?.url}</span>
          {invite && <CopyButton value={invite.url} label="Copy portal link" />}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── add-task dialog ──────────────────────────────────────────────────────────

function AddTaskDialog({
  open,
  onOpenChange,
  eventId,
  speakers,
  selected,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  eventId: string
  speakers: EventSpeaker[]
  selected: Set<string>
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TaskKind>('todo')
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [required, setRequired] = useState(false)

  // No explicit selection means "everyone shown" — the common case.
  const targetIds = selected.size > 0 ? [...selected] : speakers.map((s) => s.contact_id)

  const create = useMutation({
    mutationFn: () =>
      createSpeakerTask(eventId, {
        name: name.trim(),
        kind,
        description: description.trim() || undefined,
        link_url: linkUrl.trim() || null,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        required,
        contact_ids: targetIds,
      }),
    onSuccess: (result) => {
      toast({
        title: 'Task assigned',
        description: `“${name.trim()}” added for ${result.assignments_created} speaker${result.assignments_created === 1 ? '' : 's'}.`,
      })
      reset()
      onOpenChange(false)
      onCreated()
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't create task", description: error.message }),
  })

  const reset = () => {
    setName('')
    setKind('todo')
    setDescription('')
    setDueAt('')
    setLinkUrl('')
    setRequired(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an onboarding task</DialogTitle>
          <DialogDescription>
            Assign to {targetIds.length} speaker{targetIds.length === 1 ? '' : 's'}
            {selected.size > 0 ? ' selected' : ' on this event'}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="task-name" required>
              Task name
            </Label>
            <Input
              id="task-name"
              value={name}
              placeholder="e.g. Upload your slides"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-kind">Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as TaskKind)}>
                <SelectTrigger id="task-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todo">Checklist item</SelectItem>
                  <SelectItem value="file_request">File upload</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input id="task-due" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-desc">Instructions</Label>
            <Textarea
              id="task-desc"
              value={description}
              placeholder="What does the speaker need to do?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {kind === 'todo' && (
            <div className="space-y-1.5">
              <Label htmlFor="task-link">Link (optional)</Label>
              <Input
                id="task-link"
                value={linkUrl}
                placeholder="https://…"
                onChange={(e) => setLinkUrl(e.target.value)}
              />
            </div>
          )}

          <label className="flex items-center gap-2.5">
            <Checkbox checked={required} onCheckedChange={(c) => setRequired(c === true)} />
            <span className="text-sm text-foreground">Mark as required</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Assigning…' : `Assign to ${targetIds.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── cells ────────────────────────────────────────────────────────────────────

function OnboardingCell({ speaker }: { speaker: EventSpeaker }) {
  if (speaker.tasks_total === 0) {
    return <span className="text-sm text-muted-foreground">No tasks</span>
  }
  const complete = speaker.tasks_outstanding === 0
  const pct = Math.round((speaker.tasks_done / speaker.tasks_total) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={complete ? 'h-full bg-success' : 'h-full bg-primary'}
          style={{ width: `${pct}%` }}
        />
      </div>
      {complete ? (
        <Badge variant="success" className="gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Done
        </Badge>
      ) : (
        <span className="text-xs tabular-nums text-muted-foreground">
          {speaker.tasks_done}/{speaker.tasks_total}
        </span>
      )}
    </div>
  )
}

function Avatar({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  if (photoUrl) {
    return <img src={photoUrl} alt={name} className="h-9 w-9 shrink-0 rounded-full object-cover" />
  }
  const label = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?'
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary">
      {label}
    </div>
  )
}

function relative(value: string | null): ReactNode {
  if (!value) return <span className="text-muted-foreground/70">Never</span>
  try {
    return formatDistanceToNow(parseISO(value), { addSuffix: true })
  } catch {
    return '—'
  }
}

function LoadingRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-4 w-[30%]" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-8 w-24 rounded-md" />
        </div>
      ))}
    </div>
  )
}
