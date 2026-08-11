export type AgentEntityType =
  | 'event'
  | 'submission'
  | 'speaker'
  | 'session'
  | 'form'
  | 'content'
  | 'contact'

export interface AgentCapabilities {
  assistant: boolean
  provider: 'openai' | 'anthropic' | null
  mcp: {
    available: boolean
    connectors_connected: number
  }
}

export interface AgentThread {
  id: string
  name: string
  status: string
  last_message_at: string | null
  created_at: string
}

export interface ContextItem {
  type: AgentEntityType | string
  id: string
  display: string
  sublabel?: string | null
}

export interface EntityUpdate {
  entity_type: AgentEntityType | string
  entity_id: string
  change_type: 'created' | 'updated' | 'deleted'
  display: string
}

export interface AgentMessageMetadata {
  context_items?: ContextItem[]
  activity?: EntityUpdate[]
  cancelled?: boolean
  turn_id?: string
  [key: string]: unknown
}

export interface AgentMessage {
  id: string
  thread_id: string | null
  user_id?: string | null
  sender_type: 'user' | 'agent' | 'system'
  content: string
  metadata: AgentMessageMetadata
  response_type: 'streaming' | 'completion' | 'error'
  turn_id?: string | null
  created_at: string
}

export interface TraceEntry {
  id: string
  message: string
  kind: 'reasoning' | 'progress' | 'permission'
  createdAt: number
}

export interface PermissionRequest {
  request_id: string
  tool_name: string
  description: string
  tool_input: Record<string, unknown>
  expires_at: string
  entity_info?: { type?: string; id?: string; display?: string } | null
}

export interface QueuedAgentMessage {
  id: string
  message: string
  threadId: string | null
}

export type AgentStreamEvent =
  | { type: 'thread_started'; thread_id: string; turn_id: string }
  | { type: 'message_delta'; message: string }
  | { type: 'message_complete' }
  | { type: 'progress'; message: string }
  | { type: 'reasoning'; message: string }
  | ({ type: 'permission_request' } & PermissionRequest)
  | { type: 'permission_resolved'; request_id: string; approved: boolean }
  | { type: 'navigate'; route: string; label: string; silent?: boolean }
  | ({ type: 'entity_update' } & EntityUpdate)
  | { type: 'thread_update'; thread_id: string; name: string }
  | { type: 'complete'; message_to_user: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'cancelled' }
  | { type: 'keepalive' }
