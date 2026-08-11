import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, AtSign, ExternalLink } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { entityIcon } from '@/agent/components/ContextDropdown'
import { parseContextTokens, stripContextHeader } from '@/agent/components/contextBadge'
import { MarkdownMessage } from '@/agent/components/markdown/MarkdownMessage'
import { TurnActivityCard } from '@/agent/components/TurnActivityCard'
import { getEntityRoute } from '@/agent/lib/entityRoutes'
import type { AgentMessage, ContextItem } from '@/agent/types'
import { cn } from '@/lib/utils'

const EXAMPLES = [
  "What's still unstaffed on the agenda?",
  'Draft decision emails for pending submissions',
  "Which speakers haven't submitted headshots?",
]

function EntityBadge({ item }: { item: ContextItem }) {
  const navigate = useNavigate()
  const Icon = entityIcon(item.type)
  const route = getEntityRoute(item.type, item.id)
  return (
    <button
      type="button"
      disabled={!route}
      onClick={() => route && navigate(route)}
      title={route ? `Open ${item.display}` : item.display}
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md bg-foreground/[0.045] px-1.5 py-0.5 align-baseline text-[11px] font-medium leading-5 text-foreground transition-colors hover:bg-foreground/[0.07] disabled:cursor-default"
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{item.display}</span>
    </button>
  )
}

function UserText({ text }: { text: string }) {
  const pieces = text.split(/((?:https?:\/\/|www\.)[^\s<]+)/g)
  return (
    <span className="whitespace-pre-wrap break-words text-[13px] leading-5">
      {pieces.map((piece, index) =>
        /^(?:https?:\/\/|www\.)/.test(piece) ? (
          <a
            key={`${piece}-${index}`}
            href={piece.startsWith('www.') ? `https://${piece}` : piece}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline decoration-current/40 underline-offset-2"
          >
            {piece}
            <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
          </a>
        ) : (
          piece
        ),
      )}
    </span>
  )
}

function MessageBody({ message }: { message: AgentMessage }) {
  const user = message.sender_type === 'user'
  const stripped = user ? stripContextHeader(message.content) : { content: message.content, contexts: [] }
  const matches = parseContextTokens(stripped.content)
  const streaming = message.response_type === 'streaming'

  let cursor = 0
  const parts: ReactNode[] = []
  matches.forEach((match, index) => {
    const gap = stripped.content.slice(cursor, match.startIndex)
    if (gap) {
      parts.push(
        user ? (
          <UserText key={`text-${index}`} text={gap} />
        ) : (
          <MarkdownMessage key={`text-${index}`} content={gap} streaming={streaming} inline />
        ),
      )
    }
    parts.push(<EntityBadge key={`badge-${match.startIndex}`} item={match.item} />)
    cursor = match.endIndex
  })
  const tail = stripped.content.slice(cursor)
  if (tail) {
    parts.push(
      user ? (
        <UserText key="tail" text={tail} />
      ) : (
        <MarkdownMessage key="tail" content={tail} streaming={streaming} inline={matches.length > 0} />
      ),
    )
  }

  return (
    <>
      {user && stripped.contexts.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <AtSign className="h-3 w-3 text-muted-foreground" />
          {stripped.contexts.map((item) => (
            <EntityBadge key={`${item.type}:${item.id}`} item={item} />
          ))}
        </div>
      )}
      <div className={cn(!user && 'text-[13px] leading-5 text-foreground')}>{parts}</div>
    </>
  )
}

function HistorySkeleton() {
  return (
    <div className="space-y-5 px-1 pt-3" aria-label="Loading conversation">
      <div className="ml-auto h-14 w-2/3 animate-pulse rounded-xl bg-muted" />
      <div className="space-y-2">
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
      </div>
      <div className="ml-auto h-10 w-1/2 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

export function MessageList({
  messages,
  loading,
  onExample,
  footer,
}: {
  messages: AgentMessage[]
  loading: boolean
  onExample: (prompt: string) => void
  footer?: ReactNode
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const contentSignature = messages.map((message) => `${message.id}:${message.content.length}`).join('|')

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || paused) return
    scroller.scrollTop = scroller.scrollHeight
  }, [contentSignature, footer, paused])

  const jumpToLatest = () => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    setPaused(false)
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={scrollerRef}
        data-agent-messages
        aria-live="polite"
        onScroll={() => {
          const scroller = scrollerRef.current
          if (!scroller) return
          const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
          if (distance > 100) setPaused(true)
          else if (distance < 50) setPaused(false)
        }}
        className="scrollbar-app h-full overflow-y-auto px-5 pb-4 pt-5"
      >
        {loading ? (
          <HistorySkeleton />
        ) : messages.length === 0 ? (
          <div className="flex min-h-full flex-col py-2">
            <h2 className="text-[13px] font-medium text-foreground">Ask about your program</h2>
            <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
              Check live workspace data, prepare updates, and move through program work without leaving the page.
            </p>
            <p className="section-label mt-6">Try</p>
            <div className="mt-2 space-y-1.5">
              {EXAMPLES.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => onExample(prompt)}
                  className="group flex min-h-[36px] w-full items-center gap-2.5 rounded-lg bg-foreground/[0.028] px-3 py-2 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground active:translate-y-px"
                >
                  <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-warning transition-transform group-hover:scale-125" />
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages
              .filter((message) => message.sender_type !== 'system')
              .map((message) => {
                const user = message.sender_type === 'user'
                const activity = Array.isArray(message.metadata.activity) ? message.metadata.activity : []
                if (!user && !message.content && activity.length === 0) return null
                return (
                  <article
                    key={message.id}
                    data-agent-message={message.sender_type}
                    className={cn('flex', user ? 'justify-end' : 'justify-start')}
                  >
                    <div className={cn(user ? 'max-w-[88%]' : 'w-full')}>
                      {user ? (
                        <div className="rounded-xl bg-primary-subtle px-3.5 py-2.5 text-foreground">
                          <MessageBody message={message} />
                        </div>
                      ) : (
                        <div>
                          <div className="min-w-0">
                            <MessageBody message={message} />
                            {message.response_type === 'error' && (
                              <p className="mt-2 text-xs font-medium text-destructive">This turn did not finish.</p>
                            )}
                            <TurnActivityCard activity={activity} />
                          </div>
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            {footer}
          </div>
        )}
      </div>
      {paused && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 inline-flex h-[27px] -translate-x-1/2 items-center gap-1.5 rounded-lg bg-card px-3 text-xs font-medium text-foreground shadow-raised hover:bg-accent active:translate-y-px"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Jump to latest
        </button>
      )}
    </div>
  )
}
