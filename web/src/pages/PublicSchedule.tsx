import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarPlus,
  CalendarX2,
  Clock,
  Download,
  Linkedin,
  MapPin,
  Search,
  Star,
  Twitter,
} from 'lucide-react'

import {
  buildScheduleIcs,
  buildSessionIcs,
  downloadIcs,
  formatDayLabel,
  formatTimeRange,
  formatTimeZoneNote,
  getProgramSchedule,
  getProgramSession,
  readStarredIds,
  toggleStarredId,
  type ProgramSession,
  type ProgramSessionDetail,
} from '@/lib/programApi'
import { sanitizeBranding, type BrandingConfig, type ScheduleLayout } from '@/lib/branding'
import { useBrandingFavicon, useBrandingFonts } from '@/lib/brandFonts'
import { stripUnsafeHtml } from '@/lib/sanitize'
import { cn } from '@/lib/utils'
import { Input } from '@/ui/input'
import { NativeSelect } from '@/ui/native-select'
import { Skeleton } from '@/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import {
  Avatar,
  ProgramShell,
  programAccentStyle,
  useEmbedHeight,
} from '@/pages/publicProgramShared'

/** Sentinel for "no filter" — shared by the track chips and the facet selects. */
const ANY = '__all__'

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatEventDateRange(start: string | null, end: string | null, zone: string | null): string {
  if (!start) return ''
  try {
    const options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', timeZone: zone || 'UTC' }
    const formatter = new Intl.DateTimeFormat('en-US', options)
    const startDate = new Date(start)
    if (!end) return formatter.format(startDate)
    const endDate = new Date(end)
    const startMonth = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: zone || 'UTC' }).format(startDate)
    const endMonth = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: zone || 'UTC' }).format(endDate)
    const startDay = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: zone || 'UTC' }).format(startDate)
    const endDay = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: zone || 'UTC' }).format(endDate)
    return startMonth === endMonth ? `${startMonth} ${startDay}–${endDay}` : `${formatter.format(startDate)}–${formatter.format(endDate)}`
  } catch {
    return start
  }
}

/**
 * A reader's anonymous, device-local "my schedule": starred session ids kept in
 * localStorage (keyed per event slug), no login. Exported so the speakers page
 * shares the exact same selection through the reused detail modal.
 */
export function useMySchedule(slug: string) {
  const [starred, setStarred] = useState<Set<string>>(() => new Set(readStarredIds(slug)))

  // A different event's page must show its own selection, not the last one's.
  useEffect(() => {
    setStarred(new Set(readStarredIds(slug)))
  }, [slug])

  const toggle = useCallback(
    (id: string) => {
      // localStorage is the source of truth; the Set just mirrors it for render.
      setStarred(new Set(toggleStarredId(slug, id)))
    },
    [slug]
  )

  return { starred, toggle }
}

