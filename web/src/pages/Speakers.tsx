import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import {
  AlertCircle,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Mail,
  MapPin,
  MessageSquare,
  Pencil,
  Plane,
  Plus,
  Search,
  Send,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react'

import {
  apiGet,
  getSpeakerProfile,
  importSpeakers,
  listSpeakerStatuses,
  unwrapList,
  updateSpeaker,
  type EventSummary,
  type SpeakerImportResult,
  type SpeakerProfile,
  type SpeakerStatus,
  type SubmissionStatus,
} from '@/lib/api'
import {
  createSpeakerTask,
  listEventSpeakers,
  sendPortalInvite,
  type EventSpeaker,
  type TaskKind,
} from '@/lib/speakersApi'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/pages/Forms'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Checkbox } from '@/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog'
import { EmptyState } from '@/ui/empty-state'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'
import { Textarea } from '@/ui/textarea'
import { toast } from '@/ui/use-toast'

type OnboardingFilter = 'all' | 'onboarded' | 'outstanding'
type InviteFilter = 'all' | 'invited' | 'uninvited'
/** 'unset' is a real answer to "who haven't we asked yet?" — hence its own option. */
type WorkflowFilter = 'all' | SpeakerStatus | 'unset'

/**
 * A roster row plus the organizer's manual workflow status, which arrives from
 * its own flat per-event call rather than a request per row.
 */
type RosterSpeaker = EventSpeaker & { speaker_status: SpeakerStatus | null }

const WORKFLOW_META: Record<
  SpeakerStatus,
  { label: string; variant: 'success' | 'warning' | 'destructive' }
> = {
  invited: { label: 'Invited', variant: 'warning' },
  confirmed: { label: 'Confirmed', variant: 'success' },
  declined: { label: 'Declined', variant: 'destructive' },
}

const WORKFLOW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '— Not set' },
  { value: 'invited', label: 'Invited' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'declined', label: 'Declined' },
]

/**
 * The organizer's own answer to "have they said yes?" — distinct from the
 * derived portal-invite badge next to it, which only means a link was minted.
 */
