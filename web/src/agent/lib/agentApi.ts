import type {
  AgentCapabilities,
  AgentMessage,
  AgentStreamEvent,
  AgentThread,
  ContextItem,
  PermissionRequest,
} from '@/agent/types'
import { ApiError, apiGet, apiPatch, apiPost, getToken, request } from '@/lib/api'

const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '')

export const agentKeys = {
  capabilities: ['agent', 'capabilities'] as const,
  threads: ['agent', 'threads'] as const,
  messages: (threadId: string) => ['agent', 'messages', threadId] as const,
  permission: (threadId: string) => ['agent', 'permission', threadId] as const,
}

export const getAgentCapabilities = () =>
  apiGet<AgentCapabilities>('/api/agent/capabilities')

export async function listAgentThreads(): Promise<AgentThread[]> {
  const response = await apiGet<{ threads: AgentThread[] }>('/api/agent/threads')
  return response.threads.slice(0, 50)
}

export const renameAgentThread = (threadId: string, name: string) =>
  apiPatch<{ thread: AgentThread }>(`/api/agent/threads/${threadId}`, { name })

export const deleteAgentThread = (threadId: string) =>
  request<{ ok: boolean }>(`/api/agent/threads/${threadId}`, { method: 'DELETE' })

export const listAgentMessages = (threadId: string, limit = 30, offset = 0) =>
  apiGet<{ messages: AgentMessage[]; has_more: boolean }>(
    `/api/agent/threads/${threadId}/messages?limit=${limit}&offset=${offset}`,
  )

export const searchAgentContext = async (
  query: string,
  type?: string | null,
  signal?: AbortSignal,
): Promise<ContextItem[]> => {
  const params = new URLSearchParams({ q: query })
  if (type) params.set('type', type)
  const response = await apiGet<{ results: ContextItem[] }>(
    `/api/agent/context-search?${params.toString()}`,
    { signal },
  )
  return response.results.slice(0, 20)
}

export async function openAgentStream(
  body: {
    thread_id: string | null
    message: string
    metadata: { pathname: string; timezone: string; client_turn_id: string }
  },
  signal: AbortSignal,
): Promise<Response> {
  const token = await getToken()
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetch(`${BASE_URL}/api/agent/chat/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new ApiError("Can't reach the agent. Check your connection and try again.", 0)
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string; message?: string }
      | null
    throw new ApiError(
      payload?.detail ?? payload?.message ?? 'The agent could not start this turn.',
      response.status,
      payload,
    )
  }
  if (!response.body) throw new ApiError('The agent returned an empty stream.', 502)
  return response
}

export async function consumeAgentSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''

  const consumeLines = (final = false) => {
    const lines = lineBuffer.split('\n')
    lineBuffer = final ? '' : (lines.pop() ?? '')
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!line.startsWith('data: ')) continue
      try {
        onEvent(JSON.parse(line.slice(6)) as AgentStreamEvent)
      } catch {
        // One malformed provider frame must not discard later valid events.
      }
    }
  }

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (done) {
        lineBuffer += decoder.decode()
        if (lineBuffer && !lineBuffer.endsWith('\n')) lineBuffer += '\n'
        consumeLines(true)
        break
      }
      lineBuffer += decoder.decode(value, { stream: true })
      consumeLines()
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export const cancelAgentTurn = (threadId: string, turnId: string) =>
  apiPost<{ ok: boolean }>('/api/agent/chat/cancel', {
    thread_id: threadId,
    turn_id: turnId,
  })

export const respondToAgentPermission = (requestId: string, approved: boolean) =>
  apiPost<{ ok: boolean }>('/api/agent/permission-response', {
    request_id: requestId,
    approved,
  })

export async function getPendingPermission(threadId: string): Promise<PermissionRequest | null> {
  const response = await apiGet<
    | PermissionRequest
    | { request: PermissionRequest | null }
    | { pending: PermissionRequest | null }
  >(`/api/agent/threads/${threadId}/permission-requests/pending`)
  if ('request' in response) return response.request
  if ('pending' in response) return response.pending
  return 'request_id' in response ? response : null
}

export const connectEvery = () =>
  apiPost<{ authorize_url: string }>('/api/agent/integrations/every/connect', {})

export const disconnectEvery = () =>
  apiPost<{ ok: boolean }>('/api/agent/integrations/every/disconnect', {})

