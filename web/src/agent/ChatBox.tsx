import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { useAgent } from '@/agent/AgentProvider'
import { ChatInput } from '@/agent/components/ChatInput'
import { stripContextHeader, parseContextTokens } from '@/agent/components/contextBadge'
import { MessageList } from '@/agent/components/MessageList'
import { PermissionPrompt } from '@/agent/components/PermissionPrompt'
import { WorkTrace } from '@/agent/components/WorkTrace'
import { agentEventEmitter } from '@/agent/lib/eventEmitter'
import { toast } from '@/ui/use-toast'

function queuedPreview(message: string): string {
  const { content } = stripContextHeader(message)
  const matches = parseContextTokens(content)
  let result = ''
  let cursor = 0
  matches.forEach((match) => {
    result += `${content.slice(cursor, match.startIndex)}@${match.item.display}`
    cursor = match.endIndex
  })
  return `${result}${content.slice(cursor)}`
}

export function ChatBox({ onRequestClose }: { onRequestClose: () => void }) {
  const navigate = useNavigate()
  const {
    activeThreadId,
    messages,
    messagesLoading,
    sendMessage,
    queuedMessages,
    removeQueuedMessage,
    isStreaming,
    isViewingStreaming,
    cancel,
    progress,
    trace,
    traceDone,
    lastTraceSignalAt,
    pendingPermission,
    permissionResponding,
    respondPermission,
    expirePermission,
  } = useAgent()

  useEffect(
    () =>
      agentEventEmitter.subscribe('navigate', ({ route, label, silent }) => {
        navigate(route)
        if (!silent) toast({ title: `Opened ${label || 'page'}` })
      }),
    [navigate],
  )

  const visibleQueue = queuedMessages.filter((item) => item.threadId === activeThreadId)
  const traceFooter = (
    <>
      <WorkTrace
        entries={trace}
        progress={progress}
        live={isViewingStreaming}
        done={!isStreaming && traceDone}
        lastSignalAt={lastTraceSignalAt}
      />
      {visibleQueue.length > 0 && (
        <div className="mx-1 mb-4 space-y-1.5" aria-label="Queued messages">
          {visibleQueue.map((item, index) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-lg bg-foreground/[0.028] px-2.5 py-2 text-xs text-foreground"
            >
              <span className="shrink-0 font-mono text-[10px] text-primary">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{queuedPreview(item.message)}</span>
              <button
                type="button"
                onClick={() => removeQueuedMessage(item.id)}
                aria-label="Remove queued message"
                className="flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-card hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MessageList messages={messages} loading={messagesLoading} onExample={sendMessage} footer={traceFooter} />
      {pendingPermission ? (
        <PermissionPrompt
          request={pendingPermission}
          responding={permissionResponding}
          onRespond={(approved) => void respondPermission(approved)}
          onExpire={expirePermission}
        />
      ) : (
        <ChatInput
          onSend={sendMessage}
          onCancel={() => void cancel()}
          onRequestClose={onRequestClose}
          streaming={isViewingStreaming}
        />
      )}
    </div>
  )
}
