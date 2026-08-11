import { AgentFeature as ChatFeature } from '@/agent/ChatSheet'
import type { AgentCapabilities } from '@/agent/types'

/**
 * Lazy mount boundary for the full chat surface. The shell owns the lightweight
 * toggle, so importing this module can be deferred until chat is opened.
 */
export function AgentFeature({
  capabilities,
  open,
  onOpenChange,
}: {
  capabilities: AgentCapabilities
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ChatFeature
      capabilities={capabilities}
      open={open}
      onOpenChange={onOpenChange}
      toggleContainerId="speakerweave-agent-lazy-toggle-mount"
    />
  )
}
