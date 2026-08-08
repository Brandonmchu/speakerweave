import { useMemo, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Linkedin, Twitter, UsersRound } from 'lucide-react'

import {
  formatSessionMoment,
  getProgramSpeakers,
  type ProgramSpeaker,
} from '@/lib/programApi'
import { Skeleton } from '@/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { Avatar, ProgramShell, useEmbedHeight } from '@/pages/publicProgramShared'

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
  const [selected, setSelected] = useState<ProgramSpeaker | null>(null)

  useEmbedHeight(embed)

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
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {speakers.map((speaker) => (
          <SpeakerCard key={speaker.name} speaker={speaker} onClick={() => setSelected(speaker)} />
        ))}
      </div>
    )
  }

  const content = (
    <>
      {body}
      <SpeakerDialog speaker={selected} onClose={() => setSelected(null)} />
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

function SpeakerDialog({ speaker, onClose }: { speaker: ProgramSpeaker | null; onClose: () => void }) {
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
                  {speaker.sessions.map((session, i) => (
                    <li
                      key={`${session.title}-${i}`}
                      className="rounded-lg border border-border bg-muted/40 px-3 py-2"
                    >
                      <div className="text-sm font-medium text-foreground">{session.title}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {formatSessionMoment(session.starts_at)}
                        {session.room ? ` · ${session.room}` : ''}
                      </div>
                    </li>
                  ))}
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
