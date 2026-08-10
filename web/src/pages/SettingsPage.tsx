import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Code2,
  Copy,
  ExternalLink,
  KeyRound,
  Plus,
  Settings,
  Trash2,
  X,
} from 'lucide-react'

import { ApiError, apiGet, unwrapList, type EventSummary } from '@/lib/api'
import {
  createApiToken,
  createTaxonomy,
  deleteApiToken,
  deleteTaxonomy,
  listApiTokens,
  listTaxonomy,
  updateEvent,
  updateTaxonomy,
  type ApiTokenRow,
  type TaxonomyInput,
  type TaxonomyKind,
  type TaxonomyRow,
} from '@/lib/adminApi'
import {
  embedPageQuery,
  embedIframeSnippet,
  embedScriptSnippet,
  publicCalendarFeedUrl,
  publicProgramFeedUrl,
  publicProgramUrl,
  sanitizeAccent,
  type EmbedOptions,
  type EmbedWidget,
} from '@/lib/programApi'
import { buildZonedTimestamp, zonedDay } from '@/lib/scheduleApi'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/pages/Forms'
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
import { EmptyState } from '@/ui/empty-state'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select'
import { Skeleton } from '@/ui/skeleton'
import { toast } from '@/ui/use-toast'

/** A short, opinionated list — enough for a conference, not an IANA browser. */
const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
]

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function timezoneOptions(current?: string | null): string[] {
  const list = [localTimezone(), ...COMMON_TIMEZONES]
  if (current) list.unshift(current)
  const seen: string[] = []
  for (const tz of list) if (tz && seen.indexOf(tz) === -1) seen.push(tz)
  return seen
}

/** `<input type="date">` shows the calendar day in the event's own timezone. */
export function toDateInput(iso?: string | null, timezone?: string | null): string {
  return zonedDay(iso, timezone) ?? ''
}

/** A date input -> event-local start/end boundary, stored as an absolute instant. */
export function fromDateInput(
  value: string,
  timezone?: string | null,
  endOfDay = false
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const boundary = buildZonedTimestamp(value, endOfDay ? 24 * 60 : 0, timezone)
  const instant = new Date(boundary)
  if (Number.isNaN(instant.getTime())) return null
  if (!endOfDay) return boundary
  // Store the inclusive local end-of-day. The agenda treats ends_at as an
  // exclusive range boundary, so its existing "one minute before end" logic
  // still lands on the organizer's final date.
  return `${new Date(instant.getTime() - 1).toISOString().slice(0, -1)}+00:00`
}

interface EventDraft {
  name: string
  slug: string
  timezone: string
  starts_at: string
  ends_at: string
  location: string
}

function toEventDraft(event: EventSummary): EventDraft {
  const timezone = event.timezone || localTimezone()
  return {
    name: event.name ?? '',
    slug: event.slug ?? '',
    timezone,
    starts_at: toDateInput(event.starts_at, timezone),
    ends_at: toDateInput(event.ends_at, timezone),
    location: event.location ?? '',
  }
}

/** The alphabet a public URL may use — mirrors SLUG_PATTERN in admin_routes.py. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** null = fine. A string = the reason the Save button should stay down. */
export function slugError(value: string): string | null {
  const slug = value.trim()
  if (!slug) return 'A public URL slug is required.'
  if (!SLUG_RE.test(slug)) {
    return 'Use lowercase letters, numbers and hyphens only — no spaces, and not at either end.'
  }
  return null
}

