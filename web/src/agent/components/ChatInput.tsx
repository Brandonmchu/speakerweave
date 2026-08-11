import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { AtSign, Send, Square, X } from 'lucide-react'

import { ContextDropdown, entityIcon } from '@/agent/components/ContextDropdown'
import {
  contextItemsFromEditor,
  insertContextBadge,
  serializeComposerMessage,
} from '@/agent/components/contextBadge'
import type { ContextItem } from '@/agent/types'
import { cn } from '@/lib/utils'

function editorIsEmpty(editor: HTMLElement): boolean {
  return !editor.textContent?.trim() && !editor.querySelector('.context-badge')
}

function adjacentBadge(
  editor: HTMLElement,
  selection: Selection,
  direction: 'before' | 'after',
): HTMLElement | null {
  const anchor = selection.anchorNode
  if (!anchor) return null
  let candidate: Node | null = null
  if (anchor === editor) {
    const offset = selection.anchorOffset + (direction === 'after' ? 0 : -1)
    candidate = editor.childNodes[offset] ?? null
  } else if (anchor.nodeType === Node.TEXT_NODE) {
    const length = anchor.textContent?.length ?? 0
    if (direction === 'before' && selection.anchorOffset === 0) candidate = anchor.previousSibling
    if (direction === 'after' && selection.anchorOffset === length) candidate = anchor.nextSibling
  }
  return candidate instanceof HTMLElement && candidate.classList.contains('context-badge')
    ? candidate
    : null
}

