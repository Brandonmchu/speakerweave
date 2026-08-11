import { useMemo, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, LayoutGrid, Linkedin, Rows3, Search, Twitter, UsersRound } from 'lucide-react'

import {
  dedupeProgramSpeakers,
  formatSessionMoment,
  getProgramSpeakers,
  speakerKey,
  type ProgramSpeaker,
} from '@/lib/programApi'
import { cn } from '@/lib/utils'
import { avatarGradient } from '@/ui/avatar'
import { Input } from '@/ui/input'
import { Skeleton } from '@/ui/skeleton'
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
import { SessionDetailDialog, useMySchedule } from '@/pages/PublicSchedule'

/** Gallery = photo grid (EMB-12); List = compact directory rows (EMB-04). */
type SpeakerView = 'gallery' | 'list'

export function PublicSpeakers() {
  const { slug = '' } = useParams()
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === '1'
  const compact = searchParams.get('compact') === '1'
  const accent = searchParams.get('accent')
  const requestedTrack = searchParams.get('track')?.trim() ?? ''

  const query = useQuery({
    queryKey: ['program-speakers', slug],
    queryFn: () => getProgramSpeakers(slug),
    enabled: Boolean(slug),
    retry: false,
  })

  // De-duplicated ONCE, here: every consumer below — the search filter, the
  // result count, the rendered cards — reads this same array, so the number on
  // screen is always literally the number of cards beneath it.
  const speakers = useMemo(
    () => dedupeProgramSpeakers(query.data?.speakers ?? []),
    [query.data]
  )
  const zone = query.data?.event.timezone ?? null
  const [selected, setSelected] = useState<ProgramSpeaker | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [track, setTrack] = useState(requestedTrack)
  // ?view=list deep-links the directory rendering (the embeddable "list of
  // speakers"); the photo grid is the default.
  const [view, setView] = useState<SpeakerView>(
    searchParams.get('view') === 'list' || compact ? 'list' : 'gallery'
  )

  // The personal schedule is shared with the schedule page (same localStorage),
  // so a session starred from a speaker's dialog also lights up on the agenda.
  const { starred, toggle } = useMySchedule(slug)

  const trackNames = useMemo(
    () => [...new Set(speakers.flatMap((speaker) => speaker.sessions.map((session) => session.track?.name).filter(Boolean) as string[]))].sort(),
    [speakers]
  )

  // Client-side keyword filter over name, company and title (EMB-05/12).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const inTrack = track
      ? speakers.filter((speaker) =>
          speaker.sessions.some((session) => session.track?.name === track)
        )
      : speakers
    if (!q) return inTrack
    return inTrack.filter((s) =>
      [s.name, s.company ?? '', s.title ?? ''].join(' ').toLowerCase().includes(q)
    )
  }, [speakers, search, track])

  const resultLabel = search.trim()
    ? filtered.length === 1
      ? '1 speaker matches'
      : `${filtered.length} speakers match`
    : `${filtered.length} speaker${filtered.length === 1 ? '' : 's'} across ${filtered.reduce((sum, speaker) => sum + speaker.sessions.length, 0)} sessions`

  useEmbedHeight(embed)

  // Clicking a speaker's session hands off to the shared detail modal: close the
  // speaker dialog first so the two Radix dialogs never stack.
  const openSession = (sessionId: string) => {
    setSelected(null)
    setSelectedSessionId(sessionId)
  }

  let body: ReactNode
  if (query.isPending) {
    body = (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-52 w-full rounded-xl" />
        ))}
      </div>
    )
  } else if (query.error || !query.data) {
    body = (
      <EmptyState
        title="These speakers aren't available"
        description={query.error?.message ?? 'Double-check the link.'}
      />
    )
  } else if (speakers.length === 0) {
    body = (
      <EmptyState
        title="Speakers coming soon"
        description="The speaker lineup will appear here once it's announced."
      />
    )
  } else {
    body = (
      <div className={compact ? 'space-y-3' : 'space-y-5'}>
        {embed && (
          <p
            role="status"
            data-testid="speaker-result-count"
            className="font-mono text-[11px] text-muted-foreground"
          >
            {resultLabel}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <SpeakerTrackChip label="All" active={!track} onClick={() => setTrack('')} />
            {trackNames.map((name) => (
              <SpeakerTrackChip key={name} label={name} active={track === name} onClick={() => setTrack(name)} />
            ))}
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="relative w-full sm:w-[220px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search speakers by name or company"
                className="pl-9"
                aria-label="Search speakers"
              />
            </div>
          </div>
          <ViewToggle view={view} onChange={setView} />
          </div>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            title="No speakers match"
            description="Try a different name, company, or title."
          />
        ) : view === 'gallery' ? (
          <div
            data-testid="speaker-gallery-grid"
            className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
          >
            {filtered.map((speaker) => (
              <SpeakerCard
                key={speakerKey(speaker)}
                speaker={speaker}
                onClick={() => setSelected(speaker)}
              />
            ))}
          </div>
        ) : (
          <ul data-testid="speaker-directory-list" className={compact ? 'space-y-1' : 'space-y-2'}>
            {filtered.map((speaker) => (
              <li key={speakerKey(speaker)}>
                <SpeakerRow
                  speaker={speaker}
                  zone={zone}
                  compact={compact}
                  onClick={() => setSelected(speaker)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const content = (
    <>
      {body}
      <SpeakerDialog
        speaker={selected}
        zone={zone}
        onOpenSession={openSession}
        onClose={() => setSelected(null)}
      />
      <SessionDetailDialog
        slug={slug}
        sessionId={selectedSessionId}
        zone={zone}
        starred={starred}
        onToggleStar={toggle}
        onClose={() => setSelectedSessionId(null)}
      />
    </>
  )

  if (embed) {
    return (
      <div
        data-testid="public-program-page"
        data-compact={compact ? 'true' : undefined}
        className={compact ? 'px-1 py-1' : 'px-1 py-2'}
        style={programAccentStyle(accent)}
      >
        {content}
      </div>
    )
  }

  return (
    <ProgramShell
      slug={slug}
      eventName={query.data?.event.name}
      active="speakers"
      accent={accent}
      compact={compact}
    >
      {!compact && query.data && (
        <header className="mb-7">
          <h1 className="font-serif text-[40px] font-normal leading-[1.08] tracking-[-0.03em] text-foreground">Speakers</h1>
          <p
            role="status"
            data-testid="speaker-result-count"
            className="mt-3 text-[13px] text-muted-foreground"
          >
            {resultLabel}
          </p>
        </header>
      )}
      {content}
    </ProgramShell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

/** Photo grid ⇄ directory rows. Two genuinely different renderings of the same
 *  de-duplicated list, so the count never depends on which one is showing. */
function ViewToggle({
  view,
  onChange,
}: {
  view: SpeakerView
  onChange: (view: SpeakerView) => void
}) {
  const options: { value: SpeakerView; label: string; icon: ReactNode }[] = [
    { value: 'gallery', label: 'Gallery', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
    { value: 'list', label: 'List', icon: <Rows3 className="h-3.5 w-3.5" /> },
  ]
  return (
    <div
      role="group"
      aria-label="Speaker layout"
      className="inline-flex shrink-0 rounded-lg bg-foreground/[0.045] p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          data-testid={`speaker-view-${option.value}`}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            view === option.value
              ? 'bg-card text-foreground shadow-soft'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** One directory row: headshot, name, job title, company, and their sessions. */
function SpeakerRow({
  speaker,
  zone,
  compact = false,
  onClick,
}: {
  speaker: ProgramSpeaker
  zone: string | null
  compact?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid="speaker-card"
      onClick={onClick}
      className={cn(
        'flex w-full items-start border-b border-border bg-card text-left transition-colors hover:bg-foreground/[0.028] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'gap-3 px-3 py-2.5' : 'gap-4 px-4 py-3.5'
      )}
    >
      <span className="h-14 w-14 shrink-0 overflow-hidden rounded-full">
        <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold tracking-tight text-foreground">
          {speaker.name}
        </span>
        <span className="block text-xs text-muted-foreground">
          {[speaker.title, speaker.company].filter(Boolean).join(' · ') || 'Speaker'}
        </span>
        {speaker.sessions.length > 0 && (
          <span className="mt-1.5 block text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              Sessions ({speaker.sessions.length})
            </span>
            {speaker.sessions.map((session, i) => (
              <span key={session.id ?? `${session.title}-${i}`} className="mt-0.5 block">
                {session.title}
                {' — '}
                {formatSessionMoment(session.starts_at, zone)}
                {session.room ? ` · ${session.room}` : ''}
              </span>
            ))}
          </span>
        )}
      </span>
      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function SpeakerCard({ speaker, onClick }: { speaker: ProgramSpeaker; onClick: () => void }) {
  const [start, end] = avatarGradient(speaker.id || speakerKey(speaker))
  return (
    <button
      type="button"
      data-testid="speaker-card"
      onClick={onClick}
      className="group flex flex-col text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div
        className="relative aspect-square w-full overflow-hidden rounded-[14px] bg-muted"
        style={!speaker.photo_url ? { backgroundImage: `linear-gradient(145deg, ${start}, ${end})` } : undefined}
      >
        {speaker.photo_url ? (
          <img
            src={speaker.photo_url}
            alt={speaker.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="absolute bottom-3 left-3 font-mono text-[9px] text-white/90">headshot</span>
        )}
      </div>
      <div className="flex flex-1 flex-col pt-3">
        <h3 className="text-[15px] font-medium tracking-[-0.01em] text-foreground">{speaker.name}</h3>
        {(speaker.title || speaker.company) && (
          <p className="mt-0.5 text-[12.5px] leading-4 text-muted-foreground">
            {[speaker.title, speaker.company].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
    </button>
  )
}

function SpeakerTrackChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-xs transition-colors',
        active ? 'bg-foreground text-white' : 'bg-foreground/[0.045] text-muted-foreground hover:bg-foreground/[0.07]'
      )}
    >
      {label}
    </button>
  )
}

function SpeakerDialog({
  speaker,
  zone,
  onOpenSession,
  onClose,
}: {
  speaker: ProgramSpeaker | null
  zone: string | null
  onOpenSession: (sessionId: string) => void
  onClose: () => void
}) {
  return (
    <Dialog open={speaker !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {speaker && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-4">
                <span className="h-16 w-16 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
                  <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
                </span>
                <div className="min-w-0">
                  <DialogTitle>{speaker.name}</DialogTitle>
                  <DialogDescription className="mt-0.5">
                    {[speaker.title, speaker.company].filter(Boolean).join(' · ') || 'Speaker'}
                  </DialogDescription>
                  <div className="mt-2 flex gap-2">
                    {speaker.linkedin_url && (
                      <SocialLink href={speaker.linkedin_url} label="LinkedIn">
                        <Linkedin className="h-4 w-4" />
                      </SocialLink>
                    )}
                    {speaker.twitter_url && (
                      <SocialLink href={speaker.twitter_url} label="X / Twitter">
                        <Twitter className="h-4 w-4" />
                      </SocialLink>
                    )}
                  </div>
                </div>
              </div>
            </DialogHeader>

            {speaker.bio && <ExpandableBio bio={speaker.bio} />}

            {speaker.sessions.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Sessions ({speaker.sessions.length})
                </h4>
                <ul className="mt-2 space-y-2">
                  {speaker.sessions.map((session, i) => {
                    const meta = (
                      <>
                        <div className="text-sm font-medium text-foreground">{session.title}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {formatSessionMoment(session.starts_at, zone)}
                          {session.room ? ` · ${session.room}` : ''}
                          {session.format ? ` · ${session.format}` : ''}
                        </div>
                      </>
                    )
                    // Only accepted+scheduled sessions carry an id → an openable
                    // detail modal. Unscheduled ones stay static.
                    return session.id ? (
                      <li key={session.id}>
                        <button
                          type="button"
                          data-testid="speaker-session"
                          onClick={() => onOpenSession(session.id as string)}
                          className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted"
                        >
                          <span className="min-w-0 flex-1">{meta}</span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </button>
                      </li>
                    ) : (
                      <li
                        key={`${session.title}-${i}`}
                        className="rounded-lg border border-border bg-muted/40 px-3 py-2"
                      >
                        {meta}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** How much bio fits before a reader wants the choice to see the rest. */
const BIO_CLAMP = 280

/** A speaker bio that clamps long text and expands IN PLACE (EMB-12/13). */
function ExpandableBio({ bio }: { bio: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = bio.length > BIO_CLAMP
  return (
    <div>
      <p
        data-testid="speaker-bio"
        className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground"
      >
        {long && !expanded ? `${bio.slice(0, BIO_CLAMP).trimEnd()}…` : bio}
      </p>
      {long && (
        <button
          type="button"
          data-testid="speaker-bio-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs font-medium text-primary hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function SocialLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </a>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
      <UsersRound className="h-8 w-8 text-muted-foreground" />
      <h3 className="mt-3 text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
