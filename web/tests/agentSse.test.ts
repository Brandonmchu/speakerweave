import { describe, expect, it } from 'vitest'

import { consumeAgentSse } from '@/agent/lib/agentApi'
import type { AgentStreamEvent } from '@/agent/types'

describe('agent SSE consumer', () => {
  it('carries partial lines across chunks without dropping terminal events', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"type":"thread_started","thread_id":"thread-1","turn_id":"turn-1"}\n\ndata: {"type":"message_',
      'delta","message":"Hello"}\n\ndata: {"type":"message_delta","message":" world"}\n\ndata: {"type":"message_complete"}\n\ndata: {"type":"com',
      'plete","message_to_user":"Hello world"}\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
        controller.close()
      },
    })
    const events: AgentStreamEvent[] = []
    let buffer = ''
    let final = ''
    await consumeAgentSse(stream, (event) => {
      events.push(event)
      if (event.type === 'message_delta') buffer += event.message
      if (event.type === 'message_complete') buffer += '\n\n'
      if (event.type === 'complete') final = event.message_to_user
    })

    expect(events.map((event) => event.type)).toEqual([
      'thread_started',
      'message_delta',
      'message_delta',
      'message_complete',
      'complete',
    ])
    expect(buffer).toBe('Hello world\n\n')
    expect(final).toBe('Hello world')
  })
})

