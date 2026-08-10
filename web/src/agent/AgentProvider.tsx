import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  agentKeys,
  cancelAgentTurn,
  consumeAgentSse,
  deleteAgentThread,
  getPendingPermission,
  listAgentMessages,
  listAgentThreads,
  openAgentStream,
  renameAgentThread,
  respondToAgentPermission,
} from '@/agent/lib/agentApi'
import { agentEventEmitter } from '@/agent/lib/eventEmitter'
import { turnRegistry, type ClientTurnHandle } from '@/agent/lib/turnRegistry'
import { useStreamPacer } from '@/agent/hooks/useStreamPacer'
import type {
  AgentCapabilities,
  AgentMessage,
  AgentThread,
  EntityUpdate,
  PermissionRequest,
  QueuedAgentMessage,
  TraceEntry,
} from '@/agent/types'
import { getToken } from '@/lib/api'
import { toast } from '@/ui/use-toast'

const MAX_QUEUE = 3
const QUEUE_GRACE_MS = 1200
const LAST_THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface ActiveTurn {
  handle: ClientTurnHandle
  controller: AbortController
  originalMessage: string
  userMessageId: string
  agentMessageId: string
  contentBuffer: string
  activity: EntityUpdate[]
}

interface AgentContextValue {
  capabilities: AgentCapabilities
  threads: AgentThread[]
  threadsLoading: boolean
  activeThreadId: string | null
  selectThread: (threadId: string | null) => void
  newChat: () => void
  renameThread: (threadId: string, name: string) => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
  messages: AgentMessage[]
  messagesLoading: boolean
  sendMessage: (message: string) => void
  queuedMessages: QueuedAgentMessage[]
  removeQueuedMessage: (id: string) => void
  isStreaming: boolean
  isViewingStreaming: boolean
  respondingThreadIds: Set<string>
  cancel: () => Promise<void>
  progress: string | null
  trace: TraceEntry[]
  traceDone: boolean
  lastTraceSignalAt: number
  pendingPermission: PermissionRequest | null
  permissionResponding: boolean
  respondPermission: (approved: boolean) => Promise<void>
  expirePermission: () => void
}

const AgentContext = createContext<AgentContextValue | null>(null)

function uniqueId(prefix: string): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  return `${prefix}-${id}`
}

function decodeOrgId(token: string | null): string {
  if (!token) return 'session'
  try {
    const payload = token.split('.')[1]
    if (!payload) return 'session'
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const claims = JSON.parse(atob(padded)) as { org_id?: string }
    return claims.org_id || 'session'
  } catch {
    return 'session'
  }
}

function readLastThread(orgId: string): string | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(`sw.chat.lastThread:${orgId}`) ?? 'null') as
      | { threadId?: string; timestamp?: number }
      | null
    if (!value?.threadId || !value.timestamp || Date.now() - value.timestamp > LAST_THREAD_MAX_AGE_MS) {
      window.localStorage.removeItem(`sw.chat.lastThread:${orgId}`)
      return null
    }
    return value.threadId
  } catch {
    return null
  }
}

function writeLastThread(orgId: string, threadId: string | null) {
  try {
    const key = `sw.chat.lastThread:${orgId}`
    if (threadId) window.localStorage.setItem(key, JSON.stringify({ threadId, timestamp: Date.now() }))
    else window.localStorage.removeItem(key)
  } catch {
    // A blocked localStorage still leaves the current in-memory selection intact.
  }
}

function normalizeMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    thread_id: message.thread_id ?? null,
    metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata : {},
    response_type: message.response_type ?? 'completion',
  }
}

function mutationQueryRoots(type: string): string[] {
  switch (type) {
    case 'event':
      return ['events', 'settings']
    case 'submission':
      return ['submissions', 'sessions', 'inbox']
    case 'speaker':
    case 'contact':
      return ['speakers', 'speakerProfile', 'directory']
    case 'session':
      return ['agenda', 'schedule', 'sessions']
    case 'form':
      return ['forms', 'form']
    case 'content':
      return ['content', 'contentItems']
    default:
      return []
  }
}

