import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AlertCircle, Send, Sparkles, X } from 'lucide-react'

import {
  chatWithAssistant,
  type AssistantHistoryMessage,
  type AssistantToolCall,
} from '@/lib/assistantApi'
import { cn } from '@/lib/utils'
import { Dialog, DialogOverlay, DialogPortal } from '@/ui/dialog'

const MAX_HISTORY_MESSAGES = 30

const STARTER_QUESTIONS = [
  "What's the state of submissions?",
  "Who hasn't finished onboarding?",
  'Any schedule conflicts?',
]

interface PanelMessage extends AssistantHistoryMessage {
  id: number
  toolCalls?: AssistantToolCall[]
}

interface AssistantPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={`${part}-${index}`} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  )
}

function MarkdownMessage({ content }: { content: string }) {
  const blocks: Array<
    | { type: 'paragraph'; lines: string[] }
    | { type: 'unordered-list' | 'ordered-list'; lines: string[] }
  > = []
  let startsNewBlock = true

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      startsNewBlock = true
      continue
    }

    const unordered = line.match(/^[-*]\s+(.+)/)
    const ordered = line.match(/^\d+[.)]\s+(.+)/)
    const type = unordered ? 'unordered-list' : ordered ? 'ordered-list' : 'paragraph'
    const value = unordered?.[1] ?? ordered?.[1] ?? line.replace(/^#{1,6}\s+/, '')
    const previous = blocks.at(-1)
    if (!startsNewBlock && previous?.type === type) {
      previous.lines.push(value)
    } else {
      blocks.push({ type, lines: [value] })
    }
    startsNewBlock = false
  }

  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, blockIndex) => {
        if (block.type === 'paragraph') {
          return (
            <p key={blockIndex}>
              {block.lines.map((line, lineIndex) => (
                <span key={`${line}-${lineIndex}`}>
                  {lineIndex > 0 && ' '}
                  {renderInlineMarkdown(line)}
                </span>
              ))}
            </p>
          )
        }
        const List = block.type === 'ordered-list' ? 'ol' : 'ul'
        return (
          <List
            key={blockIndex}
            className={cn(
              'space-y-1 pl-5',
              block.type === 'ordered-list' ? 'list-decimal' : 'list-disc',
            )}
          >
            {block.lines.map((line, lineIndex) => (
              <li key={`${line}-${lineIndex}`}>{renderInlineMarkdown(line)}</li>
            ))}
          </List>
        )
      })}
    </div>
  )
}

function ThinkingBubble() {
  return (
    <div role="status" aria-label="Ask SpeakerWeave is thinking" className="flex justify-start">
      <div className="w-44 rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
        <div className="h-2 w-24 animate-pulse rounded-full bg-primary/15" />
        <div className="mt-2 h-2 w-36 animate-pulse rounded-full bg-muted" />
        <div className="mt-2 h-2 w-20 animate-pulse rounded-full bg-muted" />
      </div>
    </div>
  )
}

