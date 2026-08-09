import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CalendarPlus, CalendarX2, Clock, Linkedin, MapPin, Search, Twitter } from 'lucide-react'

import {
  buildSessionIcs,
  downloadIcs,
  formatDayLabel,
  formatTimeRange,
  formatTimeZoneNote,
  getProgramSchedule,
  getProgramSession,
  type ProgramSession,
  type ProgramSessionDetail,
} from '@/lib/programApi'
import { stripUnsafeHtml } from '@/lib/sanitize'
import { cn } from '@/lib/utils'
import { Input } from '@/ui/input'
import { Skeleton } from '@/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { Avatar, ProgramShell, useEmbedHeight } from '@/pages/publicProgramShared'

const ALL_TRACKS = '__all__'

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function PublicSchedule() {
  const { slug = '' } = useParams()
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === '1'

  // No browser timezone is sent: the public page must render in the EVENT's
  // timezone (the zone the organizer published against), so a Tokyo visitor
  // sees the same day/time as the organizer — never their own browser clock.
  const query = useQuery({
    queryKey: ['program-schedule', slug],
    queryFn: () => getProgramSchedule(slug),
    enabled: Boolean(slug),
    retry: false,
  })

  const days = useMemo(() => query.data?.days ?? [], [query.data])
  // The zone every time/day on this page is formatted in: the event's own.
  const zone = query.data?.event.timezone ?? null

  const [activeDate, setActiveDate] = useState('')
  const [track, setTrack] = useState<string>(ALL_TRACKS)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (days.length && !days.some((d) => d.date === activeDate)) setActiveDate(days[0].date)
  }, [days, activeDate])

  // Re-measure the embed iframe whenever the visible content changes.
  useEmbedHeight(embed)

  const activeDay = days.find((d) => d.date === activeDate) ?? days[0]

  // Track chips are built from whatever tracks actually appear in the program.
  const tracks = useMemo(() => {
    const seen = new Map<string, string | null>()
    for (const day of days) {
      for (const session of day.sessions) {
        if (session.track?.name && !seen.has(session.track.name)) {
          seen.set(session.track.name, session.track.color)
        }
      }
    }
    return [...seen.entries()].map(([name, color]) => ({ name, color }))
  }, [days])

  const q = search.trim().toLowerCase()
  const searching = q.length > 0

  // The active day's sessions (track-filtered) — the default, non-search view.
  const dayResults = useMemo(
    () =>
      (activeDay?.sessions ?? []).filter(
        (s) => track === ALL_TRACKS || s.track?.name === track
      ),
    [activeDay, track]
  )

  // A keyword search spans EVERY day, not just the active tab, so a match on
  // another day still surfaces (EMB-02). Results are flat and carry their date.
  const searchResults = useMemo(() => {
    if (!searching) return []
    const out: { session: ProgramSession; date: string }[] = []
    for (const day of days) {
      for (const session of day.sessions) {
        if (track !== ALL_TRACKS && session.track?.name !== track) continue
        const haystack = [
          session.title,
          htmlToText(session.description),
          session.room ?? '',
          ...session.speakers.map((s) => s.name),
        ]
          .join(' ')
          .toLowerCase()
        if (haystack.includes(q)) out.push({ session, date: day.date })
      }
    }
    return out
  }, [days, track, q, searching])

  const referenceIso =
    query.data?.event.starts_at ?? days[0]?.sessions[0]?.starts_at ?? null
  const zoneNote = formatTimeZoneNote(zone, referenceIso)

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
      <div className="space-y-6">
        {days.length > 1 && (
          <Tabs value={activeDate} onValueChange={setActiveDate}>
            <TabsList variant="underline">
              {days.map((day) => (
                <TabsTrigger key={day.date} value={day.date}>
                  {formatDayLabel(day.date)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {tracks.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              <TrackChip
                label="All tracks"
                color={null}
                active={track === ALL_TRACKS}
                onClick={() => setTrack(ALL_TRACKS)}
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
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions or speakers"
              className="pl-9"
              aria-label="Search sessions"
            />
          </div>
        </div>

        {zoneNote && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {zoneNote}
          </p>
        )}

        {searching ? (
          searchResults.length === 0 ? (
            <EmptyState
              title="No sessions match"
              description="Try a different track or clear your search."
            />
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground" role="status">
                {searchResults.length} result{searchResults.length === 1 ? '' : 's'} across all days
              </p>
              <ol className="space-y-3">
                {searchResults.map(({ session, date }, i) => (
                  <li key={session.id || `${session.title}-${i}`}>
                    <SessionCard
                      session={session}
                      zone={zone}
                      date={date}
                      onOpen={() => session.id && setSelectedId(session.id)}
                    />
                  </li>
                ))}
              </ol>
            </div>
          )
        ) : dayResults.length === 0 ? (
          <EmptyState
            title="No sessions match"
            description="Try a different track or clear your search."
          />
        ) : (
          <ol className="space-y-3">
            {dayResults.map((session, i) => (
              <li key={session.id || `${session.title}-${i}`}>
                <SessionCard
                  session={session}
                  zone={zone}
                  onOpen={() => session.id && setSelectedId(session.id)}
                />
              </li>
            ))}
          </ol>
        )}

        <SessionDetailDialog
          slug={slug}
          sessionId={selectedId}
          zone={zone}
          onClose={() => setSelectedId(null)}
        />
      </div>
    )
  }

  if (embed) {
    return <div className="bg-transparent px-1 py-2">{body}</div>
  }

  return (
    <ProgramShell slug={slug} eventName={query.data?.event.name} active="schedule">
      {query.data?.event.location && (
        <p className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground">
          <MapPin className="h-4 w-4" />
          {query.data.event.location}
        </p>
      )}
      {body}
    </ProgramShell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function SessionCard({
  session,
  zone,
  date,
  onOpen,
}: {
  session: ProgramSession
  zone: string | null
  date?: string
  onOpen: () => void
}) {
  const time = formatTimeRange(session.starts_at, session.ends_at, zone)
  const summary = htmlToText(session.description)
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="cursor-pointer rounded-xl border border-border bg-card p-4 text-left shadow-soft transition-shadow hover:shadow-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-5">
        <div className="shrink-0 sm:w-32">
          {date && (
            <div className="text-xs font-medium text-primary">{formatDayLabel(date)}</div>
          )}
          <div className="text-sm font-semibold text-foreground">{time}</div>
          {session.room && <div className="mt-0.5 text-xs text-muted-foreground">{session.room}</div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {session.track && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: session.track.color ?? '#94a3b8' }}
                />
                {session.track.name}
              </span>
            )}
          </div>
          <h3 className="mt-1.5 text-base font-semibold tracking-tight text-foreground">
            {session.title}
          </h3>
          {summary && (
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {summary}
            </p>
          )}
          {session.speakers.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              {session.speakers.map((speaker) => (
                <div key={speaker.name} className="flex items-center gap-2">
                  <span className="h-7 w-7 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
                    <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
                  </span>
                  <span className="text-sm">
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

/** The session-detail modal (EMB-08): full description, speakers with bio,
 * and an add-to-calendar download. Fetches on open so the card list stays lean. */
function SessionDetailDialog({
  slug,
  sessionId,
  zone,
  onClose,
}: {
  slug: string
  sessionId: string | null
  zone: string | null
  onClose: () => void
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
      <DialogContent className="sm:max-w-2xl">
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
          <SessionDetailBody session={session} zone={detailZone} location={eventLocation} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SessionDetailBody({
  session,
  zone,
  location,
}: {
  session: ProgramSessionDetail
  zone: string | null
  location: string | null
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
        {(session.track || session.room) && (
          <div className="flex flex-wrap items-center gap-2">
            {session.track && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: session.track.color ?? '#94a3b8' }}
                />
                {session.track.name}
              </span>
            )}
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

      {session.starts_at && (
        <div>
          <button
            type="button"
            onClick={addToCalendar}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <CalendarPlus className="h-4 w-4" />
            Add to calendar
          </button>
        </div>
      )}

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
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-card text-muted-foreground hover:text-foreground'
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
