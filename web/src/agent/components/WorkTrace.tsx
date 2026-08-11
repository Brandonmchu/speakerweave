import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'

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
    <div className="mx-1 mb-4">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-[27px] w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left font-mono text-[10.5px] text-placeholder hover:bg-foreground/[0.028]"
      >
        <span className={cn('h-[5px] w-[5px] shrink-0 rounded-full', live ? 'animate-pulse bg-warning' : 'bg-status-neutral')} />
        <span className={cn('min-w-0 flex-1 truncate', live ? 'text-muted-foreground' : 'text-placeholder')}>
          {live ? latest : `Worked through ${entries.length} step${entries.length === 1 ? '' : 's'}`}
        </span>
        <span className="tabular-nums">{entries.length || ''}</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && entries.length > 0 && (
        <div className="scrollbar-app max-h-[320px] overflow-y-auto rounded-lg bg-foreground/[0.028] px-3 py-2.5">
          <ol className="space-y-2">
            {entries.map((entry, index) => (
              <li key={entry.id} className="flex gap-2 font-mono text-[10.5px] leading-4 text-muted-foreground">
                <span
                  className={cn(
                    'mt-1.5 h-1 w-1 shrink-0 rounded-full',
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