export function AssistantPanel({ open, onOpenChange }: AssistantPanelProps) {
  const [messages, setMessages] = useState<PanelMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nextId = useRef(1)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messages, pending, error])

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()
    const content = input.trim()
    if (!content || pending) return

    const userMessage: PanelMessage = {
      id: nextId.current++,
      role: 'user',
      content,
    }
    const history = [...messages, userMessage].slice(-MAX_HISTORY_MESSAGES)
    setMessages(history)
    setInput('')
    setError(null)
    setPending(true)

    try {
      const response = await chatWithAssistant(
        history.map(({ role, content: messageContent }) => ({
          role,
          content: messageContent,
        })),
      )
      const assistantMessage: PanelMessage = {
        id: nextId.current++,
        role: 'assistant',
        content: response.reply,
        toolCalls: response.tool_calls,
      }
      setMessages((current) => [...current, assistantMessage].slice(-MAX_HISTORY_MESSAGES))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Ask SpeakerWeave could not reply.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-foreground/15 backdrop-blur-[1px]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-lifted',
            'duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
          )}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            inputRef.current?.focus()
          }}
        >
          <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-soft">
              <Sparkles className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-[15px] font-semibold tracking-tight text-foreground">
                Ask SpeakerWeave
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-xs text-muted-foreground">
                Answers from your conference workspace
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              aria-label="Close Ask SpeakerWeave"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-[0.98]"
            >
              <X className="h-[18px] w-[18px]" />
            </DialogPrimitive.Close>
          </header>

          <div
            data-testid="assistant-messages"
            className="scrollbar-app min-h-0 flex-1 overflow-y-auto bg-background px-4 py-5"
            aria-live="polite"
          >
            {messages.length === 0 && !pending ? (
              <div className="mx-auto flex h-full max-w-xs flex-col justify-center py-8">
                <div className="mb-5 h-px w-12 bg-primary" />
                <h3 className="text-lg font-semibold tracking-tight text-foreground">
                  Ask about the work in motion.
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  I can check submissions, speakers, content, and the schedule using live workspace
                  data.
                </p>
                <p className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Try asking
                </p>
                <div className="mt-2 divide-y divide-border border-y border-border">
                  {STARTER_QUESTIONS.map((question) => (
                    <button
                      key={question}
                      type="button"
                      className="block w-full py-3 text-left text-sm text-foreground transition-colors hover:text-primary active:translate-y-px"
                      onClick={() => {
                        setInput(question)
                        inputRef.current?.focus()
                      }}
                    >
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    data-testid="assistant-message"
                    data-role={message.role}
                    className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                  >
                    <div className="max-w-[88%]">
                      <div
                        className={cn(
                          'rounded-2xl px-4 py-3',
                          message.role === 'user'
                            ? 'rounded-br-md bg-primary text-primary-foreground shadow-soft'
                            : 'rounded-bl-md border border-border bg-card text-foreground shadow-soft',
                        )}
                      >
                        {message.role === 'assistant' ? (
                          <MarkdownMessage content={message.content} />
                        ) : (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
                        )}
                      </div>
                      {message.role === 'assistant' && Boolean(message.toolCalls?.length) && (
                        <p
                          className="mt-1.5 px-1 text-[11px] text-muted-foreground"
                          title={message.toolCalls
                            ?.map((tool) => `${tool.name}: ${tool.summary}`)
                            .join('\n')}
                        >
                          Used tools: {message.toolCalls?.map((tool) => tool.name).join(', ')}
                        </p>
                      )}
                    </div>
                  </article>
                ))}
                {pending && <ThinkingBubble />}
                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive-strong"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>{error}</p>
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>

          <form onSubmit={sendMessage} className="shrink-0 border-t border-border bg-card p-4">
            <label htmlFor="assistant-input" className="sr-only">
              Message Ask SpeakerWeave
            </label>
            <div className="rounded-xl border border-input bg-background p-2 shadow-soft focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
              <textarea
                ref={inputRef}
                id="assistant-input"
                data-testid="assistant-input"
                rows={2}
                maxLength={8000}
                value={input}
                disabled={pending}
                placeholder="Ask about submissions, speakers, or the schedule…"
                className="block max-h-32 min-h-12 w-full resize-none border-0 bg-transparent px-1.5 py-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-placeholder disabled:opacity-60"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void sendMessage()
                  }
                }}
              />
              <div className="mt-1 flex items-center justify-between gap-3 pl-1.5">
                <span className="text-[11px] text-muted-foreground">Shift + Enter for a new line</span>
                <button
                  type="submit"
                  data-testid="assistant-send"
                  disabled={!input.trim() || pending}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Send className="h-3.5 w-3.5" />
                  Send
                </button>
              </div>
            </div>
            <p className="mt-2 text-center text-[10px] leading-relaxed text-muted-foreground">
              SpeakerWeave checks live data. Review decisions before acting.
            </p>
          </form>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
