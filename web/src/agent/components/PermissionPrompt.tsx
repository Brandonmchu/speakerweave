import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'

import type { PermissionRequest } from '@/agent/types'

function secondsRemaining(expiresAt: string): number {
  const timestamp = Date.parse(expiresAt)
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)) : 0
}

export function PermissionPrompt({
  request,
  responding,
  onRespond,
  onExpire,
}: {
  request: PermissionRequest
  responding: boolean
  onRespond: (approved: boolean) => void
  onExpire: () => void
}) {
  const [remaining, setRemaining] = useState(() => secondsRemaining(request.expires_at))
  useEffect(() => {
    setRemaining(secondsRemaining(request.expires_at))
    const interval = window.setInterval(() => {
      const next = secondsRemaining(request.expires_at)
      setRemaining(next)
      if (next === 0) {
        window.clearInterval(interval)
        onExpire()
      }
    }, 1000)
    return () => window.clearInterval(interval)
  }, [onExpire, request.expires_at])

  const entity = useMemo(() => {
    if (request.entity_info?.display) return request.entity_info.display
    const candidate = request.tool_input.display ?? request.tool_input.name ?? request.tool_input.title
    return typeof candidate === 'string' ? candidate : null
  }, [request.entity_info?.display, request.tool_input])

  return (
    <div className="shrink-0 border-t border-border bg-card p-3">
      <div className="rounded-xl bg-foreground/[0.028] p-3.5">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning-strong">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Approval needed</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{request.description}</p>
            {entity && (
              <p className="mt-2 truncate rounded-md border border-border bg-card px-2 py-1.5 text-xs font-medium text-foreground">
                {entity}
              </p>
            )}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-warning/20 pt-3">
          <span className="text-[10px] tabular-nums text-muted-foreground">Expires in {remaining}s</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={responding}
              onClick={() => onRespond(false)}
              className="inline-flex h-[27px] items-center gap-1.5 rounded-lg bg-foreground/[0.045] px-3 text-xs font-medium text-muted-foreground hover:bg-foreground/[0.07] active:translate-y-px disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              Deny
            </button>
            <button
              type="button"
              disabled={responding || remaining === 0}
              onClick={() => onRespond(true)}
              className="inline-flex h-[27px] items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary-strong active:translate-y-px disabled:opacity-50"
            >
              {responding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