function WorkflowStatusBadge({ status }: { status: SpeakerStatus | null }) {
  if (!status) {
    return (
      <span className="text-sm text-muted-foreground" title="No workflow status set yet">
        —
      </span>
    )
  }
  const meta = WORKFLOW_META[status]
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

export function Speakers() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [taskOpen, setTaskOpen] = useState(false)
  const [inviteLink, setInviteLink] = useState<{ name: string; url: string } | null>(null)

  const [search, setSearch] = useState('')
  const [onboardingFilter, setOnboardingFilter] = useState<OnboardingFilter>('all')
  const [inviteFilter, setInviteFilter] = useState<InviteFilter>('all')
  const [workflowFilter, setWorkflowFilter] = useState<WorkflowFilter>('all')
  const [openContactId, setOpenContactId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

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

  // The workflow statuses ride alongside the roster in one flat call. A failure
  // (or a backend without migration 010) just leaves every row "not set" — the
  // roster itself stays fully usable.
  const statusesKey = ['speakerStatuses', event?.id]
  const statusesQuery = useQuery({
    queryKey: statusesKey,
    queryFn: () => listSpeakerStatuses(event!.id),
    enabled: Boolean(event?.id),
  })

  const speakers = useMemo<RosterSpeaker[]>(() => {
    const byContact = statusesQuery.data ?? {}
    return (speakersQuery.data?.speakers ?? []).map((s) => ({
      ...s,
      speaker_status: byContact[s.contact_id] ?? null,
    }))
  }, [speakersQuery.data, statusesQuery.data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return speakers.filter((s) => {
      if (q) {
        const hay = `${s.name} ${s.email ?? ''} ${s.company_name ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      // "Onboarded" means they finished something, not that nothing was ever
      // asked of them: a speaker with no tasks assigned has zero outstanding
      // too, and counting them as onboarded overstated the roster's progress.
      if (onboardingFilter === 'onboarded' && (s.tasks_total === 0 || s.tasks_outstanding > 0)) {
        return false
      }
      if (onboardingFilter === 'outstanding' && s.tasks_outstanding === 0) return false
      if (inviteFilter === 'invited' && !s.invited) return false
      if (inviteFilter === 'uninvited' && s.invited) return false
      if (workflowFilter === 'unset' && s.speaker_status !== null) return false
      if (workflowFilter !== 'all' && workflowFilter !== 'unset' && s.speaker_status !== workflowFilter) {
        return false
      }
      return true
    })
  }, [speakers, search, onboardingFilter, inviteFilter, workflowFilter])

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

  const refreshRoster = () => {
    queryClient.invalidateQueries({ queryKey: speakersKey })
    queryClient.invalidateQueries({ queryKey: statusesKey })
  }

  const clearFilters = () => {
    setOnboardingFilter('all')
    setInviteFilter('all')
    setWorkflowFilter('all')
  }

  /**
   * Refetch AND make the new people impossible to miss. Someone just added has
   * no tasks yet, so they sort to the end of a long roster and a stale filter
   * can hide them outright — which is how "add speaker" came to look like it
   * had silently failed. Show the roster the way that proves it worked.
   */
  const revealRoster = (email?: string) => {
    refreshRoster()
    clearFilters()
    setSearch(email ?? '')
  }

  const isLoading = eventsQuery.isPending || (Boolean(event?.id) && speakersQuery.isPending)
  const error = eventsQuery.error ?? speakersQuery.error

  const allSelected = filtered.length > 0 && filtered.every((s) => selected.has(s.contact_id))
  const someSelected = filtered.some((s) => selected.has(s.contact_id))
  const headerChecked: boolean | 'indeterminate' = allSelected ? true : someSelected ? 'indeterminate' : false

  const toggleAll = () =>
    setSelected((prev) => {
      if (filtered.every((s) => prev.has(s.contact_id))) {
        const next = new Set(prev)
        filtered.forEach((s) => next.delete(s.contact_id))
        return next
      }
      const next = new Set(prev)
      filtered.forEach((s) => next.add(s.contact_id))
      return next
    })

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onExport = () => {
    if (!event) return
    const csv = speakersToCsv(filtered)
    downloadCsv(`${event.slug || 'speakers'}-roster.csv`, csv)
    toast({ title: 'Roster exported', description: `${filtered.length} speaker${filtered.length === 1 ? '' : 's'} downloaded.` })
  }

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
              Manage your speaker roster, onboarding, and communications{event ? ` for ${event.name}` : ''}.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setImportOpen(true)} disabled={!event}>
            <Upload />
            Import CSV
          </Button>
          <Button
            variant="secondary"
            onClick={onExport}
            disabled={!event || speakers.length === 0}
            data-testid="export-speakers"
          >
            <Download />
            Export CSV
          </Button>
          <Button onClick={() => setAddOpen(true)} disabled={!event}>
            <UserPlus />
            Add speaker
          </Button>
        </div>
      </header>

      {event && speakers.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, or company"
              aria-label="Search speakers"
              data-testid="speaker-search"
              className="pl-9"
            />
          </div>
          <NativeSelect
            aria-label="Filter by onboarding status"
            data-testid="filter-onboarding"
            value={onboardingFilter}
            onValueChange={(v) => setOnboardingFilter(v as OnboardingFilter)}
            className="w-auto min-w-[160px]"
            options={[
              { value: 'all', label: 'All onboarding' },
              { value: 'onboarded', label: 'Onboarded' },
              { value: 'outstanding', label: 'Outstanding tasks' },
            ]}
          />
          <NativeSelect
            aria-label="Filter by invite status"
            data-testid="filter-invite"
            value={inviteFilter}
            onValueChange={(v) => setInviteFilter(v as InviteFilter)}
            className="w-auto min-w-[150px]"
            options={[
              { value: 'all', label: 'All speakers' },
              { value: 'invited', label: 'Portal invited' },
              { value: 'uninvited', label: 'Portal not invited' },
            ]}
          />
          <NativeSelect
            aria-label="Filter by speaker status"
            data-testid="filter-speaker-status"
            value={workflowFilter}
            onValueChange={(v) => setWorkflowFilter(v as WorkflowFilter)}
            className="w-auto min-w-[150px]"
            options={[
              { value: 'all', label: 'Any status' },
              { value: 'invited', label: 'Invited' },
              { value: 'confirmed', label: 'Confirmed' },
              { value: 'declined', label: 'Declined' },
              { value: 'unset', label: 'No status set' },
            ]}
          />
          <div className="ml-auto">
            <Button variant="outline" onClick={() => setTaskOpen(true)} disabled={filtered.length === 0}>
              <Plus />
              Add task
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
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
            description="Import a CSV or add a speaker to start building your roster."
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>
                  <Upload />
                  Import CSV
                </Button>
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <UserPlus />
                  Add speaker
                </Button>
              </div>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Search className="h-6 w-6 text-muted-foreground" />}
            title="No matches"
            description="No speakers match your search and filters."
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setSearch('')
                  clearFilters()
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[44px] pr-0">
                  <Checkbox checked={headerChecked} onCheckedChange={toggleAll} aria-label="Select all speakers" />
                </TableHead>
                <TableHead>Speaker</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="w-[90px] text-center">Sessions</TableHead>
                <TableHead className="w-[180px]">Onboarding</TableHead>
                <TableHead className="w-[150px]">Last portal visit</TableHead>
                <TableHead className="w-[160px] text-right">Invite</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((speaker) => (
                <TableRow
                  key={speaker.contact_id}
                  data-testid={`speaker-row-${speaker.contact_id}`}
                  data-state={selected.has(speaker.contact_id) ? 'selected' : undefined}
                >
                  <TableCell className="pr-0">
                    <Checkbox
                      checked={selected.has(speaker.contact_id)}
                      onCheckedChange={() => toggleOne(speaker.contact_id)}
                      aria-label={`Select ${speaker.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setOpenContactId(speaker.contact_id)}
                      className="flex w-full items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                    >
                      <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground group-hover:underline">{speaker.name}</div>
                        {speaker.email && (
                          <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                            <Mail className="h-3 w-3 shrink-0" />
                            {speaker.email}
                          </div>
                        )}
                      </div>
                    </button>
                  </TableCell>
                  <TableCell data-testid={`speaker-status-${speaker.contact_id}`}>
                    <WorkflowStatusBadge status={speaker.speaker_status} />
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
        <>
          <AddTaskDialog
            open={taskOpen}
            onOpenChange={setTaskOpen}
            eventId={event.id}
            speakers={filtered}
            selected={selected}
            onCreated={() => {
              queryClient.invalidateQueries({ queryKey: speakersKey })
              setSelected(new Set())
            }}
          />
          <ImportSpeakersDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            eventId={event.id}
            onImported={() => revealRoster()}
          />
          <AddSpeakerDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            eventId={event.id}
            onAdded={(email) => revealRoster(email)}
          />
          <SpeakerDrawer
            eventId={event.id}
            contactId={openContactId}
            onOpenChange={(open) => !open && setOpenContactId(null)}
            onChanged={refreshRoster}
          />
        </>
      )}

      <InviteLinkDialog invite={inviteLink} onOpenChange={(open) => !open && setInviteLink(null)} />
    </div>
  )
}

// ── CSV helpers (exported for tests) ─────────────────────────────────────────

export function onboardingStatusLabel(speaker: EventSpeaker): string {
  if (speaker.tasks_total === 0) return 'No tasks'
  if (speaker.tasks_outstanding === 0) return 'Onboarded'
  return `${speaker.tasks_done}/${speaker.tasks_total} done`
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The roster as CSV text: name, email, company, status, invited, sessions. */
export function speakersToCsv(speakers: EventSpeaker[]): string {
  const header = ['Name', 'Email', 'Company', 'Status', 'Invited', 'Sessions']
  const rows = speakers.map((s) => [
    s.name,
    s.email ?? '',
    s.company_name ?? '',
    onboardingStatusLabel(s),
    s.invited ? 'Yes' : 'No',
    String(s.session_count),
  ])
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── speaker profile drawer ───────────────────────────────────────────────────

function SpeakerDrawer({
  eventId,
  contactId,
  onOpenChange,
  onChanged,
}: {
  eventId: string
  contactId: string | null
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const open = Boolean(contactId)
  const profileQuery = useQuery({
    queryKey: ['speakerProfile', eventId, contactId],
    queryFn: () => getSpeakerProfile(eventId, contactId!),
    enabled: open && Boolean(contactId),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'left-auto right-0 top-0 h-screen max-h-screen w-full max-w-none translate-x-0 translate-y-0',
          'flex flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-xl',
          'data-[state=open]:slide-in-from-right-8 data-[state=closed]:slide-out-to-right-8'
        )}
      >
        {profileQuery.isPending ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-12 w-12 rounded-full" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : profileQuery.error ? (
          <div className="p-6">
            <DialogTitle>Speaker</DialogTitle>
            <DialogDescription className="mt-2 text-destructive">
              {(profileQuery.error as Error).message}
            </DialogDescription>
          </div>
        ) : profileQuery.data ? (
          <SpeakerProfileBody
            eventId={eventId}
            profile={profileQuery.data}
            onChanged={onChanged}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SpeakerProfileBody({
  eventId,
  profile,
  onChanged,
}: {
  eventId: string
  profile: SpeakerProfile
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const speaker = profile.speaker
  const [editing, setEditing] = useState(false)

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [about, setAbout] = useState('')
  // Travel & logistics lives ON the speaker record, not in an onboarding task:
  // flights and hotel nights are facts about the person, not work to be done.
  const [logistics, setLogistics] = useState('')

  const beginEdit = () => {
    setFirstName(speaker.first_name ?? '')
    setLastName(speaker.last_name ?? '')
    setEmail(speaker.email ?? '')
    setCompany(speaker.company_name ?? '')
    setTitle(speaker.title ?? '')
    setAbout(speaker.about ?? '')
    setLogistics(speaker.logistics_notes ?? '')
    setEditing(true)
  }

  const save = useMutation({
    mutationFn: () =>
      updateSpeaker(eventId, speaker.contact_id, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        company_name: company.trim(),
        title: title.trim(),
        about: about.trim(),
        logistics_notes: logistics.trim(),
      }),
    onSuccess: () => {
      toast({ title: 'Speaker updated', description: `Saved changes for ${speaker.name}.` })
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['speakerProfile', eventId, speaker.contact_id] })
      onChanged()
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save", description: error.message }),
  })

  /**
   * The workflow status saves on change — one control, one click, no edit mode.
   * It is the field an organizer updates most often (a speaker replies, you
   * mark them confirmed), so making it wait behind Edit → Save would be wrong.
   */
  const setStatus = useMutation({
    mutationFn: (next: SpeakerStatus | '') =>
      updateSpeaker(eventId, speaker.contact_id, { speaker_status: next }),
    onSuccess: (_saved, next) => {
      toast({
        title: next ? `Marked ${WORKFLOW_META[next].label.toLowerCase()}` : 'Status cleared',
        description: speaker.name,
      })
      queryClient.invalidateQueries({ queryKey: ['speakerProfile', eventId, speaker.contact_id] })
      onChanged()
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't set status", description: error.message }),
  })

  return (
    <>
      <div className="border-b border-border px-6 py-5 pr-12">
        <div className="flex items-start gap-3">
          <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-xl leading-snug">{speaker.name}</DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {speaker.email && (
                <span className="inline-flex items-center gap-1">
                  <Mail className="h-3.5 w-3.5" />
                  {speaker.email}
                </span>
              )}
              {(speaker.title || speaker.company_name) && (
                <span className="inline-flex items-center gap-1">
                  <Building2 className="h-3.5 w-3.5" />
                  {[speaker.title, speaker.company_name].filter(Boolean).join(' · ')}
                </span>
              )}
            </DialogDescription>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {/* Derived, not chosen: "a portal magic link exists". Named for
                  what it means so it can't be read as the workflow status the
                  organizer sets below. */}
              {speaker.invited ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Portal invited
                </Badge>
              ) : (
                <Badge variant="outline">No portal invite</Badge>
              )}
              <Badge variant="muted">{speaker.session_count} session{speaker.session_count === 1 ? '' : 's'}</Badge>
              {speaker.tasks_total > 0 && (
                <Badge variant={speaker.tasks_outstanding === 0 ? 'success' : 'warning'}>
                  {speaker.tasks_outstanding === 0
                    ? 'Onboarded'
                    : `${speaker.tasks_done}/${speaker.tasks_total} tasks`}
                </Badge>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Label htmlFor="speaker-status" className="text-xs text-muted-foreground">
                Speaker status
              </Label>
              <NativeSelect
                id="speaker-status"
                aria-label="Speaker status"
                data-testid="speaker-status-select"
                value={speaker.speaker_status ?? ''}
                disabled={setStatus.isPending}
                onValueChange={(v) => setStatus.mutate(v as SpeakerStatus | '')}
                className="h-8 w-auto min-w-[150px]"
                options={WORKFLOW_OPTIONS}
              />
            </div>
          </div>
          {!editing && (
            <Button size="sm" variant="secondary" onClick={beginEdit} data-testid="edit-speaker">
              <Pencil />
              Edit
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-app px-6 py-5">
        {editing ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-first">First name</Label>
                <Input id="edit-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-last">Last name</Label>
                <Input id="edit-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-email">Email</Label>
              <Input id="edit-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-company">Company</Label>
                <Input id="edit-company" value={company} onChange={(e) => setCompany(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-title">Title</Label>
                <Input id="edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-about">Bio</Label>
              <Textarea id="edit-about" value={about} onChange={(e) => setAbout(e.target.value)} rows={4} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-logistics">Travel &amp; logistics</Label>
              <p className="text-xs text-muted-foreground">
                Flights, hotel, arrival and departure, ground transport, dietary or accessibility
                needs.
              </p>
              <Textarea
                id="edit-logistics"
                data-testid="logistics-notes"
                value={logistics}
                onChange={(e) => setLogistics(e.target.value)}
                rows={4}
                placeholder="UA 482 arrives Sep 1, 08:10 — Hotel Marlowe, 2 nights — vegetarian"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(false)} disabled={save.isPending}>
                Cancel
              </Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending || !email.trim()}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {speaker.about && (
              <Section icon={<FileText className="h-4 w-4" />} title="Bio">
                <p className="whitespace-pre-wrap text-sm text-foreground">{speaker.about}</p>
              </Section>
            )}

            {/* Always rendered, even when empty: an organizer looking for a
                speaker's flight needs to find the field, not infer that it
                doesn't exist. A backend without migration 009 sends null and
                this reads as "nothing recorded yet". */}
            <Section icon={<Plane className="h-4 w-4" />} title="Travel &amp; logistics">
              {speaker.logistics_notes?.trim() ? (
                <p data-testid="logistics-notes" className="whitespace-pre-wrap text-sm text-foreground">
                  {speaker.logistics_notes}
                </p>
              ) : (
                <p data-testid="logistics-notes" className="text-sm text-muted-foreground">
                  No travel or logistics recorded. Use Edit to add flights, hotel, or arrival details.
                </p>
              )}
            </Section>

            <Section
              icon={<FileText className="h-4 w-4" />}
              title={`Submissions (${profile.submissions.length})`}
            >
              {profile.submissions.length === 0 ? (
                <Muted>No submissions yet.</Muted>
              ) : (
                <ul className="space-y-2">
                  {profile.submissions.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm text-foreground">{s.title || 'Untitled'}</span>
                      <StatusBadge status={s.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section icon={<Calendar className="h-4 w-4" />} title={`Sessions (${profile.sessions.length})`}>
              {profile.sessions.length === 0 ? (
                <Muted>Not on the program yet.</Muted>
              ) : (
                <ul className="space-y-2.5">
                  {profile.sessions.map((s) => (
                    <li key={s.id} className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-sm text-foreground">{s.title || 'Untitled'}</span>
                        <StatusBadge status={s.status} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {s.scheduled ? (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatDateTime(s.starts_at)}
                          </span>
                        ) : (
                          <span>Not scheduled</span>
                        )}
                        {s.room && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {s.room}
                          </span>
                        )}
                        {s.role && <span className="capitalize">{s.role}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              icon={<CheckCircle2 className="h-4 w-4" />}
              title={`Onboarding (${profile.speaker.tasks_done}/${profile.speaker.tasks_total})`}
            >
              {profile.onboarding.length === 0 ? (
                <Muted>No onboarding tasks assigned.</Muted>
              ) : (
                <ul className="space-y-2">
                  {profile.onboarding.map((t) => {
                    const done = t.status === 'approved' || t.status === 'done'
                    return (
                      <li key={t.assignment_id} className="flex items-center justify-between gap-3">
                        <span className={cn('min-w-0 truncate text-sm', done ? 'text-muted-foreground line-through' : 'text-foreground')}>
                          {t.name || 'Task'}
                        </span>
                        <Badge variant={done ? 'success' : t.status === 'submitted' ? 'warning' : 'outline'}>
                          {taskStatusLabel(t.status)}
                        </Badge>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Section>

            <Section
              icon={<MessageSquare className="h-4 w-4" />}
              title={`Communications (${profile.communications.length})`}
            >
              {profile.communications.length === 0 ? (
                <Muted>No emails sent to this speaker yet.</Muted>
              ) : (
                <ul className="space-y-2">
                  {profile.communications.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-foreground">{c.subject || c.template_key || 'Email'}</div>
                        <div className="text-xs text-muted-foreground">{relative(c.sent_at ?? c.created_at)}</div>
                      </div>
                      <Badge variant={c.status === 'sent' ? 'success' : c.status === 'failed' ? 'destructive' : 'muted'}>
                        {c.status ?? 'queued'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </div>
    </>
  )
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

// ── import CSV dialog ─────────────────────────────────────────────────────────

const CSV_TEMPLATE = 'first_name,last_name,email,company,title'

function ImportSpeakersDialog({
  open,
  onOpenChange,
  eventId,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  eventId: string
  onImported: () => void
}) {
  const [csv, setCsv] = useState('')
  const [result, setResult] = useState<SpeakerImportResult | null>(null)

  useEffect(() => {
    if (!open) {
      setCsv('')
      setResult(null)
    }
  }, [open])

  const run = useMutation({
    mutationFn: () => importSpeakers(eventId, { csv }),
    onSuccess: (data) => {
      setResult(data)
      if (data.created + data.updated > 0) onImported()
      toast({
        title: 'Import complete',
        description: `${data.created} added, ${data.updated} updated, ${data.skipped} skipped.`,
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't import", description: error.message }),
  })

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setCsv(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !run.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import speakers from CSV</DialogTitle>
          <DialogDescription>
            Columns: <code className="font-mono text-xs">{CSV_TEMPLATE}</code>. Rows are matched to existing
            speakers by email, so re-importing updates rather than duplicates.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="flex items-center gap-2">
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
              data-testid="csv-file"
            />
          </div>
          <Textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={`${CSV_TEMPLATE}\nAda,Lovelace,ada@example.com,Analytical Engines,Mathematician`}
            rows={7}
            className="font-mono text-xs"
            data-testid="csv-textarea"
          />

          {result && (
            <div
              className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm"
              data-testid="import-result"
            >
              <div className="flex flex-wrap gap-2">
                <Badge variant="success">{result.created} added</Badge>
                <Badge variant="muted">{result.updated} updated</Badge>
                <Badge variant="outline">{result.skipped} skipped</Badge>
                {result.errors.length > 0 && (
                  <Badge variant="destructive">{result.errors.length} error{result.errors.length === 1 ? '' : 's'}</Badge>
                )}
              </div>
              {result.errors.length > 0 && (
                <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-destructive-strong">
                  {result.errors.map((err, i) => (
                    <li key={i}>
                      {err.line ? `Row ${err.line}: ` : ''}
                      {err.message}
                      {err.email ? ` (${err.email})` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={() => run.mutate()} disabled={!csv.trim() || run.isPending}>
            {run.isPending ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── manual add speaker dialog ────────────────────────────────────────────────

function AddSpeakerDialog({
  open,
  onOpenChange,
  eventId,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  eventId: string
  /** Called with the added speaker's email so the roster can point at them. */
  onAdded: (email: string) => void
}) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')

  const reset = () => {
    setFirstName('')
    setLastName('')
    setEmail('')
    setCompany('')
    setTitle('')
  }

  const add = useMutation({
    mutationFn: () =>
      importSpeakers(eventId, {
        rows: [
          {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            email: email.trim(),
            company: company.trim(),
            title: title.trim(),
          },
        ],
      }),
    onSuccess: (data) => {
      if (data.errors.length > 0) {
        toast({ variant: 'destructive', title: "Couldn't add speaker", description: data.errors[0].message })
        return
      }
      const added = email.trim()
      if (data.created > 0) {
        toast({
          title: 'Speaker added',
          description: `${firstName.trim() || added} is on the roster — showing them below.`,
        })
      } else {
        toast({ title: 'Already on the roster', description: `${added} was already a speaker.` })
      }
      reset()
      onOpenChange(false)
      onAdded(added)
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't add speaker", description: error.message }),
  })

  return (
    <Dialog open={open} onOpenChange={(next) => !add.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a speaker</DialogTitle>
          <DialogDescription>Add one speaker to the roster. They can be invited to the portal after.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-first">First name</Label>
              <Input id="add-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-last">Last name</Label>
              <Input id="add-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-email" required>
              Email
            </Label>
            <Input
              id="add-email"
              type="email"
              value={email}
              placeholder="speaker@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-company">Company</Label>
              <Input id="add-company" value={company} onChange={(e) => setCompany(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-title">Title</Label>
              <Input id="add-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} disabled={!email.trim() || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add speaker'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
              <NativeSelect
                id="task-kind"
                value={kind}
                onValueChange={(v) => setKind(v as TaskKind)}
                options={[
                  { value: 'todo', label: 'Checklist item' },
                  { value: 'file_request', label: 'File upload' },
                ]}
              />
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

// ── cells & bits ─────────────────────────────────────────────────────────────

const STATUS_META: Record<SubmissionStatus, { label: string; variant: 'default' | 'muted' | 'success' | 'warning' | 'destructive' | 'outline' }> = {
  draft: { label: 'Draft', variant: 'outline' },
  pending: { label: 'Pending', variant: 'muted' },
  accept_queue: { label: 'Accept queue', variant: 'warning' },
  accepted: { label: 'Accepted', variant: 'success' },
  decline_queue: { label: 'Decline queue', variant: 'warning' },
  declined: { label: 'Declined', variant: 'destructive' },
  withdrawn: { label: 'Withdrawn', variant: 'outline' },
}

function StatusBadge({ status }: { status: SubmissionStatus }) {
  const meta = STATUS_META[status] ?? { label: status, variant: 'muted' as const }
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

function taskStatusLabel(status: string | null): string {
  switch (status) {
    case 'approved':
    case 'done':
      return 'Done'
    case 'submitted':
      return 'In review'
    case 'denied':
      return 'Needs redo'
    default:
      return 'To do'
  }
}

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

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  try {
    return format(parseISO(value), 'MMM d, h:mm a')
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
