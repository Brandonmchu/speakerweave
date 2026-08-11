import {
  Component,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, RotateCcw, Sparkles, SquarePen, X } from 'lucide-react'

import { AgentProvider, useAgent } from '@/agent/AgentProvider'
import { ChatBox } from '@/agent/ChatBox'
import { ConnectorStatus } from '@/agent/components/ConnectorStatus'
import { ThreadDropdown } from '@/agent/components/ThreadDropdown'
import type { AgentCapabilities } from '@/agent/types'
import { cn } from '@/lib/utils'

class AgentPanelBoundary extends Component<
  { open: boolean; onClose: () => void; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Chat panel crashed', error, info)
  }

  componentDidUpdate(previous: { open: boolean }) {
    if (!previous.open && this.props.open && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    if (!this.props.open) return null
    return (
      <aside className="fixed bottom-0 right-0 top-0 z-40 flex w-full flex-col border-l border-border bg-card sm:w-[var(--chat-sheet-width)]">
        <div className="flex h-14 items-center justify-end border-b border-border px-4">
          <button type="button" onClick={this.props.onClose} aria-label="Close chat" className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
            <MessageSquare className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">Chat needs a reset</h2>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">The rest of SpeakerWeave is still working. Reopen chat to try again.</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-5 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary-strong"
          >
            <RotateCcw className="h-4 w-4" /> Try again
          </button>
        </div>
      </aside>
    )
  }
}

function AgentToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid="ask-agent"
      data-chat-toggle="true"
      title="Ask SpeakerWeave (⌘J)"
      aria-label="Ask SpeakerWeave"
      aria-pressed={open}
      onClick={onToggle}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm font-semibold transition-[background-color,border-color,transform] active:scale-[0.98] sm:px-3',
        open
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-primary/25 bg-primary-subtle text-primary hover:border-primary/40 hover:bg-primary/10',
      )}
    >
      <Sparkles className="h-4 w-4" />
      <span className="hidden sm:inline">Ask</span>
    </button>
  )
}

function AgentPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { newChat, isStreaming } = useAgent()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const composer = document.querySelector<HTMLElement>('[data-agent-composer]')
      if (composer?.textContent?.trim() || composer?.querySelector('.context-badge')) return
      onOpenChange(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onOpenChange, open])

  return (
    <aside
      aria-label="Ask SpeakerWeave"
      aria-hidden={!open}
      className={cn(
        'fixed bottom-0 right-0 top-0 z-40 flex w-full flex-col border-l border-border bg-card shadow-lifted transition-[transform,opacity] duration-300 ease-in-out sm:w-[var(--chat-sheet-width)]',
        !open && 'pointer-events-none translate-x-full opacity-0',
      )}
      onWheel={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
    >
      <header className="pointer-events-none absolute left-0 right-0 top-0 z-20 bg-gradient-to-b from-card via-card/95 to-transparent px-4 pb-4 pt-3">
        <div className="flex h-10 items-center gap-2 [&>*]:pointer-events-auto">
          <ThreadDropdown />
          <ConnectorStatus />
          <button
            type="button"
            title="New chat"
            aria-label="New chat"
            disabled={isStreaming}
            onClick={newChat}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-soft transition-colors hover:bg-accent hover:text-foreground active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <SquarePen className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Close chat"
            aria-label="Close chat"
            onClick={() => onOpenChange(false)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-[0.97]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      <ChatBox onRequestClose={() => onOpenChange(false)} />
    </aside>
  )
}

export function AgentFeature({
  capabilities,
  open,
  onOpenChange,
  toggleContainerId,
}: {
  capabilities: AgentCapabilities
  open: boolean
  onOpenChange: (open: boolean) => void
  toggleContainerId: string
}) {
  const [toggleContainer, setToggleContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    document.documentElement.style.setProperty('--chat-sheet-width', 'clamp(420px, 29vw, 500px)')
    setToggleContainer(document.getElementById(toggleContainerId))
    return () => {
      document.documentElement.style.removeProperty('--chat-sheet-width')
    }
  }, [toggleContainerId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'j') return
      event.preventDefault()
      onOpenChange(!open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onOpenChange, open])

  return (
    <>
      {toggleContainer && createPortal(<AgentToggle open={open} onToggle={() => onOpenChange(!open)} />, toggleContainer)}
      <AgentPanelBoundary open={open} onClose={() => onOpenChange(false)}>
        <AgentProvider capabilities={capabilities} panelOpen={open}>
          <AgentPanel open={open} onOpenChange={onOpenChange} />
        </AgentProvider>
      </AgentPanelBoundary>
    </>
  )
}