export function PublicSchedule() {
  const { slug = '' } = useParams()
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === '1'
  const urlCompact = searchParams.get('compact') === '1'
  const accent = searchParams.get('accent')
  const requestedTrack = searchParams.get('track')?.trim() || ANY

  // No browser timezone is sent: the public page must render in the EVENT's
  // timezone (the zone the organizer published against), so a Tokyo visitor
  // sees the same day/time as the organizer — never their own browser clock.
  const query = useQuery({
    queryKey: ['program-schedule', slug],
    queryFn: () => getProgramSchedule(slug),
    enabled: Boolean(slug),
    retry: false,
  })

  const branding = useMemo(
    () => sanitizeBranding(query.data?.event.branding),
    [query.data?.event.branding]
  )
  useBrandingFonts(branding)
  useBrandingFavicon(branding)
  const compact = urlCompact || branding.density === 'compact'
  const scheduleLayout = branding.schedule_layout

  const days = useMemo(() => query.data?.days ?? [], [query.data])
  // The zone every time/day on this page is formatted in: the event's own.
  const zone = query.data?.event.timezone ?? null
  const eventLocation = query.data?.event.location ?? null

  const [activeDate, setActiveDate] = useState('')
  const [track, setTrack] = useState<string>(requestedTrack)
  const [format, setFormat] = useState<string>(ANY)
  const [room, setRoom] = useState<string>(ANY)
  const [search, setSearch] = useState('')
  const [mine, setMine] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { starred, toggle } = useMySchedule(slug)

  useEffect(() => {
    if (days.length && !days.some((d) => d.date === activeDate)) setActiveDate(days[0].date)
  }, [days, activeDate])

  useEffect(() => setTrack(requestedTrack), [requestedTrack])

  // Re-measure the embed iframe whenever the visible content changes.
  useEmbedHeight(embed)

  const activeDay = days.find((d) => d.date === activeDate) ?? days[0]

  // Every facet is built from whatever actually appears in the published
  // program — an event with one room never sees a room filter (EMB-03).
  const { tracks, formats, rooms } = useMemo(() => {
    const trackSeen = new Map<string, string | null>()
    const formatSeen = new Set<string>()
    const roomSeen = new Set<string>()
    for (const day of days) {
      for (const session of day.sessions) {
        if (session.track?.name && !trackSeen.has(session.track.name)) {
          trackSeen.set(session.track.name, session.track.color)
        }
        if (session.format) formatSeen.add(session.format)
        if (session.room) roomSeen.add(session.room)
      }
    }
    const alpha = (a: string, b: string) => a.localeCompare(b)
    return {
      tracks: [...trackSeen.entries()].map(([name, color]) => ({ name, color })),
      formats: [...formatSeen].sort(alpha),
      rooms: [...roomSeen].sort(alpha),
    }
  }, [days])

  // Track, format and room compose: a session must clear all three (and then
  // the search, and then the day tab) to show.
  const matchesFacets = useCallback(
    (session: ProgramSession) =>
      (track === ANY || session.track?.name === track) &&
      (format === ANY || session.format === format) &&
      (room === ANY || session.room === room),
    [track, format, room]
  )

  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  // Search and "my schedule" both span every day, so a match or a star on an
  // inactive tab still surfaces. The default view is the active day's tab.
  const crossDay = searching || mine

  // The active day's sessions (facet-filtered) — the default, non-search view.
  const dayResults = useMemo(
    () => (activeDay?.sessions ?? []).filter(matchesFacets),
    [activeDay, matchesFacets]
  )

  // A flat, cross-day result set for the search and/or my-schedule views. Each
  // row carries its date so the card can label the day it belongs to (EMB-02).
  const flatResults = useMemo(() => {
    if (!crossDay) return []
    const out: { session: ProgramSession; date: string }[] = []
    for (const day of days) {
      for (const session of day.sessions) {
        if (!matchesFacets(session)) continue
        if (mine && !(session.id && starred.has(session.id))) continue
        if (searching) {
          const haystack = [
            session.title,
            htmlToText(session.description),
            session.room ?? '',
            session.format ?? '',
            ...session.speakers.map((s) => s.name),
          ]
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(q)) continue
        }
        out.push({ session, date: day.date })
      }
    }
    return out
  }, [days, matchesFacets, q, mine, searching, starred, crossDay])

  const starredCount = starred.size
  const filtersActive = track !== ANY || format !== ANY || room !== ANY || searching
  const clearFilters = () => {
    setTrack(ANY)
    setFormat(ANY)
    setRoom(ANY)
    setSearch('')
  }

  const exportMine = () => {
    const inputs = days
      .flatMap((d) => d.sessions)
      .filter((s) => s.id && starred.has(s.id))
      .map((s) => ({
        id: s.id,
        friendly_id: s.friendly_id,
        title: s.title,
        description: htmlToText(s.description || ''),
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        location: [s.room, eventLocation].filter(Boolean).join(', ') || null,
      }))
    const ics = buildScheduleIcs(inputs)
    downloadIcs(ics, `${slug || 'my'}-schedule`)
  }

  const referenceIso =
    query.data?.event.starts_at ?? days[0]?.sessions[0]?.starts_at ?? null
  const zoneNote = formatTimeZoneNote(zone, referenceIso)

  const emptyWhenMine = mine && flatResults.length === 0

  let body: ReactNode
  if (query.isPending) {
    body = (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    )
  } else if (query.error || !query.data) {
    body = (
      <EmptyState
        title="This schedule isn't available"
        description={query.error?.message ?? 'Double-check the link.'}
      />
    )
  } else if (days.length === 0) {
    body = (
      <EmptyState
        title="The schedule is coming soon"
        description="Sessions will appear here once the program is published."
      />
    )
  } else {
    body = (
      <div className={compact ? 'space-y-4' : 'space-y-6'}>
        {days.length > 1 && (
          <Tabs value={activeDate} onValueChange={setActiveDate}>
            <TabsList variant="underline" className="w-auto gap-2 border-0 [&>span]:hidden">
              {days.map((day) => (
                <TabsTrigger
                  key={day.date}
                  value={day.date}
                  className="rounded-full bg-foreground/[0.045] px-3 py-1 text-xs data-[state=active]:bg-status-solid data-[state=active]:text-status-solid-foreground"
                >
                  {formatDayLabel(day.date)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {tracks.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                <TrackChip
                  label="All tracks"
                  color={null}
                  active={track === ANY}
                  onClick={() => setTrack(ANY)}
                />
                {tracks.map((t) => (
                  <TrackChip
                    key={t.name}
                    label={t.name}
                    color={t.color}
                    active={track === t.name}
                    onClick={() => setTrack(t.name)}
                  />
                ))}
              </div>
            ) : (
              <span />
            )}
            <div className="w-full sm:w-64">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search sessions or speakers"
                  className="pl-9"
                  aria-label="Search sessions"
                />
              </div>
              {/* The count is cross-day: search spans every tab (EMB-02). */}
              {searching && (
                <p
                  role="status"
                  data-testid="search-result-count"
                  className="mt-1.5 text-xs font-medium text-muted-foreground"
                >
                  {flatResults.length === 1
                    ? '1 session matches'
                    : `${flatResults.length} sessions match`}
                </p>
              )}
            </div>
          </div>

          {/* Format + room facets, composed with the track chips (EMB-03).
              Native <select>s so a keyboard — or a browser agent — can drive
              them; only rendered for facets the programme actually uses. */}
          {(formats.length > 0 || rooms.length > 0 || filtersActive) && (
            <div className="flex flex-wrap items-center gap-2">
              {formats.length > 0 && (
                <div className="w-[10.5rem]">
                  <NativeSelect
                    aria-label="Filter by format"
                    wrapperClassName="w-auto"
                    className="h-8 text-xs"
                    value={format}
                    onValueChange={setFormat}
                    options={[
                      { value: ANY, label: 'All formats' },
                      ...formats.map((name) => ({ value: name, label: name })),
                    ]}
                  />
                </div>
              )}
              {rooms.length > 0 && (
                <div className="w-[10.5rem]">
                  <NativeSelect
                    aria-label="Filter by room"
                    wrapperClassName="w-auto"
                    className="h-8 text-xs"
                    value={room}
                    onValueChange={setRoom}
                    options={[
                      { value: ANY, label: 'All rooms' },
                      ...rooms.map((name) => ({ value: name, label: name })),
                    ]}
                  />
                </div>
              )}
              {filtersActive && (
                <button
                  type="button"
                  data-testid="clear-filters"
                  onClick={clearFilters}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}

          {/* Personal schedule: a device-local, no-login selection (EMB-10/11). */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="my-schedule-toggle"
              aria-pressed={mine}
              onClick={() => setMine((v) => !v)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                mine
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              )}
            >
              <Star className={cn('h-3.5 w-3.5', mine && 'fill-current')} />
              My schedule
              {starredCount > 0 && (
                <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
                  {starredCount}
                </span>
              )}
            </button>
            {starredCount > 0 && (
              <button
                type="button"
                data-testid="export-my-schedule"
                onClick={exportMine}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" />
                Export my schedule (.ics)
              </button>
            )}
          </div>
        </div>

        {zoneNote && embed && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {zoneNote}
          </p>
        )}

        {crossDay ? (
          flatResults.length === 0 ? (
            <EmptyState
              title={emptyWhenMine ? 'Nothing saved yet' : 'No sessions match'}
              description={
                emptyWhenMine
                  ? 'Star sessions to build your personal schedule.'
                  : 'Try a different track, format or room — or clear your search.'
              }
            />
          ) : (
            <div className={compact ? 'space-y-2' : 'space-y-3'}>
              <p className="text-xs font-medium text-muted-foreground" role="status">
                {flatResults.length} {mine && !searching ? 'saved' : 'result'}
                {flatResults.length === 1 ? '' : 's'}
                {' across all days'}
              </p>
              <SessionCollection
                items={flatResults}
                layout={scheduleLayout}
                zone={zone}
                location={eventLocation}
                starred={starred}
                onToggleStar={toggle}
                onOpen={setSelectedId}
                compact={compact}
              />
            </div>
          )
        ) : dayResults.length === 0 ? (
          <EmptyState
            title="No sessions match"
            description="Try a different track, format or room — or clear your search."
          />
        ) : (
          <SessionCollection
            items={dayResults.map((session) => ({ session }))}
            layout={scheduleLayout}
            zone={zone}
            location={eventLocation}
            starred={starred}
            onToggleStar={toggle}
            onOpen={setSelectedId}
            compact={compact}
          />
        )}

        <SessionDetailDialog
          slug={slug}
          sessionId={selectedId}
          zone={zone}
          starred={starred}
          onToggleStar={toggle}
          onClose={() => setSelectedId(null)}
          branding={branding}
          accent={accent}
        />
      </div>
    )
  }

  if (embed) {
    return (
      <div
        data-testid="public-program-page"
        data-branding-root
        data-compact={compact ? 'true' : undefined}
        className={compact ? 'bg-transparent px-1 py-1' : 'bg-transparent px-1 py-2'}
        style={programAccentStyle(accent, branding)}
      >
        {body}
      </div>
    )
  }

  return (
    <ProgramShell
      slug={slug}
      eventName={query.data?.event.name}
      active="schedule"
      accent={accent}
      compact={compact}
      branding={branding}
    >
      {!compact && query.data && (
        <header className="mb-8">
          <h1 className="text-[40px] font-normal leading-[1.08] tracking-[-0.03em] text-foreground">
            {query.data.event.name}
          </h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
            {formatEventDateRange(query.data.event.starts_at, query.data.event.ends_at, zone) && (
              <span>{formatEventDateRange(query.data.event.starts_at, query.data.event.ends_at, zone)}</span>
            )}
            {query.data.event.location && <><span aria-hidden>·</span><span>{query.data.event.location}</span></>}
            {zoneNote && <><span aria-hidden>·</span><span>{zoneNote}</span></>}
          </p>
        </header>
      )}
      {body}
    </ProgramShell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

interface SessionCollectionItem {
  session: ProgramSession
  date?: string
}

function SessionCollection({
  items,
  layout,
  zone,
  location,
  starred,
  onToggleStar,
  onOpen,
  compact,
}: {
  items: SessionCollectionItem[]
  layout: ScheduleLayout
  zone: string | null
  location: string | null
  starred: Set<string>
  onToggleStar: (id: string) => void
  onOpen: (id: string) => void
  compact: boolean
}) {
  const card = ({ session, date }: SessionCollectionItem, index: number) => (
    <li key={session.id || `${session.title}-${index}`}>
      <SessionCard
        session={session}
        zone={zone}
        date={date}
        location={location}
        starred={Boolean(session.id && starred.has(session.id))}
        onToggleStar={() => session.id && onToggleStar(session.id)}
        onOpen={() => session.id && onOpen(session.id)}
        compact={compact}
      />
    </li>
  )

  if (layout === 'grid') {
    return (
      <ol
        data-testid="schedule-layout-grid"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 [&>li>article]:h-full [&>li>article]:rounded-[var(--radius)] [&>li>article]:border [&>li>article]:border-border [&>li>article]:px-4"
      >
        {items.map(card)}
      </ol>
    )
  }

  if (layout === 'tracks') {
    const groups = new Map<string, SessionCollectionItem[]>()
    for (const item of items) {
      const label = item.session.track?.name || 'Other sessions'
      groups.set(label, [...(groups.get(label) ?? []), item])
    }
    return (
      <div data-testid="schedule-layout-tracks" className="space-y-7">
        {[...groups.entries()].map(([label, sessions]) => (
          <section key={label}>
            <h2 className="mb-2 text-sm font-semibold text-foreground">{label}</h2>
            <ol className="divide-y divide-border border-t border-border">
              {sessions.map(card)}
            </ol>
          </section>
        ))}
      </div>
    )
  }

  return (
    <ol data-testid="schedule-layout-list" className="divide-y divide-border border-t border-border">
      {items.map(card)}
    </ol>
  )
}

function SessionCard({
  session,
  zone,
  date,
  location,
  starred,
  onToggleStar,
  onOpen,
  compact = false,
}: {
  session: ProgramSession
  zone: string | null
  date?: string
  location: string | null
  starred: boolean
  onToggleStar: () => void
  onOpen: () => void
  compact?: boolean
}) {
  const time = formatTimeRange(session.starts_at, session.ends_at, zone)
  const summary = htmlToText(session.description)
  // The card shows a two-line snippet; "Show more" un-clamps it right here on
  // the card (EMB-01), which is a different affordance from opening the card's
  // full detail modal — a reader can skim the whole abstract without leaving
  // the list. Collapsed again by "Show less".
  const [expanded, setExpanded] = useState(false)

  const addToCalendar = () => {
    const ics = buildSessionIcs({
      id: session.id,
      friendly_id: session.friendly_id,
      title: session.title,
      description: htmlToText(session.description || ''),
      starts_at: session.starts_at,
      ends_at: session.ends_at,
      location: [session.room, location].filter(Boolean).join(', ') || null,
    })
    downloadIcs(ics, session.friendly_id || session.title || 'session')
  }

  return (
    <article
      role="button"
      tabIndex={0}
      data-testid="session-card"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        'cursor-pointer bg-card text-left transition-colors hover:bg-foreground/[0.028] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'py-3' : 'py-6'
      )}
    >
      <div className={cn('grid gap-3', compact ? 'grid-cols-[92px_minmax(0,1fr)]' : 'sm:grid-cols-[130px_minmax(0,1fr)] sm:gap-5')}>
        <div className="shrink-0">
          {date && (
            <div className="mb-1 font-mono text-[10px] text-placeholder">{formatDayLabel(date)}</div>
          )}
          <div className="font-mono text-[11px] leading-5 text-foreground">{time}</div>
          {(session.room || session.format) && (
            <div className="mt-0.5 text-[11px] text-placeholder">
              {session.room}
              {session.room && session.format ? ' · ' : ''}
              {session.format && <FormatTag format={session.format} />}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {session.track && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  aria-hidden
                  className="h-[5px] w-[5px] rounded-full bg-status-queue"
                  style={session.track.color ? { backgroundColor: session.track.color } : undefined}
                />
                {session.track.name}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              {session.starts_at && (
                <CardIconButton
                  label={`Add ${session.title} to calendar`}
                  onClick={addToCalendar}
                >
                  <CalendarPlus className="h-4 w-4" />
                </CardIconButton>
              )}
              <StarButton starred={starred} onToggle={onToggleStar} />
            </div>
          </div>
          <h3 className="mt-1.5 text-[17px] font-medium leading-6 tracking-[-0.015em] text-foreground">
            {session.title}
          </h3>
          {summary && (
            <p
              data-testid="session-summary"
              className={cn(
                'mt-1 max-w-[68ch] text-[12.5px] leading-5 text-muted-foreground',
                !expanded && 'line-clamp-2'
              )}
            >
              {summary}
            </p>
          )}
          {summary && (
            <button
              type="button"
              data-testid="session-show-more"
              aria-expanded={expanded}
              onClick={(e) => {
                // The card itself opens the detail modal — this button only
                // grows the description in place, so it must not bubble.
                e.stopPropagation()
                setExpanded((value) => !value)
              }}
              className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
          {session.speakers.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
              {session.speakers.map((speaker) => (
                <div key={speaker.name} className="flex items-center gap-2">
                  <span className="h-6 w-6 shrink-0 overflow-hidden rounded-full">
                    <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
                  </span>
                  <span className="text-[12.5px]">
                    <span className="font-medium text-foreground">{speaker.name}</span>
                    {(speaker.title || speaker.company) && (
                      <span className="text-muted-foreground">
                        {' · '}
                        {[speaker.title, speaker.company].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

/** A small tag naming the session's format (Talk, Workshop, …), beside the track chip. */
function FormatTag({ format }: { format: string }) {
  return (
    <span
      data-testid="session-format"
      className="text-inherit"
    >
      {format}
    </span>
  )
}

/** The star toggle that adds/removes a session from the reader's personal schedule. */
function StarButton({
  starred,
  onToggle,
  className,
}: {
  starred: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      data-testid="star-toggle"
      aria-pressed={starred}
      aria-label={starred ? 'Remove from my schedule' : 'Add to my schedule'}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        starred && 'border-warning/50 text-warning-strong hover:text-warning',
        className
      )}
    >
      <Star className={cn('h-4 w-4', starred && 'fill-current')} />
    </button>
  )
}

/** An icon-only card action; stops propagation so it never opens the detail modal. */
function CardIconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}

/** The session-detail modal (EMB-08): full description, speakers with bio, a
 * star for the personal schedule, and an add-to-calendar download. Fetches on
 * open so the card list stays lean. Exported so the speakers page reuses it. */
export function SessionDetailDialog({
  slug,
  sessionId,
  zone,
  starred,
  onToggleStar,
  onClose,
  branding,
  accent,
}: {
  slug: string
  sessionId: string | null
  zone: string | null
  starred: Set<string>
  onToggleStar: (id: string) => void
  onClose: () => void
  branding?: BrandingConfig
  accent?: string | null
}) {
  const detail = useQuery({
    queryKey: ['program-session', slug, sessionId],
    queryFn: () => getProgramSession(slug, sessionId as string),
    enabled: Boolean(slug && sessionId),
    retry: false,
  })

  const session = detail.data?.session
  const detailZone = detail.data?.event.timezone ?? zone
  const eventLocation = detail.data?.event.location ?? null

  return (
    <Dialog open={sessionId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="session-detail-dialog"
        data-branding-root
        style={programAccentStyle(accent ?? null, branding)}
      >
        {detail.isPending ? (
          <>
            <DialogHeader>
              <DialogTitle className="sr-only">Loading session</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          </>
        ) : detail.error || !session ? (
          <DialogHeader>
            <DialogTitle>Session unavailable</DialogTitle>
            <DialogDescription>
              {detail.error?.message ?? 'Try again in a moment.'}
            </DialogDescription>
          </DialogHeader>
        ) : (
          <SessionDetailBody
            session={session}
            zone={detailZone}
            location={eventLocation}
            starred={Boolean(sessionId && starred.has(sessionId))}
            onToggleStar={() => sessionId && onToggleStar(sessionId)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SessionDetailBody({
  session,
  zone,
  location,
  starred,
  onToggleStar,
}: {
  session: ProgramSessionDetail
  zone: string | null
  location: string | null
  starred: boolean
  onToggleStar: () => void
}) {
  const time = formatTimeRange(session.starts_at, session.ends_at, zone)
  const descriptionHtml = stripUnsafeHtml(session.description || '')

  const addToCalendar = () => {
    const ics = buildSessionIcs({
      id: session.id,
      friendly_id: session.friendly_id,
      title: session.title,
      description: htmlToText(session.description || ''),
      starts_at: session.starts_at,
      ends_at: session.ends_at,
      location: [session.room, location].filter(Boolean).join(', ') || null,
    })
    downloadIcs(ics, session.friendly_id || session.title || 'session')
  }

  return (
    <>
      <DialogHeader>
        {(session.track || session.format || session.room) && (
          <div className="flex flex-wrap items-center gap-2">
            {session.track && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: session.track.color ?? '#CFC9BE' }}
                />
                {session.track.name}
              </span>
            )}
            {session.format && <FormatTag format={session.format} />}
            {session.room && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                {session.room}
              </span>
            )}
          </div>
        )}
        <DialogTitle className="mt-1">{session.title}</DialogTitle>
        {time && <DialogDescription className="mt-1">{time}</DialogDescription>}
      </DialogHeader>

      <div className="flex flex-wrap gap-2">
        {session.starts_at && (
          <button
            type="button"
            onClick={addToCalendar}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <CalendarPlus className="h-4 w-4" />
            Add to calendar
          </button>
        )}
        <button
          type="button"
          data-testid="star-toggle-modal"
          aria-pressed={starred}
          onClick={onToggleStar}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
            starred
              ? 'border-warning/50 bg-warning/10 text-warning-strong hover:bg-warning/15'
              : 'border-border bg-card text-foreground hover:bg-muted'
          )}
        >
          <Star className={cn('h-4 w-4', starred && 'fill-current')} />
          {starred ? 'In my schedule' : 'Add to my schedule'}
        </button>
      </div>

      {descriptionHtml && (
        <div
          className="text-sm leading-relaxed text-muted-foreground [&_a]:text-primary [&_a]:underline [&_li]:ml-4 [&_li]:list-disc [&_p]:my-2"
          dangerouslySetInnerHTML={{ __html: descriptionHtml }}
        />
      )}

      {session.speakers.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {session.speakers.length === 1 ? 'Speaker' : 'Speakers'}
          </h4>
          <ul className="mt-2 space-y-4">
            {session.speakers.map((speaker) => (
              <li key={speaker.name} className="flex gap-3">
                <span className="h-11 w-11 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
                  <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground">{speaker.name}</div>
                  {(speaker.title || speaker.company) && (
                    <div className="text-xs text-muted-foreground">
                      {[speaker.title, speaker.company].filter(Boolean).join(', ')}
                    </div>
                  )}
                  {speaker.bio && (
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {speaker.bio}
                    </p>
                  )}
                  <div className="mt-1.5 flex gap-2">
                    {speaker.linkedin_url && (
                      <SocialLink href={speaker.linkedin_url} label={`${speaker.name} on LinkedIn`}>
                        <Linkedin className="h-3.5 w-3.5" />
                      </SocialLink>
                    )}
                    {speaker.twitter_url && (
                      <SocialLink href={speaker.twitter_url} label={`${speaker.name} on X / Twitter`}>
                        <Twitter className="h-3.5 w-3.5" />
                      </SocialLink>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function SocialLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </a>
  )
}

function TrackChip({
  label,
  color,
  active,
  onClick,
}: {
  label: string
  color: string | null
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-normal transition-colors',
        active
          ? 'bg-status-solid text-status-solid-foreground'
          : 'bg-foreground/[0.045] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground'
      )}
    >
      {color && <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />}
      {label}
    </button>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
      <CalendarX2 className="h-8 w-8 text-muted-foreground" />
      <h3 className="mt-3 text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
