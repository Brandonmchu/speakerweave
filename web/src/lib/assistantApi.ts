import { apiPost } from '@/lib/api'

export type AssistantRole = 'user' | 'assistant'

export interface AssistantHistoryMessage {
  role: AssistantRole
  content: string
}

export interface AssistantToolCall {
  name: string
  summary: string
}

export interface AssistantChatResponse {
  reply: string
  tool_calls: AssistantToolCall[]
}

export function chatWithAssistant(
  messages: AssistantHistoryMessage[],
): Promise<AssistantChatResponse> {
  return apiPost<AssistantChatResponse>('/api/assistant/chat', { messages })
}
