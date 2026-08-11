import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plug, PlugZap, Settings } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { useAgent } from '@/agent/AgentProvider'
import { listMCPConnectors } from '@/lib/integrationsApi'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'

export function ConnectorStatus() {
  const navigate = useNavigate()
  const { capabilities } = useAgent()
  const [open, setOpen] = useState(false)
  const count = capabilities.mcp.connectors_connected
  const connectors = useQuery({
    queryKey: ['integrations', 'mcp'],
    queryFn: listMCPConnectors,
    enabled: open,
  })

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`${count} MCP connector${count === 1 ? '' : 's'} connected`}
          aria-label={`MCP connectors, ${count} connected`}
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-soft transition-colors hover:bg-accent hover:text-foreground active:scale-[0.97]"
        >
          {count > 0 ? <PlugZap className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center font-mono text-[9px] font-semibold leading-4 text-primary-foreground">
            {count}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>MCP connectors</DropdownMenuLabel>
        {connectors.isPending ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">Checking connectors…</p>
        ) : connectors.error ? (
          <p className="px-2 py-3 text-xs text-destructive-strong">Couldn't load connector status.</p>
        ) : connectors.data?.length ? (
          connectors.data.map((connector) => (
            <div key={connector.key} className="flex items-start gap-2 rounded-sm px-2 py-2">
              <span
                title={connector.last_error}
                className={cn(
                  'mt-1 h-2 w-2 shrink-0 rounded-full',
                  connector.connected
                    ? 'bg-success'
                    : connector.last_error
                      ? 'bg-destructive'
                      : 'bg-muted-foreground/40',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{connector.name}</p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {connector.connected ? 'Connected' : connector.last_error ? 'Needs attention' : 'Not connected'}
                </p>
              </div>
            </div>
          ))
        ) : (
          <p className="px-2 py-3 text-xs text-muted-foreground">No connectors configured.</p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings className="h-4 w-4" />
          Manage in Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