export function SettingsPage() {
  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = eventsQuery.data?.[0]

  if (!eventsQuery.isPending && !eventsQuery.error && !event) {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
          <Settings className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Event details and the vocabulary your program is built from.
          </p>
        </div>
      </header>

      {eventsQuery.error ? (
        <div className="mt-6 rounded-lg border border-border bg-card shadow-soft">
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load your event"
            description={eventsQuery.error.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => eventsQuery.refetch()}>
                Try again
              </Button>
            }
          />
        </div>
      ) : !event ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-64 w-full max-w-2xl" />
          <Skeleton className="h-48 w-full max-w-2xl" />
        </div>
      ) : (
        <div className="mt-6 max-w-3xl space-y-6">
          <EventCard event={event} />
          <EmbedSection event={event} />
          <TaxonomySection
            eventId={event.id}
            kind="tracks"
            title="Tracks"
            description="Themes submissions are routed into. Colors carry through to the agenda."
            extra="color"
          />
          <TaxonomySection
            eventId={event.id}
            kind="rooms"
            title="Rooms"
            description="Where sessions happen. Capacity powers over-capacity conflict checks."
            extra="capacity"
          />
          <TaxonomySection
            eventId={event.id}
            kind="formats"
            title="Formats"
            description="Talk, workshop, panel — each with a default length."
            extra="duration"
          />
          <TaxonomySection
            eventId={event.id}
            kind="levels"
            title="Levels"
            description="Audience experience level, shown on the public agenda."
          />
          <TaxonomySection
            eventId={event.id}
            kind="tags"
            title="Tags"
            description="Free-form labels for filtering and reporting."
          />
          <ApiTokensSection />
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Embed & share                                                              */
/* -------------------------------------------------------------------------- */

/** One shareable public URL: the link itself, a copy button, and an open-in-tab. */
function PublicLinkRow({
  label,
  url,
  testId,
}: {
  label: string
  url: string
  testId: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>
      <code
        data-testid={testId}
        className="min-w-0 flex-1 truncate rounded-md border border-border bg-background/60 px-3 py-2 font-mono text-xs text-foreground"
      >
        {url}
      </code>
      <CopyButton value={url} label={`Copy ${label.toLowerCase()} link`} />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label.toLowerCase()}`}
        title={`Open ${label.toLowerCase()}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  )
}

/** A copyable code block: the snippet plus a Copy → "Copied" button. */
function SnippetBlock({
  title,
  hint,
  snippet,
  testId,
}: {
  title: string
  hint: string
  snippet: string
  testId: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      // jsdom and plain-http origins have no clipboard API — fall through to
      // the toast so the organizer can still select the snippet by hand.
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast({
        variant: 'destructive',
        title: "Couldn't copy",
        description: 'Select the snippet and copy it manually.',
      })
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="min-w-[92px] shrink-0"
          data-testid={`copy-${testId}`}
          onClick={copy}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="overflow-x-auto rounded-md border border-border bg-background/60 px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground"
      >
        {snippet}
      </pre>
    </div>
  )
}

/**
 * The organizer's window onto the public, embeddable programme (EMB-15): the
 * two shareable page links, plus paste-ready snippets for putting either widget
 * on the event's own site. The /e/ pages are served with `frame-ancestors *`
 * precisely so these embeds work cross-origin.
 */
function EmbedSection({ event }: { event: EventSummary }) {
  const [widget, setWidget] = useState<EmbedWidget>('schedule')
  const [track, setTrack] = useState('')
  const [accent, setAccent] = useState('')
  const [compact, setCompact] = useState(false)
  const tracksQuery = useQuery({
    queryKey: ['taxonomy', 'tracks', event.id],
    queryFn: () => listTaxonomy(event.id, 'tracks'),
  })

  if (!event.slug) return null

  const accentError = accent && !sanitizeAccent(accent) ? 'Enter exactly 6 hex digits.' : null
  const options: EmbedOptions = {
    track: track || undefined,
    accent: sanitizeAccent(accent) ?? undefined,
    compact,
  }
  const scriptSnippet = embedScriptSnippet(event.slug, widget, options)
  const iframeSnippet = embedIframeSnippet(event.slug, widget, options)

  return (
    <section className="rounded-lg border border-border bg-card shadow-soft">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-primary-subtle text-primary">
          <Code2 className="h-4 w-4" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">Embed &amp; share</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Your live schedule and speaker pages — share the links, or drop either one
            straight into your event website.
          </p>
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div className="space-y-2">
          <PublicLinkRow
            label="Schedule"
            url={publicProgramUrl(event.slug, 'schedule')}
            testId="public-url-schedule"
          />
          <PublicLinkRow
            label="Speakers"
            url={publicProgramUrl(event.slug, 'speakers')}
            testId="public-url-speakers"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="embed-widget">Widget to embed</Label>
          <div className="sm:w-56">
            <NativeSelect
              id="embed-widget"
              aria-label="Widget to embed"
              className="h-9"
              value={widget}
              onValueChange={(value) => setWidget(value as EmbedWidget)}
              options={[
                { value: 'schedule', label: 'Schedule' },
                { value: 'speakers', label: 'Speakers' },
              ]}
            />
          </div>
        </div>

        <div className="grid gap-4 rounded-lg border border-border bg-background/50 p-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="embed-track">Track filter</Label>
            <NativeSelect
              id="embed-track"
              aria-label="Track filter"
              className="h-9"
              value={track}
              onValueChange={setTrack}
              options={[
                { value: '', label: 'All tracks' },
                ...(tracksQuery.data ?? []).map((item) => ({
                  value: item.name,
                  label: `${item.name} track`,
                })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="embed-accent">Accent color</Label>
            <Input
              id="embed-accent"
              aria-label="Accent color"
              className="h-9 font-mono"
              value={accent}
              maxLength={6}
              placeholder="4962E2"
              aria-invalid={accentError ? true : undefined}
              onChange={(event) => setAccent(event.target.value)}
            />
            {accentError && <p className="text-xs text-destructive">{accentError}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="embed-compact">Layout</Label>
            <div className="flex h-9 items-center gap-2">
              <Checkbox
                id="embed-compact"
                checked={compact}
                onCheckedChange={(checked) => setCompact(checked === true)}
              />
              <Label htmlFor="embed-compact" className="font-normal">
                Compact
              </Label>
            </div>
          </div>
        </div>

        <SnippetBlock
          title="Script embed (recommended)"
          hint="Auto-resizes to fit the programme — no scrollbars, no fixed height to maintain."
          snippet={scriptSnippet}
          testId="embed-snippet-script"
        />
        <SnippetBlock
          title="Plain iframe"
          hint="No JavaScript needed. Fixed height — change 600px to suit your page."
          snippet={iframeSnippet}
          testId="embed-snippet-iframe"
        />

        <EmbedPreview slug={event.slug} widget={widget} options={options} />

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">JSON feed</p>
          <p className="text-xs text-muted-foreground">
            The same data behind the widgets, as public read-only JSON — for a custom
            rendering on your own site.
          </p>
          <PublicLinkRow
            label="JSON"
            url={publicProgramFeedUrl(event.slug, widget)}
            testId="embed-json-feed"
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Calendar feed (iCal)</p>
          <p className="text-xs text-muted-foreground">
            Subscribe to the complete published schedule from any calendar app.
          </p>
          <PublicLinkRow
            label="iCal"
            url={publicCalendarFeedUrl(event.slug)}
            testId="embed-ical-feed"
          />
        </div>
      </div>
    </section>
  )
}

/**
 * A live rendering of the widget, in a real cross-origin-shaped iframe, right
 * under the snippet that produces it. The point is proof rather than
 * decoration: the organizer sees the embed working before pasting it anywhere,
 * and a broken widget is visible here instead of on their marketing site.
 */
function EmbedPreview({
  slug,
  widget,
  options,
}: {
  slug: string
  widget: EmbedWidget
  options: EmbedOptions
}) {
  const src = `${publicProgramUrl(slug, widget)}?${embedPageQuery(options)}`
  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Live preview</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Exactly what the snippet above renders on your site — live event data, fully
          interactive.
        </p>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background/60">
        <iframe
          key={src}
          src={src}
          title={`Preview of the ${widget} widget`}
          data-testid="embed-preview"
          loading="lazy"
          className="block h-[420px] w-full border-0"
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* API tokens                                                                 */
/* -------------------------------------------------------------------------- */

function formatUsed(value?: string | null): string {
  if (!value) return 'Never used'
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return 'Never used'
  return `Last used ${new Date(t).toLocaleDateString()}`
}

/** Keys for the org-scoped public /v1 and MCP APIs. The raw key is shown once, right
 *  after creation; the list only ever holds metadata. */
function ApiTokensSection() {
  const queryClient = useQueryClient()
  const queryKey = ['api-tokens']
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [freshKey, setFreshKey] = useState<string | null>(null)

  const query = useQuery({ queryKey, queryFn: listApiTokens })

  const create = useMutation({
    mutationFn: (tokenName: string) => createApiToken(tokenName),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey })
      setDialogOpen(false)
      setName('')
      setFreshKey(result.token)
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't create token", description: error.message }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteApiToken(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast({ title: 'Token revoked' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't revoke token", description: error.message }),
  })

  const tokens = query.data ?? []

  return (
    <section className="rounded-lg border border-border bg-card shadow-soft">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <KeyRound className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">API tokens</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Keys for the public REST and MCP integration APIs.{' '}
              <Link to="/developers" className="text-primary hover:underline">
                Read the API docs
              </Link>
              .
            </p>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New token
        </Button>
      </div>

      {freshKey && (
        <div className="border-b border-border bg-primary-subtle/50 px-5 py-4">
          <p className="text-sm font-medium text-foreground">
            Copy your key now — it won&rsquo;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-foreground">
              {freshKey}
            </code>
            <CopyButton value={freshKey} label="Copy API key" />
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => setFreshKey(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <div className="divide-y divide-border">
        {query.isPending ? (
          <div className="space-y-2 px-5 py-4">
            <Skeleton className="h-6 w-1/3" />
          </div>
        ) : query.error ? (
          <p className="px-5 py-4 text-sm text-destructive">{query.error.message}</p>
        ) : tokens.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No tokens yet — create one to call the API.
          </p>
        ) : (
          tokens.map((token: ApiTokenRow) => (
            <div
              key={token.id}
              className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{token.name}</p>
                <p className="text-xs text-muted-foreground">{formatUsed(token.last_used_at)}</p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Revoke ${token.name}`}
                className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-within:opacity-100"
                disabled={remove.isPending}
                onClick={() => remove.mutate(token.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New API token</DialogTitle>
            <DialogDescription>
              Name it so you remember what it&rsquo;s for. The key is shown once after you create it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = name.trim()
              if (trimmed) create.mutate(trimmed)
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="token-name" required>
                Token name
              </Label>
              <Input
                id="token-name"
                autoFocus
                value={name}
                placeholder="Zapier integration"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create token'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function EventCard({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<EventDraft>(() => toEventDraft(event))
  const [baseline, setBaseline] = useState(() => JSON.stringify(toEventDraft(event)))

  useEffect(() => {
    const next = toEventDraft(event)
    setDraft(next)
    setBaseline(JSON.stringify(next))
  }, [event])

  const dirty = JSON.stringify(draft) !== baseline
  const slugProblem = slugError(draft.slug)
  const slugChanged = draft.slug.trim() !== (event.slug ?? '')

  const save = useMutation({
    mutationFn: () =>
      updateEvent(event.id, {
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        timezone: draft.timezone || null,
        starts_at: fromDateInput(draft.starts_at, draft.timezone),
        ends_at: fromDateInput(draft.ends_at, draft.timezone, true),
        location: draft.location.trim() || null,
      }),
    onSuccess: () => {
      // Every public link on this page — the /e/{slug} URLs, the embed snippets,
      // and the schedule's publish confirmation — reads the event row, so one
      // invalidation is what makes them all agree with the new slug.
      queryClient.invalidateQueries({ queryKey: ['events'] })
      toast({ title: 'Event updated' })
    },
    onError: (error: Error) =>
      toast({
        variant: 'destructive',
        // A 409 is a specific, fixable answer ("someone has that URL"), not a
        // generic failure — say so rather than echoing a status code.
        title:
          error instanceof ApiError && error.status === 409
            ? 'That public URL is taken'
            : "Couldn't save event",
        description:
          error instanceof ApiError && error.status === 409
            ? 'Another event already uses that slug. Try a different one.'
            : error.message,
      }),
  })

  const set = (patch: Partial<EventDraft>) => setDraft({ ...draft, ...patch })

  return (
    <section className="rounded-lg border border-border bg-card shadow-soft">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Event</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Used on public pages, calendar invites and every email you send.
          </p>
        </div>
        {/* Default variant = solid Sessionboard blue. Prominent while there are
            unsaved changes; the disabled state (clean form) reads as muted. */}
        <Button
          className="min-w-[104px]"
          data-testid="save-event"
          disabled={!dirty || Boolean(slugProblem) || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <div className="space-y-4 px-5 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="event-name" required>
              Event name
            </Label>
            <Input id="event-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="event-location">Location</Label>
            <Input
              id="event-location"
              value={draft.location}
              placeholder="San Francisco, CA"
              onChange={(e) => set({ location: e.target.value })}
            />
          </div>
        </div>

        {/* The public URL. Renaming the event does NOT move it — which is how a
            published schedule ends up announcing a slug nobody recognises — so
            it is a field the organizer owns, with the consequence spelled out. */}
        <div className="space-y-1.5">
          <Label htmlFor="event-slug" required>
            Public URL slug
          </Label>
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-sm text-muted-foreground">/e/</span>
            <Input
              id="event-slug"
              data-testid="event-slug"
              value={draft.slug}
              placeholder="ai-builders-summit"
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={slugProblem ? true : undefined}
              aria-describedby="event-slug-help"
              onChange={(e) => set({ slug: e.target.value.trim().toLowerCase() })}
            />
            <span className="shrink-0 font-mono text-sm text-muted-foreground">/</span>
          </div>
          <p
            id="event-slug-help"
            data-testid="event-slug-help"
            className={cn(
              'text-xs',
              slugProblem
                ? 'font-medium text-destructive'
                : slugChanged
                  ? 'font-medium text-warning-strong'
                  : 'text-muted-foreground'
            )}
          >
            {slugProblem ??
              (slugChanged
                ? `Heads up: changing this changes every public link. /e/${event.slug}/ will stop working and become /e/${draft.slug.trim()}/.`
                : 'Lowercase letters, numbers and hyphens. Used in every public and embedded link.')}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="event-start">Starts</Label>
            <Input
              id="event-start"
              type="date"
              value={draft.starts_at}
              onChange={(e) => set({ starts_at: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="event-end">Ends</Label>
            <Input
              id="event-end"
              type="date"
              value={draft.ends_at}
              onChange={(e) => set({ ends_at: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Timezone</Label>
            <Select value={draft.timezone} onValueChange={(value) => set({ timezone: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timezoneOptions(event.timezone).map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Taxonomy                                                                   */
/* -------------------------------------------------------------------------- */

type ExtraKind = 'color' | 'capacity' | 'duration'

const DEFAULT_COLOR = '#6366F1'

interface RowDraft {
  name: string
  color: string
  capacity: string
  default_duration_min: string
}

function emptyDraft(): RowDraft {
  return { name: '', color: DEFAULT_COLOR, capacity: '', default_duration_min: '' }
}

function rowToDraft(row: TaxonomyRow): RowDraft {
  return {
    name: row.name ?? '',
    color: row.color || DEFAULT_COLOR,
    capacity: row.capacity == null ? '' : String(row.capacity),
    default_duration_min: row.default_duration_min == null ? '' : String(row.default_duration_min),
  }
}

function draftToInput(draft: RowDraft, extra?: ExtraKind): TaxonomyInput {
  const input: TaxonomyInput = { name: draft.name.trim() }
  if (extra === 'color') input.color = draft.color || null
  if (extra === 'capacity') input.capacity = draft.capacity === '' ? null : Number(draft.capacity)
  if (extra === 'duration') {
    input.default_duration_min =
      draft.default_duration_min === '' ? null : Number(draft.default_duration_min)
  }
  return input
}

function TaxonomySection({
  eventId,
  kind,
  title,
  description,
  extra,
}: {
  eventId: string
  kind: TaxonomyKind
  title: string
  description: string
  extra?: ExtraKind
}) {
  const queryClient = useQueryClient()
  const queryKey = ['taxonomy', kind, eventId]
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<RowDraft>(emptyDraft)
  const [addDraft, setAddDraft] = useState<RowDraft>(emptyDraft)

  const query = useQuery({ queryKey, queryFn: () => listTaxonomy(eventId, kind) })

  const invalidate = () => queryClient.invalidateQueries({ queryKey })

  const create = useMutation({
    mutationFn: () => createTaxonomy(eventId, kind, draftToInput(addDraft, extra)),
    onSuccess: () => {
      invalidate()
      setAddDraft(emptyDraft())
      toast({ title: `${singular(title)} added` })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't add", description: error.message }),
  })

  const update = useMutation({
    mutationFn: (id: string) => updateTaxonomy(kind, id, draftToInput(editDraft, extra)),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      toast({ title: 'Saved' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save", description: error.message }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteTaxonomy(kind, id),
    onSuccess: () => {
      invalidate()
      toast({ title: 'Deleted' })
    },
    onError: (error: Error) => {
      // 409 is the backend saying "something still points at this row".
      const inUse = error instanceof ApiError && error.status === 409
      toast({
        variant: 'destructive',
        title: inUse ? 'In use by sessions' : "Couldn't delete",
        description: inUse
          ? `Reassign the sessions using this ${singular(title).toLowerCase()} first.`
          : error.message,
      })
    },
  })

  const rows = query.data ?? []

  return (
    <section className="rounded-lg border border-border bg-card shadow-soft">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="divide-y divide-border">
        {query.isPending ? (
          <div className="space-y-2 px-5 py-4">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-6 w-1/4" />
          </div>
        ) : query.error ? (
          <p className="px-5 py-4 text-sm text-destructive">{query.error.message}</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No {title.toLowerCase()} yet — add the first one below.
          </p>
        ) : (
          rows.map((row) =>
            editingId === row.id ? (
              <div key={row.id} className="flex flex-wrap items-center gap-2 px-5 py-3">
                <RowFields draft={editDraft} setDraft={setEditDraft} extra={extra} />
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    aria-label="Save"
                    disabled={!editDraft.name.trim() || update.isPending}
                    onClick={() => update.mutate(row.id)}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Cancel"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <div
                key={row.id}
                className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover"
              >
                {extra === 'color' && (
                  <span
                    className="h-4 w-4 shrink-0 rounded-full border border-border"
                    style={{ backgroundColor: row.color || DEFAULT_COLOR }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {row.name}
                </span>
                {extra === 'capacity' && (
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {row.capacity == null ? '—' : `${row.capacity} seats`}
                  </span>
                )}
                {extra === 'duration' && (
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {row.default_duration_min == null ? '—' : `${row.default_duration_min} min`}
                  </span>
                )}
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(row.id)
                      setEditDraft(rowToDraft(row))
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${row.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(row.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )
          )
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-2 border-t border-border bg-background/60 px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (addDraft.name.trim()) create.mutate()
        }}
      >
        <RowFields draft={addDraft} setDraft={setAddDraft} extra={extra} placeholder={`New ${singular(title).toLowerCase()}`} />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={!addDraft.name.trim() || create.isPending}
        >
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </form>
    </section>
  )
}

function RowFields({
  draft,
  setDraft,
  extra,
  placeholder = 'Name',
}: {
  draft: RowDraft
  setDraft: (next: RowDraft) => void
  extra?: ExtraKind
  placeholder?: string
}) {
  return (
    <>
      {extra === 'color' && (
        <input
          type="color"
          aria-label="Color"
          value={draft.color}
          onChange={(e) => setDraft({ ...draft, color: e.target.value })}
          className={cn(
            'h-8 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-card p-1',
            'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20'
          )}
        />
      )}
      <Input
        className="h-8 w-[220px]"
        value={draft.name}
        placeholder={placeholder}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      {extra === 'capacity' && (
        <Input
          type="number"
          min={0}
          className="h-8 w-[120px]"
          value={draft.capacity}
          placeholder="Seats"
          onChange={(e) => setDraft({ ...draft, capacity: e.target.value })}
        />
      )}
      {extra === 'duration' && (
        <Input
          type="number"
          min={5}
          step={5}
          className="h-8 w-[130px]"
          value={draft.default_duration_min}
          placeholder="Minutes"
          onChange={(e) => setDraft({ ...draft, default_duration_min: e.target.value })}
        />
      )}
    </>
  )
}

/** "Tracks" → "Track". Only ever fed the five section titles above. */
function singular(title: string): string {
  return title.endsWith('s') ? title.slice(0, -1) : title
}
