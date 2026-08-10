import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, Loader2 } from 'lucide-react'

import type { TraceEntry } from '@/agent/types'
import { cn } from '@/lib/utils'

const FALLBACK_STATUS = [
  'Checking the program details',
  'Connecting the pieces',
  'Working through the next step',
]

export function WorkTrace({
  entries,
  progress,
  live,
  done,
  lastSignalAt,
}: {
  entries: TraceEntry[]
  progress: string | null
  live: boolean
  done: boolean
  lastSignalAt: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [fallbackIndex, setFallbackIndex] = useState(0)
  useEffect(() => {
    if (!live) return
    const interval = window.setInterval(() => {
      if (Date.now() - lastSignalAt >= 30_000) {
        setFallbackIndex((index) => (index + 1) % FALLBACK_STATUS.length)
      }
    }, 30_000)
    return () => window.clearInterval(interval)
  }, [lastSignalAt, live])

  const latest = useMemo(
    () => progress?.replace(/\.{3}$/, '') || entries.at(-1)?.message || FALLBACK_STATUS[fallbackIndex],
    [entries, fallbackIndex, progress],
  )
  if (!live && (!done || entries.length === 0)) return null

  return (
    <div className="mx-1 mb-4 rounded-xl border border-border/80 bg-card/90 shadow-soft">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {live ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-xs', live ? 'text-foreground' : 'text-muted-foreground')}>
          {live ? latest : `Worked through ${entries.length} step${entries.length === 1 ? '' : 's'}`}
          {live && <span className="ml-1 inline-block animate-pulse text-primary">···</span>}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{entries.length || ''}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && entries.length > 0 && (
        <div className="scrollbar-app relative max-h-[320px] overflow-y-auto border-t border-border px-3 py-3">
          <div className="absolute bottom-4 left-[18px] top-4 w-px bg-border" />
          <ol className="space-y-3">
            {entries.map((entry, index) => (
              <li key={entry.id} className="relative flex gap-2.5 pl-0.5 text-xs leading-5 text-muted-foreground">
                <span
                  className={cn(
                    'relative z-[1] mt-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-card',
                    live && index === entries.length - 1 ? 'bg-primary' : 'bg-muted-foreground/45',
                  )}
                />
                <span>{entry.message}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