export function ChatInput({
  onSend,
  onCancel,
  onRequestClose,
  streaming,
}: {
  onSend: (message: string) => void
  onCancel: () => void
  onRequestClose: () => void
  streaming: boolean
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [contexts, setContexts] = useState<ContextItem[]>([])
  const [canSend, setCanSend] = useState(false)
  const [atMode, setAtMode] = useState(false)
  const [contextQuery, setContextQuery] = useState('')
  const [contextStart, setContextStart] = useState<number | null>(null)

  const resize = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.style.height = '36px'
    editor.style.height = `${Math.max(36, Math.min(128, editor.scrollHeight))}px`
  }, [])

  const sync = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    setContexts(contextItemsFromEditor(editor))
    setCanSend(!editorIsEmpty(editor))
    requestAnimationFrame(resize)
  }, [resize])

  useEffect(() => resize(), [resize])

  const closeAtMode = useCallback(() => {
    setAtMode(false)
    setContextQuery('')
    setContextStart(null)
  }, [])

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount) return
    sync()
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.endContainer)) return
    const before = range.cloneRange()
    before.selectNodeContents(editor)
    before.setEnd(range.endContainer, range.endOffset)
    const textBeforeCursor = before.toString()

    if (atMode && contextStart !== null) {
      const nextQuery = textBeforeCursor.slice(contextStart + 1)
      setContextQuery(nextQuery)
      return
    }

    const lastAtIndex = textBeforeCursor.lastIndexOf('@')
    if (lastAtIndex < 0) return
    const charBefore = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' '
    const charAfter = textBeforeCursor.substring(lastAtIndex + 1)[0] || ''
    const isPaste = (event.nativeEvent as InputEvent).inputType === 'insertFromPaste'
    if (
      !isPaste &&
      (lastAtIndex === 0 || /\s/.test(charBefore)) &&
      (charAfter === '' || /\s/.test(charAfter))
    ) {
      setContextQuery('')
      setContextStart(lastAtIndex)
      setAtMode(true)
    }
  }

  const selectContext = useCallback(
    (item: ContextItem) => {
      const editor = editorRef.current
      if (!editor || contextStart === null) return
      const duplicate = contexts.some(
        (context) => context.type === item.type && context.id === item.id,
      )
      if (!duplicate) insertContextBadge(editor, contextStart, contextQuery.length, item)
      closeAtMode()
      window.setTimeout(sync, 0)
    },
    [closeAtMode, contextQuery.length, contextStart, contexts, sync],
  )

  const fadeAndRemove = useCallback(
    (badge: HTMLElement) => {
      badge.style.opacity = '0'
      badge.style.transform = 'scale(0.9)'
      window.setTimeout(() => {
        badge.remove()
        sync()
      }, 150)
    },
    [sync],
  )

  const submit = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editorIsEmpty(editor)) return
    const message = serializeComposerMessage(editor, contexts)
    if (!message.trim()) return
    onSend(message)
    editor.replaceChildren()
    editor.style.height = '36px'
    setContexts([])
    setCanSend(false)
    closeAtMode()
  }, [closeAtMode, contexts, onSend])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      if (atMode) {
        event.preventDefault()
        closeAtMode()
      } else if (editorRef.current && editorIsEmpty(editorRef.current)) {
        event.preventDefault()
        onRequestClose()
      }
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && window.getSelection()) {
      const direction = event.key === 'Backspace' ? 'before' : 'after'
      const badge = adjacentBadge(editorRef.current!, window.getSelection()!, direction)
      if (badge) {
        event.preventDefault()
        fadeAndRemove(badge)
      }
    }
  }

  const removeContext = (item: ContextItem) => {
    const editor = editorRef.current
    if (!editor) return
    const badge = Array.from(editor.querySelectorAll<HTMLElement>('.context-badge')).find(
      (candidate) =>
        candidate.dataset.contextType === item.type && candidate.dataset.contextId === item.id,
    )
    if (badge) fadeAndRemove(badge)
  }

  return (
    <div className="shrink-0 border-t border-border bg-card px-4 pb-3 pt-3">
      {contexts.length > 0 && (
        <div className="scrollbar-hide mb-2 flex items-center gap-1.5 overflow-x-auto px-1">
          <AtSign className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {contexts.map((item) => {
            const Icon = entityIcon(item.type)
            return (
              <button
                key={`${item.type}:${item.id}`}
                type="button"
                onClick={() => removeContext(item)}
                title={`Remove ${item.display}`}
                className="inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-md bg-primary-subtle px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-primary/10"
              >
                <Icon className="h-3 w-3" />
                <span className="truncate">{item.display}</span>
                <X className="h-2.5 w-2.5" />
              </button>
            )
          })}
        </div>
      )}
      <div className="relative rounded-xl bg-foreground/[0.035] p-2 transition-[background-color,box-shadow] focus-within:bg-foreground/[0.045] focus-within:ring-1 focus-within:ring-primary/20">
        <ContextDropdown
          open={atMode}
          query={contextQuery}
          onQueryChange={setContextQuery}
          onClose={closeAtMode}
          onSelect={selectContext}
          editorRef={editorRef}
        />
        <div
          ref={editorRef}
          data-agent-composer
          data-placeholder="Ask about submissions, speakers, or the agenda…"
          role="textbox"
          aria-label="Message Ask SpeakerWeave"
          aria-multiline="true"
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={() => closeAtMode()}
          className={cn(
            'scrollbar-app block min-h-9 max-h-32 w-full overflow-y-auto border-0 bg-transparent px-1.5 py-1 text-[13px] leading-5 text-foreground outline-none',
            '[&:empty:before]:pointer-events-none [&:empty:before]:text-placeholder [&:empty:before]:content-[attr(data-placeholder)]',
          )}
          style={{ height: 36 }}
        />
        <div className="mt-1 flex items-center justify-between gap-2 pl-1.5">
          <span className="font-mono text-[9.5px] text-placeholder">@ for context · shift + enter for newline</span>
          {streaming ? (
            <button
              type="button"
              onClick={onCancel}
              title="Stop response"
              aria-label="Stop response"
              className="inline-flex h-[27px] w-[27px] items-center justify-center rounded-lg bg-foreground text-background transition-transform hover:opacity-90 active:translate-y-px"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send message"
              className="inline-flex h-[27px] items-center gap-1.5 rounded-lg bg-transparent px-2 text-xs font-medium text-primary transition-[background-color,transform] hover:bg-primary-subtle active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[10px] leading-relaxed text-placeholder">
        Review decisions and outbound messages before approving them.
      </p>
    </div>
  )
}
