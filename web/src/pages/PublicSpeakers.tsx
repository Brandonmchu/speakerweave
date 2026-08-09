import { useMemo, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Linkedin, Search, Twitter, UsersRound } from 'lucide-react'

import {
  formatSessionMoment,
  getProgramSpeakers,
  type ProgramSpeaker,
} from '@/lib/programApi'
import { Input } from '@/ui/input'
import { Skeleton } from '@/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { Avatar, ProgramShell, useEmbedHeight } from '@/pages/publicProgramShared'
import { SessionDetailDialog, useMySchedule } from '@/pages/PublicSchedule'

export function PublicSpeakers() {
  const { slug = '' } = useParams()
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === '1'

  const query = useQuery({
    queryKey: ['program-speakers', slug],
    queryFn: () => getProgramSpeakers(slug),
    enabled: Boolean(slug),
    retry: false,
  })

  const speakers = useMemo(() => query.data?.speakers ?? [], [query.data])
  const zone = query.data?.event.timezone ?? null
  const [selected, setSelected] = useState<ProgramSpeaker | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // The personal schedule is shared with the schedule page (same localStorage),
  // so a session starred from a speaker's dialog also lights up on the agenda.
  const { starred, toggle } = useMySchedule(slug)

  // Client-side keyword filter over name, company and title (EMB-05/12).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return speakers
    return speakers.filter((s) =>
      [s.name, s.company ?? '', s.title ?? ''].join(' ').toLowerCase().includes(q)
    )
  }, [speakers, search])

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
      <div className="space-y-5">
        <div className="w-full sm:max-w-xs">
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
          {search.trim() && (
            <p
              role="status"
              data-testid="speaker-result-count"
              className="mt-1.5 text-xs font-medium text-muted-foreground"
            >
              {filtered.length === 1 ? '1 speaker matches' : `${filtered.length} speakers match`}
            </p>
          )}
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            title="No speakers match"
            description="Try a different name, company, or title."
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((speaker) => (
              <SpeakerCard key={speaker.name} speaker={speaker} onClick={() => setSelected(speaker)} />
            ))}
          </div>
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
    return <div className="px-1 py-2">{content}</div>
  }

  return (
    <ProgramShell slug={slug} eventName={query.data?.event.name} active="speakers">
      {content}
    </ProgramShell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function SpeakerCard({ speaker, onClick }: { speaker: ProgramSpeaker; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left shadow-soft transition-shadow hover:shadow-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="aspect-square w-full overflow-hidden bg-muted">
        <Avatar name={speaker.name} photoUrl={speaker.photo_url} className="transition-transform duration-200 group-hover:scale-[1.03]" />
      </div>
      <div className="flex flex-1 flex-col px-3.5 py-3">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{speaker.name}</h3>
        {speaker.title && <p className="mt-0.5 text-xs text-muted-foreground">{speaker.title}</p>}
        {speaker.company && (
          <p className="text-xs font-medium text-primary">{speaker.company}</p>
        )}
      </div>
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

            {speaker.bio && (
              <p className="text-sm leading-relaxed text-muted-foreground">{speaker.bio}</p>
            )}

            {speaker.sessions.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Sessions
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
