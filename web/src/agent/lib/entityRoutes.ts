import type { AgentEntityType } from '@/agent/types'

export function getEntityRoute(type: AgentEntityType | string, id: string): string | null {
  switch (type) {
    case 'submission':
      return `/submissions?open=${encodeURIComponent(id)}`
    case 'speaker':
    case 'contact':
      return `/speakers?person=${encodeURIComponent(id)}`
    case 'session':
      return `/agenda?session=${encodeURIComponent(id)}`
    case 'form':
      return `/forms/${encodeURIComponent(id)}`
    case 'content':
      return `/content?item=${encodeURIComponent(id)}`
    case 'event':
      return '/settings'
    default:
      return null
  }
}

