import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CalendarX2, MapPin, Search } from 'lucide-react'

import {
  formatDayLabel,
  formatTimeRange,
  getBrowserTimeZone,
  getProgramSchedule,
  type ProgramSession,
} from '@/lib/programApi'
import { cn } from '@/lib/utils'
import { Input } from '@/ui/input'
import { Skeleton } from '@/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
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

  const tz = useMemo(() => getBrowserTimeZone(), [])
  const query = useQuery({
    queryKey: ['program-schedule', slug, tz],
    queryFn: () => getProgramSchedule(slug, tz),
    enabled: Boolean(slug),
    retry: false,
  })

  const days = useMemo(() => query.data?.days ?? [], [query.data])
  const zone = query.data?.event.timezone ?? tz ?? null

  const [activeDate, setActiveDate] = useState('')
  const [track, setTrack] = useState<string>(ALL_TRACKS)
  const [search, setSearch] = useState('')

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

  const visibleSessions = useMemo(() => {
    const list = activeDay?.sessions ?? []
    const q = search.trim().toLowerCase()
    return list.filter((session) => {
      if (track !== ALL_TRACKS && session.track?.name !== track) return false
      if (!q) return true
      const haystack = [
        session.title,
        htmlToText(session.description),
        session.room ?? '',
        ...session.speakers.map((s) => s.name),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [activeDay, track, search])

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

        {visibleSessions.length === 0 ? (
          <EmptyState
            title="No sessions match"
            description="Try a different track or clear your search."
          />
        ) : (
          <ol className="space-y-3">
            {visibleSessions.map((session, i) => (
              <li key={session.friendly_id ?? `${session.title}-${i}`}>
                <SessionCard session={session} zone={zone} />
              </li>
            ))}
          </ol>
        )}
      </div>
    )
  }

  if (embed) {
    return (
      <div className="bg-transparent px-1 py-2">
        {body}
      </div>
    )
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

function SessionCard({ session, zone }: { session: ProgramSession; zone: string | null }) {
  const time = formatTimeRange(session.starts_at, session.ends_at, zone)
  const summary = htmlToText(session.description)
  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-soft transition-shadow hover:shadow-raised sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-5">
        <div className="shrink-0 sm:w-32">
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
