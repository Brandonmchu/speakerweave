export interface AgentNavigateEvent {
  route: string
  label?: string
  silent?: boolean
}

type EventMap = {
  navigate: AgentNavigateEvent
}

class AgentEventEmitter {
  private listeners = new Map<keyof EventMap, Set<(payload: never) => void>>()

  subscribe<K extends keyof EventMap>(event: K, callback: (payload: EventMap[K]) => void) {
    const callbacks = this.listeners.get(event) ?? new Set()
    callbacks.add(callback as (payload: never) => void)
    this.listeners.set(event, callbacks)
    return () => {
      callbacks.delete(callback as (payload: never) => void)
      if (callbacks.size === 0) this.listeners.delete(event)
    }
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(payload as never)
      } catch (error) {
        console.error(`Agent event listener failed for ${event}`, error)
      }
    })
  }
}

export const agentEventEmitter = new AgentEventEmitter()

