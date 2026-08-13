import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  CalendarDays,
  ClipboardList,
  Contact,
  FileArchive,
  FileText,
  Search,
  Users,
  type LucideIcon,
} from 'lucide-react'

import { searchAgentContext } from '@/agent/lib/agentApi'
import type { AgentEntityType, ContextItem } from '@/agent/types'
import { cn } from '@/lib/utils'

interface Category {
  type: AgentEntityType
  label: string
  description: string
  icon: LucideIcon
}

const CATEGORIES: Category[] = [
  { type: 'event', label: 'Events', description: 'Program settings', icon: CalendarDays },
  { type: 'submission', label: 'Submissions', description: 'CFP proposals', icon: ClipboardList },
  { type: 'speaker', label: 'Speakers', description: 'Event presenters', icon: Users },
  { type: 'session', label: 'Sessions', description: 'Scheduled program items', icon: CalendarDays },
  { type: 'form', label: 'Forms', description: 'Submission forms', icon: FileText },
  { type: 'content', label: 'Content', description: 'Collected assets', icon: FileArchive },
  { type: 'contact', label: 'Contacts', description: 'People in the CRM', icon: Contact },
]

const queryCache = new Map<string, ContextItem[]>()

// The unscoped list fans out across every category, so it waits for a real
// query. One picked category is a single indexed lookup — it browses instead.
const MIN_UNSCOPED_QUERY = 2

export function entityIcon(type: string): LucideIcon {
  return CATEGORIES.find((category) => category.type === type)?.icon ?? FileText
}

export function ContextDropdown({
  open,
  query,
  onQueryChange,
  onClose,
  onSelect,
  editorRef,
}: {
  open: boolean
  query: string
  onQueryChange: (query: string) => void
  onClose: () => void
  onSelect: (item: ContextItem) => void
  editorRef: RefObject<HTMLDivElement | null>
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [selectedType, setSelectedType] = useState<AgentEntityType | null>(null)
  const [results, setResults] = useState<ContextItem[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const trimmedQuery = query.trim()
  const scoped = selectedType !== null
  const browsing = scoped && trimmedQuery.length === 0
  const canSearch = scoped || trimmedQuery.length >= MIN_UNSCOPED_QUERY

  useEffect(() => {
    if (!open) {
      setSelectedType(null)
      setResults([])
      setActiveIndex(0)
      // Rows cached here would otherwise outlive an org switch or a sign-out.
      queryCache.clear()
      return
    }
    if (!canSearch) {
      setResults([])
      setLoading(false)
      setActiveIndex(0)
      return
    }
    const key = `${selectedType ?? '*'}:${trimmedQuery.toLowerCase()}`
    const cached = queryCache.get(key)
    if (cached) {
      setResults(cached)
      setLoading(false)
      setActiveIndex(0)
      return
    }
    const controller = new AbortController()
    // The skeleton hides them, but Enter would still pick a row from the
    // category the organizer just left.
    setResults([])
    setActiveIndex(0)
    setLoading(true)
    const timer = window.setTimeout(
      () => {
        searchAgentContext(trimmedQuery, selectedType, controller.signal)
          .then((items) => {
            queryCache.set(key, items)
            setResults(items)
            setActiveIndex(0)
          })
          .catch(() => {
            // An aborted request is a superseded keystroke, not an empty
            // result — `request()` reports it as an ApiError, so ask the
            // signal rather than the error.
            if (!controller.signal.aborted) setResults([])
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false)
          })
      },
      // Drilling into a category is one click, not a burst of keystrokes.
      trimmedQuery ? 200 : 0,
    )
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [canSearch, open, selectedType, trimmedQuery])

  const visibleItems = useMemo(
    () => (!scoped && trimmedQuery.length === 0 ? CATEGORIES : results),
    [results, scoped, trimmedQuery.length],
  )

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'ArrowDown') {
        setActiveIndex((index) => Math.min(index + 1, Math.max(0, visibleItems.length - 1)))
      } else if (event.key === 'ArrowUp') {
        setActiveIndex((index) => Math.max(0, index - 1))
      } else {
        const selected = visibleItems[activeIndex]
        if (!selected) return
        if ('description' in selected) {
          setSelectedType(selected.type)
          setActiveIndex(0)
        } else {
          onSelect(selected)
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [activeIndex, onClose, onSelect, open, visibleItems])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || editorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [editorRef, onClose, open])

  if (!open) return null
  const selectedLabel = CATEGORIES.find((category) => category.type === selectedType)?.label
  const scopeName = selectedLabel?.toLowerCase() ?? 'context'
  const emptyMessage = !scoped
    ? 'No matching context.'
    : browsing
      ? `No ${scopeName} yet.`
      : `No ${scopeName} match “${trimmedQuery}”.`

  return (
    <div
      ref={rootRef}
      role="listbox"
      aria-label="Add context"
      className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-64 overflow-hidden rounded-xl bg-popover shadow-lifted animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {selectedType && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary-subtle"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setSelectedType(null)}
          >
            All
          </button>
        )}
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={selectedLabel ? `Search ${selectedLabel.toLowerCase()}…` : 'Search program context…'}
          className="h-7 min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
        />
      </div>
      <div className="scrollbar-app max-h-[212px] overflow-y-auto p-1.5">
        {!scoped && trimmedQuery.length === 0 ? (
          CATEGORIES.map((category, index) => {
            const Icon = category.icon
            return (
              <button
                key={category.type}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSelectedType(category.type)
                  setActiveIndex(0)
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                  index === activeIndex && 'bg-hover',
                )}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{category.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{category.description}</span>
                </span>
              </button>
            )
          })
        ) : !canSearch ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Type at least {MIN_UNSCOPED_QUERY} characters.
          </p>
        ) : loading ? (
          <div className="space-y-2 px-2 py-2" aria-label="Searching context">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-2.5">
                <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                  <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : results.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">{emptyMessage}</p>
        ) : (
          results.map((item, index) => {
            const Icon = entityIcon(item.type)
            return (
              <button
                key={`${item.type}:${item.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(item)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                  index === activeIndex && 'bg-hover',
                )}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-subtle text-primary">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{item.display}</span>
                  {item.sublabel && (
                    <span className="block truncate text-[11px] text-muted-foreground">{item.sublabel}</span>
                  )}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
