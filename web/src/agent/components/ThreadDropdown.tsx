import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import {
  Check,
  ChevronDown,
  Ellipsis,
  Loader2,
  Pencil,
  Plug,
  Search,
  Trash2,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { useAgent } from '@/agent/AgentProvider'
import { agentKeys, connectEvery, disconnectEvery } from '@/agent/lib/agentApi'
import type { AgentCapabilities } from '@/agent/types'
import { cn } from '@/lib/utils'
import { Button } from '@/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { toast } from '@/ui/use-toast'

function relativeTime(value: string | null, fallback: string): string {
  try {
    return formatDistanceToNow(parseISO(value ?? fallback), { addSuffix: true })
  } catch {
    return 'Recently'
  }
}

export function ThreadDropdown() {
  const {
    capabilities,
    threads,
    threadsLoading,
    activeThreadId,
    selectThread,
    renameThread,
    deleteThread,
    respondingThreadIds,
  } = useAgent()
  const queryClient = useQueryClient()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [rowMenu, setRowMenu] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [everyBusy, setEveryBusy] = useState(false)

  const activeThread = threads.find((thread) => thread.id === activeThreadId)
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return threads
      .filter((thread) => !query || thread.name.toLowerCase().includes(query))
      .slice(0, 50)
  }, [search, threads])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setRowMenu(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        setRowMenu(null)
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'ArrowDown') setActiveIndex((index) => Math.min(filtered.length - 1, index + 1))
      else if (event.key === 'ArrowUp') setActiveIndex((index) => Math.max(0, index - 1))
      else if (filtered[activeIndex]) {
        selectThread(filtered[activeIndex].id)
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [activeIndex, filtered, open, selectThread])

  const updateCapability = (connected: boolean) => {
    queryClient.setQueryData<AgentCapabilities>(agentKeys.capabilities, (current) =>
      current ? { ...current, every_mcp: { ...current.every_mcp, connected } } : current,
    )
  }

  return (
    <>
      <div ref={rootRef} className="relative min-w-0 flex-1">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value)
            setSearch('')
            setActiveIndex(0)
          }}
          className="flex h-9 max-w-[240px] items-center gap-2 rounded-full border border-border bg-card px-3 text-left text-xs font-semibold text-foreground shadow-soft transition-colors hover:bg-accent active:scale-[0.98]"
        >
          {activeThreadId && respondingThreadIds.has(activeThreadId) ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          )}
          <span className="min-w-0 flex-1 truncate">{activeThread?.name || 'New chat'}</span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="absolute left-0 top-full z-30 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-lifted animate-in fade-in-0 zoom-in-95 slide-in-from-top-1">
            <div className="relative border-b border-border p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                autoFocus
                onChange={(event) => {
                  setSearch(event.target.value)
                  setActiveIndex(0)
                }}
                placeholder="Search chats…"
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-xs text-foreground outline-none focus:border-primary"
              />
            </div>
            <div className="scrollbar-app max-h-72 overflow-y-auto p-1.5" role="listbox" aria-label="Chats">
              {threadsLoading ? (
                <div className="space-y-2 p-2" aria-label="Loading chats">
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="space-y-1.5 rounded-lg px-2 py-2">
                      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                      <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
                    </div>
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <p className="px-3 py-7 text-center text-xs text-muted-foreground">No chats found.</p>
              ) : (
                filtered.map((thread, index) => (
                  <div
                    key={thread.id}
                    role="option"
                    aria-selected={thread.id === activeThreadId}
                    className={cn(
                      'group relative flex items-center rounded-lg pr-1',
                      (index === activeIndex || thread.id === activeThreadId) && 'bg-hover',
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        selectThread(thread.id)
                        setOpen(false)
                      }}
                      className="min-w-0 flex-1 px-2.5 py-2 text-left"
                    >
                      <span className="flex items-center gap-1.5">
                        {respondingThreadIds.has(thread.id) && (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                        )}
                        <span className="block min-w-0 flex-1 truncate text-xs font-medium text-foreground">{thread.name || 'Chat'}</span>
                        {thread.id === activeThreadId && <Check className="h-3 w-3 shrink-0 text-primary" />}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        {relativeTime(thread.last_message_at, thread.created_at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Actions for ${thread.name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setRowMenu((current) => (current === thread.id ? null : thread.id))
                      }}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-card hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                    >
                      <Ellipsis className="h-3.5 w-3.5" />
                    </button>
                    {rowMenu === thread.id && (
                      <div className="absolute right-1 top-9 z-40 w-32 rounded-lg border border-border bg-popover p-1 shadow-raised">
                        <button
                          type="button"
                          onClick={() => {
                            setRenameId(thread.id)
                            setRenameValue(thread.name)
                            setRowMenu(null)
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-accent"
                        >
                          <Pencil className="h-3.5 w-3.5" /> Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteId(thread.id)
                            setRowMenu(null)
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-destructive hover:bg-destructive/5"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            {capabilities.every_mcp.available && (
              <div className="border-t border-border p-1.5">
                <button
                  type="button"
                  disabled={everyBusy}
                  onClick={async () => {
                    setEveryBusy(true)
                    try {
                      if (capabilities.every_mcp.connected) {
                        await disconnectEvery()
                        updateCapability(false)
                        toast({ title: 'Every disconnected' })
                      } else {
                        const response = await connectEvery()
                        window.open(response.authorize_url, '_blank', 'noopener,noreferrer')
                      }
                    } catch (error) {
                      toast({ variant: 'destructive', title: "Couldn't update Every", description: error instanceof Error ? error.message : 'Try again.' })
                    } finally {
                      setEveryBusy(false)
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  {everyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                  <span className="flex-1">{capabilities.every_mcp.connected ? 'Every connected' : 'Connect Every'}</span>
                  {capabilities.every_mcp.connected && (
                    <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success-strong">Every ✓</span>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={Boolean(renameId)} onOpenChange={(next) => !next && setRenameId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>Use a short name that makes this conversation easy to find.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="agent-thread-name">Name</Label>
            <Input
              id="agent-thread-name"
              value={renameValue}
              maxLength={100}
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <p className="text-right text-[10px] tabular-nums text-muted-foreground">{renameValue.length}/100</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameId(null)} disabled={saving}>Cancel</Button>
            <Button
              disabled={!renameValue.trim() || saving}
              onClick={async () => {
                if (!renameId) return
                setSaving(true)
                try {
                  await renameThread(renameId, renameValue)
                  setRenameId(null)
                } catch (error) {
                  toast({ variant: 'destructive', title: "Couldn't rename chat", description: error instanceof Error ? error.message : 'Try again.' })
                } finally {
                  setSaving(false)
                }
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteId)} onOpenChange={(next) => !next && setDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this chat?</DialogTitle>
            <DialogDescription>The conversation and its messages will be permanently removed.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)} disabled={saving}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={async () => {
                if (!deleteId) return
                setSaving(true)
                try {
                  await deleteThread(deleteId)
                  setDeleteId(null)
                } catch (error) {
                  toast({ variant: 'destructive', title: "Couldn't delete chat", description: error instanceof Error ? error.message : 'Try again.' })
                } finally {
                  setSaving(false)
                }
              }}
            >
              {saving ? 'Deleting…' : 'Delete chat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