export function AgentProvider({
  capabilities,
  panelOpen,
  children,
}: {
  capabilities: AgentCapabilities
  panelOpen: boolean
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const activeThreadRef = useRef<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [currentTurn, setCurrentTurn] = useState<ActiveTurn | null>(null)
  const turnRef = useRef<ActiveTurn | null>(null)
  const [respondingThreadIds, setRespondingThreadIds] = useState<Set<string>>(() => new Set())
  const [queuedMessages, setQueuedMessages] = useState<QueuedAgentMessage[]>([])
  const [lastSettledAt, setLastSettledAt] = useState(0)
  const [progress, setProgress] = useState<string | null>(null)
  const [trace, setTrace] = useState<TraceEntry[]>([])
  const [traceDone, setTraceDone] = useState(false)
  const [lastTraceSignalAt, setLastTraceSignalAt] = useState(Date.now())
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [permissionResponding, setPermissionResponding] = useState(false)
  const restoredRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void getToken().then((token) => {
      if (!cancelled) setOrgId(decodeOrgId(token))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const threadsQuery = useQuery({
    queryKey: agentKeys.threads,
    queryFn: listAgentThreads,
    staleTime: 15_000,
    retry: false,
  })
  const threads = threadsQuery.data ?? []

  const selectThread = useCallback(
    (threadId: string | null) => {
      activeThreadRef.current = threadId
      setActiveThreadId(threadId)
      if (orgId) writeLastThread(orgId, threadId)
      const liveThread = turnRef.current?.handle.threadId
      if (liveThread !== threadId) setPendingPermission(null)
    },
    [orgId],
  )

  useEffect(() => {
    if (!orgId || threadsQuery.isPending || restoredRef.current) return
    restoredRef.current = true
    const stored = readLastThread(orgId)
    if (stored && threads.some((thread) => thread.id === stored)) selectThread(stored)
  }, [orgId, selectThread, threads, threadsQuery.isPending])

  const activeTurnThread = currentTurn?.handle.threadId ?? null
  const messagesQuery = useQuery({
    queryKey: activeThreadId ? agentKeys.messages(activeThreadId) : ['agent', 'messages', 'new'],
    queryFn: () => listAgentMessages(activeThreadId!),
    enabled: Boolean(activeThreadId) && activeTurnThread !== activeThreadId,
    retry: false,
  })

  useEffect(() => {
    if (!activeThreadId) {
      if (turnRef.current?.handle.threadId !== null) setMessages([])
      return
    }
    if (turnRef.current?.handle.threadId === activeThreadId) return
    setMessages([])
  }, [activeThreadId])

  useEffect(() => {
    if (!activeThreadId || !messagesQuery.data) return
    if (turnRef.current?.handle.threadId === activeThreadId) return
    setMessages(messagesQuery.data.messages.map(normalizeMessage))
  }, [activeThreadId, messagesQuery.data])

  const pendingQuery = useQuery({
    queryKey: activeThreadId ? agentKeys.permission(activeThreadId) : ['agent', 'permission', 'new'],
    queryFn: () => getPendingPermission(activeThreadId!),
    enabled: panelOpen && Boolean(activeThreadId),
    retry: false,
  })
  useEffect(() => {
    if (!panelOpen || pendingQuery.data === undefined) return
    if (!turnRef.current || pendingQuery.data) setPendingPermission(pendingQuery.data)
  }, [panelOpen, pendingQuery.data])

  const isViewTurn = useCallback((turn: ActiveTurn) => {
    return activeThreadRef.current === turn.handle.threadId
  }, [])

  const upsertStreamingMessage = useCallback((turn: ActiveTurn, content: string) => {
    if (!turnRegistry.isCurrent(turn.handle) || !isViewTurn(turn)) return
    setMessages((current) => {
      const existing = current.findIndex((message) => message.id === turn.agentMessageId)
      const next: AgentMessage = {
        id: turn.agentMessageId,
        thread_id: turn.handle.threadId,
        sender_type: 'agent',
        content,
        metadata: { turn_id: turn.handle.serverTurnId ?? turn.handle.clientTurnId, activity: [...turn.activity] },
        response_type: 'streaming',
        turn_id: turn.handle.serverTurnId,
        created_at: new Date().toISOString(),
      }
      if (existing === -1) return [...current, next]
      return current.map((message, index) => (index === existing ? { ...message, ...next } : message))
    })
  }, [isViewTurn])

  const pacer = useStreamPacer((content) => {
    const turn = turnRef.current
    if (turn) upsertStreamingMessage(turn, content)
  })

  const addTrace = useCallback((message: string, kind: TraceEntry['kind']) => {
    const cleaned = message.trim().replace(/^[-•]\s*/, '')
    if (!cleaned) return
    setLastTraceSignalAt(Date.now())
    setTrace((current) => {
      if (current.at(-1)?.message === cleaned) return current
      return [...current, { id: uniqueId('trace'), message: cleaned, kind, createdAt: Date.now() }]
    })
  }, [])

  const settleTurn = useCallback((turn: ActiveTurn) => {
    if (!turnRegistry.isCurrent(turn.handle)) return
    turnRegistry.release(turn.handle)
    if (turnRef.current?.handle.generation === turn.handle.generation) {
      turnRef.current = null
      setCurrentTurn(null)
    }
    setRespondingThreadIds((current) => {
      const next = new Set(current)
      if (turn.handle.threadId) next.delete(turn.handle.threadId)
      return next
    })
    setProgress(null)
    setTraceDone(true)
    setLastSettledAt(Date.now())
    void queryClient.invalidateQueries({ queryKey: agentKeys.threads })
    if (turn.handle.threadId) {
      void queryClient.invalidateQueries({ queryKey: agentKeys.messages(turn.handle.threadId) })
    }
  }, [queryClient])

  const finalizeAgentMessage = useCallback((turn: ActiveTurn, content: string) => {
    if (!turnRegistry.isCurrent(turn.handle) || !isViewTurn(turn)) return
    setMessages((current) => {
      const existing = current.findIndex((message) => message.id === turn.agentMessageId)
      const completed: AgentMessage = {
        id: turn.agentMessageId,
        thread_id: turn.handle.threadId,
        sender_type: 'agent',
        content,
        metadata: { turn_id: turn.handle.serverTurnId ?? turn.handle.clientTurnId, activity: [...turn.activity] },
        response_type: 'completion',
        turn_id: turn.handle.serverTurnId,
        created_at: new Date().toISOString(),
      }
      if (existing === -1) return content || turn.activity.length ? [...current, completed] : current
      return current.map((message, index) => (index === existing ? completed : message))
    })
  }, [isViewTurn])

  const startTurn = useCallback(async (message: string, requestedThreadId?: string | null) => {
    const threadId = requestedThreadId === undefined ? activeThreadRef.current : requestedThreadId
    const clientTurnId = uniqueId('client-turn')
    const handle = turnRegistry.begin(threadId, clientTurnId)
    const turn: ActiveTurn = {
      handle,
      controller: new AbortController(),
      originalMessage: message,
      userMessageId: uniqueId('user'),
      agentMessageId: uniqueId('agent-streaming'),
      contentBuffer: '',
      activity: [],
    }
    turnRef.current = turn
    setCurrentTurn(turn)
    pacer.reset()
    setProgress('Looking at your program')
    setTrace([])
    setTraceDone(false)
    setLastTraceSignalAt(Date.now())
    setPendingPermission(null)
    if (threadId) {
      setRespondingThreadIds((current) => new Set(current).add(threadId))
    }
    if (activeThreadRef.current === threadId) {
      setMessages((current) => [
        ...current,
        {
          id: turn.userMessageId,
          thread_id: threadId,
          sender_type: 'user',
          content: message,
          metadata: { turn_id: clientTurnId },
          response_type: 'completion',
          turn_id: clientTurnId,
          created_at: new Date().toISOString(),
        },
      ])
    }

    let terminalSeen = false
    try {
      const response = await openAgentStream(
        {
          thread_id: threadId,
          message,
          metadata: {
            pathname: window.location.pathname,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            client_turn_id: clientTurnId,
          },
        },
        turn.controller.signal,
      )
      await consumeAgentSse(
        response.body!,
        (event) => {
          if (!turnRegistry.isCurrent(handle)) return
          switch (event.type) {
            case 'thread_started': {
              const wasNew = handle.threadId === null
              turnRegistry.bind(handle, event.thread_id, event.turn_id)
              if (!turnRegistry.isCurrent(handle)) return
              setCurrentTurn({ ...turn })
              setRespondingThreadIds((current) => {
                const next = new Set(current)
                if (threadId) next.delete(threadId)
                next.add(event.thread_id)
                return next
              })
              setQueuedMessages((current) =>
                current.map((queued) =>
                  wasNew && queued.threadId === null ? { ...queued, threadId: event.thread_id } : queued,
                ),
              )
              if (wasNew && activeThreadRef.current === null) selectThread(event.thread_id)
              setMessages((current) =>
                current.map((entry) =>
                  entry.id === turn.userMessageId
                    ? { ...entry, thread_id: event.thread_id, turn_id: event.turn_id, metadata: { ...entry.metadata, turn_id: event.turn_id } }
                    : entry,
                ),
              )
              void queryClient.invalidateQueries({ queryKey: agentKeys.threads })
              break
            }
            case 'message_delta':
              if (!isViewTurn(turn)) return
              turn.contentBuffer += event.message
              pacer.push(turn.contentBuffer)
              break
            case 'message_complete':
              if (!isViewTurn(turn)) return
              turn.contentBuffer += '\n\n'
              pacer.push(turn.contentBuffer)
              break
            case 'progress':
              if (!isViewTurn(turn)) return
              setProgress(event.message)
              addTrace(event.message, 'progress')
              break
            case 'reasoning':
              if (!isViewTurn(turn)) return
              addTrace(event.message, 'reasoning')
              break
            case 'permission_request':
              if (!isViewTurn(turn)) return
              setPendingPermission(event)
              addTrace('Waiting for your confirmation', 'permission')
              break
            case 'permission_resolved':
              if (!isViewTurn(turn)) return
              setPendingPermission((current) =>
                current?.request_id === event.request_id ? null : current,
              )
              addTrace(event.approved ? 'Approval received' : 'Action denied', 'permission')
              break
            case 'navigate':
              if (isViewTurn(turn)) {
                agentEventEmitter.emit('navigate', {
                  route: event.route,
                  label: event.label,
                  silent: event.silent,
                })
              }
              break
            case 'entity_update': {
              turn.activity.push({
                entity_type: event.entity_type,
                entity_id: event.entity_id,
                change_type: event.change_type,
                display: event.display,
              })
              mutationQueryRoots(event.entity_type).forEach((root) => {
                void queryClient.invalidateQueries({ queryKey: [root] })
              })
              if (isViewTurn(turn)) upsertStreamingMessage(turn, turn.contentBuffer)
              break
            }
            case 'thread_update':
              queryClient.setQueryData<AgentThread[]>(agentKeys.threads, (current = []) =>
                current.map((item) =>
                  item.id === event.thread_id ? { ...item, name: event.name } : item,
                ),
              )
              break
            case 'complete':
              terminalSeen = true
              pacer.finish(event.message_to_user, () => {
                if (!turnRegistry.isCurrent(handle)) return
                finalizeAgentMessage(turn, event.message_to_user)
                settleTurn(turn)
              })
              break
            case 'error':
              terminalSeen = true
              pacer.reset()
              if (event.code === 'thread_busy') {
                if (isViewTurn(turn)) {
                  setMessages((current) =>
                    current.filter(
                      (entry) => entry.id !== turn.userMessageId && entry.id !== turn.agentMessageId,
                    ),
                  )
                }
                setQueuedMessages((current) => [
                  { id: uniqueId('queued'), message: turn.originalMessage, threadId: handle.threadId },
                  ...current,
                ].slice(0, MAX_QUEUE))
                toast({ title: 'That chat is finishing up', description: 'Your message is queued and will send next.' })
              } else if (isViewTurn(turn)) {
                setMessages((current) => [
                  ...current.filter((entry) => entry.id !== turn.agentMessageId),
                  {
                    id: turn.agentMessageId,
                    thread_id: handle.threadId,
                    sender_type: 'agent',
                    content: event.message,
                    metadata: { turn_id: handle.serverTurnId ?? handle.clientTurnId },
                    response_type: 'error',
                    turn_id: handle.serverTurnId,
                    created_at: new Date().toISOString(),
                  },
                ])
              }
              settleTurn(turn)
              break
            case 'cancelled':
              terminalSeen = true
              pacer.reset()
              if (isViewTurn(turn)) {
                setMessages((current) => current.filter((entry) => entry.id !== turn.agentMessageId))
              }
              addTrace('Response stopped', 'progress')
              settleTurn(turn)
              break
            case 'keepalive':
              break
          }
        },
        turn.controller.signal,
      )
      if (!terminalSeen && turnRegistry.isCurrent(handle) && !turn.controller.signal.aborted) {
        throw new Error('The response ended before the agent finished.')
      }
    } catch (error) {
      if (!turnRegistry.isCurrent(handle) || turn.controller.signal.aborted) return
      pacer.reset()
      const messageText = error instanceof Error ? error.message : 'The agent could not finish this turn.'
      if (isViewTurn(turn)) {
        setMessages((current) => [
          ...current.filter((entry) => entry.id !== turn.agentMessageId),
          {
            id: turn.agentMessageId,
            thread_id: handle.threadId,
            sender_type: 'agent',
            content: messageText,
            metadata: { turn_id: handle.serverTurnId ?? handle.clientTurnId },
            response_type: 'error',
            turn_id: handle.serverTurnId,
            created_at: new Date().toISOString(),
          },
        ])
      }
      settleTurn(turn)
    }
  }, [addTrace, finalizeAgentMessage, isViewTurn, pacer, queryClient, selectThread, settleTurn, upsertStreamingMessage])

  const startTurnRef = useRef(startTurn)
  startTurnRef.current = startTurn

  useEffect(() => {
    if (currentTurn || queuedMessages.length === 0 || pendingPermission) return
    const next = queuedMessages[0]
    const delay = Math.max(0, QUEUE_GRACE_MS - (Date.now() - lastSettledAt))
    const timer = window.setTimeout(() => {
      setQueuedMessages((current) => current.filter((item) => item.id !== next.id))
      void startTurnRef.current(next.message, next.threadId)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [currentTurn, lastSettledAt, pendingPermission, queuedMessages])

  useEffect(() => () => {
    const turn = turnRef.current
    if (turn) {
      turn.controller.abort()
      turnRegistry.release(turn.handle)
    }
    pacer.reset()
  }, [pacer])

  const sendMessage = useCallback((message: string) => {
    if (turnRef.current) {
      setQueuedMessages((current) => {
        if (current.length >= MAX_QUEUE) {
          toast({ variant: 'destructive', title: 'Queue full', description: 'Wait for a queued message to send or remove one.' })
          return current
        }
        return [...current, { id: uniqueId('queued'), message, threadId: activeThreadRef.current }]
      })
      return
    }
    void startTurnRef.current(message)
  }, [])

  const newChat = useCallback(() => selectThread(null), [selectThread])

  const renameThread = useCallback(async (threadId: string, name: string) => {
    const trimmed = name.trim().slice(0, 100)
    if (!trimmed) return
    const previous = queryClient.getQueryData<AgentThread[]>(agentKeys.threads)
    queryClient.setQueryData<AgentThread[]>(agentKeys.threads, (current = []) =>
      current.map((thread) => (thread.id === threadId ? { ...thread, name: trimmed } : thread)),
    )
    try {
      const response = await renameAgentThread(threadId, trimmed)
      queryClient.setQueryData<AgentThread[]>(agentKeys.threads, (current = []) =>
        current.map((thread) => (thread.id === threadId ? response.thread : thread)),
      )
    } catch (error) {
      queryClient.setQueryData(agentKeys.threads, previous)
      throw error
    }
  }, [queryClient])

  const deleteThread = useCallback(async (threadId: string) => {
    const previous = queryClient.getQueryData<AgentThread[]>(agentKeys.threads)
    queryClient.setQueryData<AgentThread[]>(agentKeys.threads, (current = []) =>
      current.filter((thread) => thread.id !== threadId),
    )
    if (activeThreadRef.current === threadId) selectThread(null)
    try {
      await deleteAgentThread(threadId)
      queryClient.removeQueries({ queryKey: agentKeys.messages(threadId) })
    } catch (error) {
      queryClient.setQueryData(agentKeys.threads, previous)
      throw error
    }
  }, [queryClient, selectThread])

  const cancel = useCallback(async () => {
    const turn = turnRef.current
    if (!turn?.handle.threadId || !turn.handle.serverTurnId) return
    try {
      await cancelAgentTurn(turn.handle.threadId, turn.handle.serverTurnId)
    } catch (error) {
      toast({ variant: 'destructive', title: "Couldn't stop the response", description: error instanceof Error ? error.message : 'Try again.' })
    }
  }, [])

  const respondPermission = useCallback(async (approved: boolean) => {
    const request = pendingPermission
    if (!request) return
    setPermissionResponding(true)
    try {
      await respondToAgentPermission(request.request_id, approved)
      setPendingPermission(null)
      addTrace(approved ? 'Approval received' : 'Action denied', 'permission')
      if (activeThreadRef.current) {
        void queryClient.invalidateQueries({ queryKey: agentKeys.permission(activeThreadRef.current) })
      }
    } catch (error) {
      toast({ variant: 'destructive', title: "Couldn't send your decision", description: error instanceof Error ? error.message : 'Try again.' })
    } finally {
      setPermissionResponding(false)
    }
  }, [addTrace, pendingPermission, queryClient])

  const expirePermission = useCallback(() => {
    setPendingPermission((current) => {
      if (current) addTrace('Approval request expired', 'permission')
      return null
    })
  }, [addTrace])

  const isViewingStreaming = Boolean(
    currentTurn && activeThreadId === currentTurn.handle.threadId,
  )
  const value = useMemo<AgentContextValue>(() => ({
    capabilities,
    threads,
    threadsLoading: threadsQuery.isPending,
    activeThreadId,
    selectThread,
    newChat,
    renameThread,
    deleteThread,
    messages,
    messagesLoading:
      Boolean(activeThreadId) && messagesQuery.isPending && activeTurnThread !== activeThreadId,
    sendMessage,
    queuedMessages,
    removeQueuedMessage: (id) =>
      setQueuedMessages((current) => current.filter((message) => message.id !== id)),
    isStreaming: Boolean(currentTurn),
    isViewingStreaming,
    respondingThreadIds,
    cancel,
    progress,
    trace,
    traceDone,
    lastTraceSignalAt,
    pendingPermission,
    permissionResponding,
    respondPermission,
    expirePermission,
  }), [
    activeThreadId,
    activeTurnThread,
    cancel,
    capabilities,
    currentTurn,
    deleteThread,
    expirePermission,
    isViewingStreaming,
    messages,
    messagesQuery.isPending,
    newChat,
    pendingPermission,
    permissionResponding,
    progress,
    queuedMessages,
    renameThread,
    respondPermission,
    respondingThreadIds,
    selectThread,
    sendMessage,
    threads,
    threadsQuery.isPending,
    trace,
    traceDone,
    lastTraceSignalAt,
  ])

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgent(): AgentContextValue {
  const context = useContext(AgentContext)
  if (!context) throw new Error('useAgent must be used inside AgentProvider')
  return context
}

