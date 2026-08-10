/**
 * The org-level speaker directory — every contact the organization has worked
 * with, across every event it has ever run.
 *
 * This is the one screen in dais that is NOT scoped to an event. The rest of
 * the app answers "who is speaking at this conference"; this answers "who have
 * we worked with", which is a different and longer-lived question: a returning
 * speaker should never re-key a bio, and a program chair planning next year
 * needs the roster from last year.
 *
 * Everything on the page composes around one filter object — search, the
 * attribute filters, and a saved segment are the same mechanism wearing three
 * hats, which is why "save this view as a segment" is a button rather than a
 * feature. Selection drives the bulk actions (email, add-to-event); a row opens
 * the shared contact drawer.
 *
 * Controls are native inputs/selects/checkboxes throughout — see
 * ui/native-select.tsx for why that matters here.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Building2,
  CalendarPlus,
  Copy,
  Filter,
  Mail,
  Plus,
  Search,
  Upload,
  Users,
  X,
} from 'lucide-react'

import {
  STAGE_LABELS,
  addToEvent,
  createPerson,
  createSegment,
  getOutreachLog,
  getOverview,
  importDirectory,
  listDirectory,
  mergePeople,
  renderMergeTags,
  sendOutreach,
  type DirectoryFilters,
  type DirectoryPerson,
  type ImportResult,
  type OutreachResult,
} from '@/lib/crmApi'
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
import { NativeSelect } from '@/ui/native-select'
import { Textarea } from '@/ui/textarea'
import { useToast } from '@/ui/use-toast'
import { CrmPersonDrawer } from '@/pages/CrmPersonDrawer'

const EMPTY_FILTERS: DirectoryFilters = {}

function activeCriteria(filters: DirectoryFilters): { key: keyof DirectoryFilters; label: string }[] {
  const labels: Record<string, string> = {
    q: 'Search',
    company: 'Company',
    title: 'Job title',
    tag: 'Tag',
    stage: 'Stage',
    event_id: 'Event',
  }
  return (Object.keys(filters) as (keyof DirectoryFilters)[])
    .filter((key) => Boolean(filters[key]))
    .map((key) => ({
      key,
      label: `${labels[key] ?? key}: ${key === 'stage' ? (STAGE_LABELS[String(filters[key])] ?? filters[key]) : filters[key]}`,
    }))
}

function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-soft">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function Directory() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<DirectoryFilters>(EMPTY_FILTERS)
  const [segmentId, setSegmentId] = useState('')
  const [showFilters, setShowFilters] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openPerson, setOpenPerson] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showSegment, setShowSegment] = useState(false)
  const [showEmail, setShowEmail] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [mergeSeed, setMergeSeed] = useState<DirectoryPerson | null>(null)
  const [bulkEvent, setBulkEvent] = useState('')

  const query = useMemo(
    () => ({ ...filters, ...(search.trim() ? { q: search.trim() } : {}), ...(segmentId ? { segment_id: segmentId } : {}) }),
    [filters, search, segmentId]
  )

  const directoryQuery = useQuery({
    queryKey: ['crm', 'directory', query],
    queryFn: () => listDirectory(query),
  })
  const overviewQuery = useQuery({ queryKey: ['crm', 'overview'], queryFn: getOverview })

  const data = directoryQuery.data
  const people = data?.people ?? []
  const facets = data?.facets
  const segments = data?.segments ?? []
  const activeSegment = segments.find((segment) => segment.id === segmentId)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['crm'] })
  }

  const clearAll = () => {
    setSearch('')
    setFilters(EMPTY_FILTERS)
    setSegmentId('')
  }

  const setFilter = (key: keyof DirectoryFilters, value: string) => {
    setSegmentId('')
    setFilters((current) => {
      const next = { ...current }
      if (value) next[key] = value
      else delete next[key]
      return next
    })
  }

  const toggle = (personId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(personId)) next.delete(personId)
      else next.add(personId)
      return next
    })
  }

  const selectedPeople = people.filter((person) => selected.has(person.id))

  const bulkEventMutation = useMutation({
    mutationFn: async (eventId: string) => {
      const results = await Promise.all(selectedPeople.map((person) => addToEvent(person.id, eventId)))
      return results
    },
    onSuccess: (results) => {
      const created = results.filter((result) => result.created).length
      toast({
        title: `Added to ${results[0]?.event.name ?? 'the event'}`,
        description: `${created} new contact${created === 1 ? '' : 's'} created, ${results.length - created} already there. Name, email, company and bio carried over.`,
      })
      setBulkEvent('')
      setSelected(new Set())
      refresh()
    },
    onError: (error: Error) => toast({ title: "Couldn't add to the event", description: error.message }),
  })

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Speaker Directory</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every contact your organization has worked with — across all events.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowLog(true)}>
            <Mail className="h-4 w-4" />
            Email history
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
            <Upload className="h-4 w-4" />
            Import CSV
          </Button>
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" />
            Add contact
          </Button>
        </div>
      </header>

      {/* CRM dashboard — org-wide KPIs and analytics (CRM-12). */}
      <section className="mt-6" aria-label="CRM overview">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total contacts" value={overviewQuery.data?.totals.contacts ?? 0} hint="Across every event" />
          <StatCard label="Events" value={overviewQuery.data?.totals.events ?? 0} />
          <StatCard
            label="Returning speakers"
            value={overviewQuery.data?.totals.returning_speakers ?? 0}
            hint="Appear at 2+ events"
          />
          <StatCard label="In pipeline" value={overviewQuery.data?.totals.in_pipeline ?? 0} />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-4 shadow-soft">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Top companies
            </h2>
            <ul className="mt-3 space-y-1.5">
              {(overviewQuery.data?.top_companies ?? []).length === 0 && (
                <li className="text-sm text-muted-foreground">No company data yet.</li>
              )}
              {(overviewQuery.data?.top_companies ?? []).map((row) => (
                <li key={row.name}>
                  <button
                    type="button"
                    onClick={() => setFilter('company', row.name)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-sm text-foreground hover:bg-accent"
                  >
                    <span className="truncate">{row.name}</span>
                    <span className="tabular-nums text-muted-foreground">{row.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-border bg-card p-4 shadow-soft">
            <h2 className="text-sm font-semibold text-foreground">Areas of focus (tags)</h2>
            <ul className="mt-3 space-y-1.5">
              {(overviewQuery.data?.top_tags ?? []).length === 0 && (
                <li className="text-sm text-muted-foreground">No tags applied yet.</li>
              )}
              {(overviewQuery.data?.top_tags ?? []).map((row) => (
                <li key={row.name}>
                  <button
                    type="button"
                    onClick={() => setFilter('tag', row.name)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-sm text-foreground hover:bg-accent"
                  >
                    <span className="truncate">{row.name}</span>
                    <span className="tabular-nums text-muted-foreground">{row.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-border bg-card p-4 shadow-soft">
            <h2 className="text-sm font-semibold text-foreground">Contacts by event</h2>
            <ul className="mt-3 space-y-1.5">
              {(overviewQuery.data?.by_event ?? []).length === 0 && (
                <li className="text-sm text-muted-foreground">No events yet.</li>
              )}
              {(overviewQuery.data?.by_event ?? []).map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setFilter('event_id', row.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-sm text-foreground hover:bg-accent"
                  >
                    <span className="truncate">{row.name}</span>
                    <span className="tabular-nums text-muted-foreground">{row.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Duplicate banner (CRM-06) */}
      {(data?.duplicate_count ?? 0) > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
          <Copy className="h-4 w-4 shrink-0 text-warning-strong" />
          <p className="text-sm text-foreground">
            <strong>{data?.duplicate_count}</strong> contacts look like duplicates (same name or
            similar address).
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMergeSeed(people.find((person) => person.is_duplicate) ?? null)}
          >
            Review &amp; merge
          </Button>
        </div>
      )}

      {/* Search + filters (CRM-01, CRM-02) */}
      <section className="mt-6 rounded-lg border border-border bg-card p-4 shadow-soft">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex min-w-[16rem] flex-1 items-center">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              aria-label="Search contacts"
              placeholder="Search contacts by name, email, company…"
              className="pl-9"
              onChange={(event) => {
                setSegmentId('')
                setSearch(event.target.value)
              }}
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowFilters((open) => !open)}>
            <Filter className="h-4 w-4" />
            {showFilters ? 'Hide filters' : 'Filter'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSegment(true)}
            disabled={activeCriteria(query).length === 0}
            title="Save the current filter as a reusable segment"
          >
            Save segment
          </Button>
          <Button variant="ghost" size="sm" onClick={clearAll}>
            Clear filters
          </Button>
        </div>

        {showFilters && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="crm-filter-company">Company</Label>
              <NativeSelect
                id="crm-filter-company"
                value={filters.company ?? ''}
                placeholder="Any company"
                onValueChange={(value) => setFilter('company', value)}
                options={(facets?.companies ?? []).map((name) => ({ value: name }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-filter-title">Job title</Label>
              <NativeSelect
                id="crm-filter-title"
                value={filters.title ?? ''}
                placeholder="Any title"
                onValueChange={(value) => setFilter('title', value)}
                options={(facets?.titles ?? []).map((name) => ({ value: name }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-filter-tag">Tag</Label>
              <NativeSelect
                id="crm-filter-tag"
                value={filters.tag ?? ''}
                placeholder="Any tag"
                onValueChange={(value) => setFilter('tag', value)}
                options={(facets?.tags ?? []).map((name) => ({ value: name }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-filter-stage">Pipeline stage</Label>
              <NativeSelect
                id="crm-filter-stage"
                value={filters.stage ?? ''}
                placeholder="Any stage"
                onValueChange={(value) => setFilter('stage', value)}
                options={(facets?.stages ?? []).map((stage) => ({
                  value: stage.value,
                  label: stage.label,
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-filter-event">Event</Label>
              <NativeSelect
                id="crm-filter-event"
                value={filters.event_id ?? ''}
                placeholder="Any event"
                onValueChange={(value) => setFilter('event_id', value)}
                options={(facets?.events ?? []).map((event) => ({
                  value: event.id,
                  label: event.name,
                }))}
              />
            </div>
          </div>
        )}

        {(activeCriteria(query).length > 0 || activeSegment) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Active filters:</span>
            {activeSegment && (
              <Badge variant="default">
                Segment: {activeSegment.name} ({activeSegment.kind})
              </Badge>
            )}
            {activeCriteria(query).map((criterion) => (
              <span
                key={String(criterion.key)}
                className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
              >
                {criterion.label}
                <button
                  type="button"
                  aria-label={`Remove filter ${criterion.label}`}
                  onClick={() => {
                    if (criterion.key === 'q') setSearch('')
                    else setFilter(criterion.key, '')
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Saved segments (CRM-09) */}
      <section className="mt-4" aria-label="Saved segments">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Segments</h2>
          {segments.length === 0 && (
            <span className="text-sm text-muted-foreground">
              None yet — filter the list and choose “Save segment”.
            </span>
          )}
          {segments.map((segment) => (
            <button
              key={segment.id}
              type="button"
              onClick={() => {
                setSearch('')
                setFilters(EMPTY_FILTERS)
                setSegmentId(segment.id)
              }}
              className={
                segment.id === segmentId
                  ? 'rounded-md border border-primary bg-primary-subtle px-2.5 py-1 text-sm font-medium text-primary'
                  : 'rounded-md border border-border bg-card px-2.5 py-1 text-sm text-foreground hover:bg-accent'
              }
            >
              {segment.name}
              <span className="ml-1.5 text-xs text-muted-foreground">
                {segment.member_count ?? segment.member_ids.length}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Bulk actions (CRM-10, CRM-11) */}
      {selected.size > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary-subtle px-4 py-3">
          <span className="text-sm font-medium text-foreground">
            {selected.size} contact{selected.size === 1 ? '' : 's'} selected
          </span>
          <Button size="sm" onClick={() => setShowEmail(true)}>
            <Mail className="h-4 w-4" />
            Send email
          </Button>
          <div className="flex items-center gap-2">
            <NativeSelect
              aria-label="Add selected contacts to event"
              className="h-9 w-56"
              value={bulkEvent}
              placeholder="Add to event…"
              onValueChange={setBulkEvent}
              options={(facets?.events ?? []).map((event) => ({ value: event.id, label: event.name }))}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!bulkEvent || bulkEventMutation.isPending}
              onClick={() => bulkEventMutation.mutate(bulkEvent)}
            >
              <CalendarPlus className="h-4 w-4" />
              Add to event
            </Button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {/* The roster */}
      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Showing <strong className="text-foreground">{data?.total ?? 0}</strong> of{' '}
            {data?.total_all ?? 0} contacts
          </p>
        </div>

        {directoryQuery.isPending ? (
          <div className="px-4 py-10 text-sm text-muted-foreground">Loading directory…</div>
        ) : directoryQuery.error ? (
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load the directory"
            description={(directoryQuery.error as Error).message}
            action={
              <Button size="sm" variant="secondary" onClick={() => directoryQuery.refetch()}>
                Try again
              </Button>
            }
          />
        ) : people.length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6 text-muted-foreground" />}
            title="No contacts match"
            description="Clear the filters, or import a CSV to populate the directory."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="w-10 px-4 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all contacts"
                      className="h-4 w-4 accent-primary"
                      checked={people.length > 0 && selected.size === people.length}
                      onChange={(event) =>
                        setSelected(event.target.checked ? new Set(people.map((p) => p.id)) : new Set())
                      }
                    />
                  </th>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-4 py-2.5 font-medium">Job title</th>
                  <th className="px-4 py-2.5 font-medium">Tags</th>
                  <th className="px-4 py-2.5 font-medium">Events</th>
                  <th className="px-4 py-2.5 font-medium">Stage</th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr
                    key={person.id}
                    className="border-b border-border/60 last:border-0 hover:bg-accent/50"
                  >
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${person.name}`}
                        className="h-4 w-4 accent-primary"
                        checked={selected.has(person.id)}
                        onChange={() => toggle(person.id)}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        className="text-left font-medium text-foreground hover:text-primary hover:underline"
                        onClick={() => setOpenPerson(person.id)}
                      >
                        {person.name}
                      </button>
                      {person.is_duplicate && (
                        <Badge variant="warning" className="ml-2 align-middle">
                          Possible duplicate
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{person.email}</td>
                    <td className="px-4 py-2.5 text-foreground">{person.company_name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-foreground">{person.title ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {person.tags.length === 0 && <span className="text-muted-foreground">—</span>}
                        {person.tags.map((tag) => (
                          <Badge key={tag} variant="default">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {person.events.length === 0 && <span className="text-muted-foreground">—</span>}
                        {person.events.map((event) => (
                          <Badge key={event.id} variant="muted">
                            {event.name}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline">
                        {STAGE_LABELS[person.pipeline_stage] ?? person.pipeline_stage}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openPerson && (
        <CrmPersonDrawer
          personId={openPerson}
          onClose={() => setOpenPerson(null)}
          onMerge={(person) => {
            setOpenPerson(null)
            setMergeSeed(person)
          }}
        />
      )}

      {showAdd && <AddContactDialog onClose={() => setShowAdd(false)} onSaved={refresh} />}
      {showImport && <ImportDialog events={facets?.events ?? []} onClose={() => setShowImport(false)} onDone={refresh} />}
      {showSegment && (
        <SaveSegmentDialog
          filters={query}
          memberIds={people.map((person) => person.id)}
          onClose={() => setShowSegment(false)}
          onSaved={(segment) => {
            refresh()
            setSegmentId(segment)
          }}
        />
      )}
      {mergeSeed && (
        <MergeDialog
          seed={mergeSeed}
          people={people}
          onClose={() => setMergeSeed(null)}
          onMerged={refresh}
        />
      )}
      {showEmail && (
        <OutreachDialog
          recipients={selectedPeople}
          onClose={() => setShowEmail(false)}
          onSent={() => {
            setSelected(new Set())
            refresh()
          }}
        />
      )}
      {showLog && <OutreachLogDialog onClose={() => setShowLog(false)} />}
    </div>
  )
}

/* ── Add contact ─────────────────────────────────────────────────────────── */

function AddContactDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast()
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    company_name: '',
    title: '',
    about: '',
  })

  const mutation = useMutation({
    mutationFn: () => createPerson(form),
    onSuccess: (person) => {
      toast({ title: `${person.name} added to the directory` })
      onSaved()
      onClose()
    },
    onError: (error: Error) => toast({ title: "Couldn't add the contact", description: error.message }),
  })

  const field = (key: keyof typeof form, label: string, placeholder = '') => (
    <div className="space-y-1.5">
      <Label htmlFor={`crm-new-${key}`}>{label}</Label>
      <Input
        id={`crm-new-${key}`}
        value={form[key]}
        placeholder={placeholder}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
      />
    </div>
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a contact</DialogTitle>
          <DialogDescription>
            Adds them to the org-level directory. You can push them into an event afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('first_name', 'First name')}
          {field('last_name', 'Last name')}
          <div className="sm:col-span-2">{field('email', 'Email', 'name@example.com')}</div>
          {field('company_name', 'Company')}
          {field('title', 'Job title')}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!form.email.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            Add contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ── CSV import ──────────────────────────────────────────────────────────── */

function ImportDialog({
  events,
  onClose,
  onDone,
}: {
  events: { id: string; name: string }[]
  onClose: () => void
  onDone: () => void
}) {
  const { toast } = useToast()
  const [csv, setCsv] = useState('')
  const [eventId, setEventId] = useState('')
  const [preview, setPreview] = useState<ImportResult | null>(null)

  const validate = useMutation({
    mutationFn: () => importDirectory({ csv, event_id: eventId || null, dry_run: true }),
    onSuccess: setPreview,
    onError: (error: Error) => toast({ title: "Couldn't read that file", description: error.message }),
  })

  const commit = useMutation({
    mutationFn: () => importDirectory({ csv, event_id: eventId || null }),
    onSuccess: (result) => {
      toast({
        title: 'Import complete',
        description: `${result.created} added, ${result.updated} updated, ${result.skipped} skipped.`,
      })
      onDone()
      onClose()
    },
    onError: (error: Error) => toast({ title: "Couldn't import", description: error.message }),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import contacts from CSV</DialogTitle>
          <DialogDescription>
            Columns recognised: first_name, last_name, email, company, title, bio. Upload a file or
            paste the rows, then review before importing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="crm-import-file">Upload CSV</Label>
            <input
              id="crm-import-file"
              type="file"
              accept=".csv,text/csv"
              className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                const text = await file.text()
                setCsv(text)
                setPreview(null)
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="crm-import-csv">Or paste CSV</Label>
            <Textarea
              id="crm-import-csv"
              rows={6}
              value={csv}
              placeholder="first_name,last_name,email,company,title"
              onChange={(event) => {
                setCsv(event.target.value)
                setPreview(null)
              }}
            />
          </div>

          {events.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="crm-import-event">Also add to event (optional)</Label>
              <NativeSelect
                id="crm-import-event"
                value={eventId}
                placeholder="Directory only"
                onValueChange={setEventId}
                options={events.map((event) => ({ value: event.id, label: event.name }))}
              />
            </div>
          )}

          {preview && (
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-sm font-medium text-foreground">
                Validation: {preview.ready} row{preview.ready === 1 ? '' : 's'} ready,{' '}
                {preview.errors.length} flagged, {preview.skipped} duplicate
                {preview.skipped === 1 ? '' : 's'} in the file.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Column mapping: {(preview.columns ?? []).join(', ')}
                {preview.ignored_columns?.length
                  ? ` · ignored: ${preview.ignored_columns.join(', ')}`
                  : ''}
              </p>
              {preview.errors.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {preview.errors.slice(0, 6).map((error, index) => (
                    <li key={index} className="text-xs text-destructive-strong">
                      Row {error.line ?? '?'}: {error.message}
                    </li>
                  ))}
                </ul>
              )}
              {(preview.preview ?? []).length > 0 && (
                <table className="mt-3 w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 font-medium">Name</th>
                      <th className="py-1 font-medium">Email</th>
                      <th className="py-1 font-medium">Company</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(preview.preview ?? []).slice(0, 8).map((row) => (
                      <tr key={row.email}>
                        <td className="py-0.5">{[row.first_name, row.last_name].filter(Boolean).join(' ')}</td>
                        <td className="py-0.5 text-muted-foreground">{row.email}</td>
                        <td className="py-0.5">{row.company ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={!csv.trim() || validate.isPending} onClick={() => validate.mutate()}>
            Validate
          </Button>
          <Button disabled={!csv.trim() || commit.isPending} onClick={() => commit.mutate()}>
            Import contacts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ── Save segment ────────────────────────────────────────────────────────── */

function SaveSegmentDialog({
  filters,
  memberIds,
  onClose,
  onSaved,
}: {
  filters: DirectoryFilters
  memberIds: string[]
  onClose: () => void
  onSaved: (segmentId: string) => void
}) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'dynamic' | 'curated'>('dynamic')

  const mutation = useMutation({
    mutationFn: () =>
      createSegment({
        name: name.trim(),
        kind,
        filter: filters,
        member_ids: kind === 'curated' ? memberIds : undefined,
      }),
    onSuccess: (segment) => {
      toast({ title: `Segment "${segment.name}" saved` })
      onSaved(segment.id)
      onClose()
    },
    onError: (error: Error) => toast({ title: "Couldn't save the segment", description: error.message }),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save as a segment</DialogTitle>
          <DialogDescription>
            Saves the current filter so you can reopen this list later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="crm-segment-name">Segment name</Label>
            <Input
              id="crm-segment-name"
              value={name}
              placeholder="AI Experts"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="crm-segment-kind">Segment type</Label>
            <NativeSelect
              id="crm-segment-kind"
              value={kind}
              onValueChange={(value) => setKind(value as 'dynamic' | 'curated')}
              options={[
                { value: 'dynamic', label: 'Dynamic — auto-updating as contacts match' },
                { value: 'curated', label: 'Curated — freeze today’s members' },
              ]}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Saving {memberIds.length} matching contact{memberIds.length === 1 ? '' : 's'}.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            Save segment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ── Merge duplicates ────────────────────────────────────────────────────── */

const MERGE_FIELDS: { key: keyof DirectoryPerson; label: string }[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'company_name', label: 'Company' },
  { key: 'title', label: 'Job title' },
  { key: 'about', label: 'Bio' },
]

function MergeDialog({
  seed,
  people,
  onClose,
  onMerged,
}: {
  seed: DirectoryPerson
  people: DirectoryPerson[]
  onClose: () => void
  onMerged: () => void
}) {
  const { toast } = useToast()
  const candidates = people.filter((person) => person.id !== seed.id && person.is_duplicate)
  const [otherId, setOtherId] = useState(candidates[0]?.id ?? '')
  const [primaryId, setPrimaryId] = useState(seed.id)
  const [choices, setChoices] = useState<Record<string, string>>({})

  const other = people.find((person) => person.id === otherId)
  const primary = primaryId === seed.id ? seed : other
  const duplicate = primaryId === seed.id ? other : seed

  const mutation = useMutation({
    mutationFn: () => mergePeople(primary!.id, duplicate!.id, choices),
    onSuccess: (result) => {
      toast({
        title: 'Records merged',
        description: `${result.person.name} now holds the merged data. ${result.total_all} contacts remain.`,
      })
      onMerged()
      onClose()
    },
    onError: (error: Error) => toast({ title: "Couldn't merge", description: error.message }),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Merge duplicate contacts</DialogTitle>
          <DialogDescription>
            Choose which record survives and which value wins for each field.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 || !other || !primary || !duplicate ? (
          <p className="text-sm text-muted-foreground">
            No other duplicate record to merge with.
          </p>
        ) : (
          <div className="space-y-4">
            {candidates.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="crm-merge-other">Merge with</Label>
                <NativeSelect
                  id="crm-merge-other"
                  value={otherId}
                  onValueChange={setOtherId}
                  options={candidates.map((person) => ({
                    value: person.id,
                    label: `${person.name} <${person.email}>`,
                  }))}
                />
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left">
                    <th className="px-3 py-2 font-medium">Field</th>
                    <th className="px-3 py-2 font-medium">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="crm-merge-primary"
                          className="h-4 w-4 accent-primary"
                          checked={primaryId === seed.id}
                          onChange={() => setPrimaryId(seed.id)}
                        />
                        {seed.name} <span className="text-xs text-muted-foreground">({seed.email})</span>
                      </label>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="crm-merge-primary"
                          className="h-4 w-4 accent-primary"
                          checked={primaryId === other.id}
                          onChange={() => setPrimaryId(other.id)}
                        />
                        {other.name} <span className="text-xs text-muted-foreground">({other.email})</span>
                      </label>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border/60">
                    <td className="px-3 py-2 text-muted-foreground">Primary record</td>
                    <td className="px-3 py-2">{primaryId === seed.id ? 'Keeps this record' : '—'}</td>
                    <td className="px-3 py-2">{primaryId === other.id ? 'Keeps this record' : '—'}</td>
                  </tr>
                  {MERGE_FIELDS.map(({ key, label }) => {
                    const left = String(seed[key] ?? '')
                    const right = String(other[key] ?? '')
                    return (
                      <tr key={String(key)} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 text-muted-foreground">{label}</td>
                        {[seed, other].map((person) => {
                          const value = String(person[key] ?? '')
                          const chosen = choices[String(key)] ?? (primaryId === seed.id ? left : right)
                          return (
                            <td key={person.id} className="px-3 py-2">
                              <label className="flex items-start gap-2">
                                <input
                                  type="radio"
                                  name={`crm-merge-${String(key)}`}
                                  className="mt-1 h-4 w-4 accent-primary"
                                  checked={chosen === value}
                                  onChange={() =>
                                    setChoices((current) => ({ ...current, [String(key)]: value }))
                                  }
                                />
                                <span className="text-foreground">{value || '—'}</span>
                              </label>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-strong">
              Merging cannot be undone. {duplicate.name} &lt;{duplicate.email}&gt; will be folded into{' '}
              {primary.name} &lt;{primary.email}&gt;, keeping its notes and event links.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!other || !primary || !duplicate || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Merge records
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ── Bulk outreach ───────────────────────────────────────────────────────── */

function OutreachDialog({
  recipients,
  onClose,
  onSent,
}: {
  recipients: DirectoryPerson[]
  onClose: () => void
  onSent: () => void
}) {
  const { toast } = useToast()
  const [subject, setSubject] = useState('Speak at DevFlow Conf 2027?')
  const [body, setBody] = useState(
    '<p>Hi {{first_name}},</p><p>We loved your work at {{company}} and would love to have you speak. Submit a talk when you have a moment.</p>'
  )
  const [result, setResult] = useState<OutreachResult | null>(null)

  const mutation = useMutation({
    mutationFn: () =>
      sendOutreach({
        person_ids: recipients.map((person) => person.id),
        subject,
        body_html: body,
      }),
    onSuccess: (payload) => {
      setResult(payload)
      toast({
        title: `Sent to ${payload.sent + payload.skipped} of ${payload.total} recipients`,
        description: payload.skipped
          ? `${payload.skipped} suppressed (reserved demo address).`
          : undefined,
      })
      onSent()
    },
    onError: (error: Error) => toast({ title: "Couldn't send", description: error.message }),
  })

  const first = recipients[0]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Email {recipients.length} contacts</DialogTitle>
          <DialogDescription>
            Merge tags resolve per recipient: {'{{first_name}}'}, {'{{company}}'}, {'{{title}}'},{' '}
            {'{{event_name}}'}.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success-strong">
              Sent {result.sent}, suppressed {result.skipped}, failed {result.failed} of{' '}
              {result.total} recipients.
            </p>
            <ul className="space-y-1">
              {result.recipients.map((row) => (
                <li key={row.person_id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-foreground">
                    {row.name} <span className="text-muted-foreground">&lt;{row.email}&gt;</span>
                  </span>
                  <Badge variant={row.status === 'sent' ? 'success' : 'muted'}>{row.status}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="crm-email-subject">Subject</Label>
              <Input
                id="crm-email-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-email-body">Message</Label>
              <Textarea
                id="crm-email-body"
                rows={6}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
            {first && (
              <div className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Preview for {first.name}
                </p>
                <p className="mt-1.5 text-sm font-medium text-foreground">
                  {renderMergeTags(subject, first)}
                </p>
                <div
                  className="prose-sm mt-1 text-sm text-muted-foreground"
                  dangerouslySetInnerHTML={{ __html: renderMergeTags(body, first) }}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Recipients: {recipients.map((person) => person.email).join(', ')}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button disabled={!subject.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
              Send email
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OutreachLogDialog({ onClose }: { onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['crm', 'outreach-log'], queryFn: getOutreachLog })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Email history</DialogTitle>
          <DialogDescription>Every message sent from the directory, newest first.</DialogDescription>
        </DialogHeader>
        {(data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing sent from the directory yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 font-medium">Recipient</th>
                <th className="py-2 font-medium">Subject</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((entry) => (
                <tr key={entry.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 text-muted-foreground">{entry.to}</td>
                  <td className="py-2 text-foreground">{entry.subject}</td>
                  <td className="py-2">
                    <Badge variant={entry.status === 'sent' ? 'success' : 'muted'}>{entry.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
