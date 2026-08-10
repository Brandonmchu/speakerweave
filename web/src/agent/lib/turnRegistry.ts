export interface ClientTurnHandle {
  clientTurnId: string
  threadKey: string
  threadId: string | null
  serverTurnId: string | null
  generation: number
}

let generation = 0
const currentTurns = new Map<string, ClientTurnHandle>()

export const turnRegistry = {
  begin(threadId: string | null, clientTurnId: string): ClientTurnHandle {
    const handle: ClientTurnHandle = {
      clientTurnId,
      threadKey: threadId ?? `new:${clientTurnId}`,
      threadId,
      serverTurnId: null,
      generation: ++generation,
    }
    currentTurns.set(handle.threadKey, handle)
    return handle
  },

  bind(handle: ClientTurnHandle, threadId: string, serverTurnId: string) {
    if (!this.isCurrent(handle)) return
    currentTurns.delete(handle.threadKey)
    handle.threadKey = threadId
    handle.threadId = threadId
    handle.serverTurnId = serverTurnId
    currentTurns.set(threadId, handle)
  },

  isCurrent(handle: ClientTurnHandle): boolean {
    return currentTurns.get(handle.threadKey)?.generation === handle.generation
  },

  release(handle: ClientTurnHandle) {
    if (this.isCurrent(handle)) currentTurns.delete(handle.threadKey)
  },
}

