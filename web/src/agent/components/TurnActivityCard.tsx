import { useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { entityIcon } from '@/agent/components/ContextDropdown'
import { getEntityRoute } from '@/agent/lib/entityRoutes'
import type { EntityUpdate } from '@/agent/types'

const ACTION_LABELS: Record<EntityUpdate['change_type'], string> = {
  created: 'Created',
  updated: 'Updated',
  deleted: 'Deleted',
}

export function TurnActivityCard({ activity }: { activity: EntityUpdate[] }) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  if (activity.length === 0) return null
  const visible = activity.length > 4 && !expanded ? activity.slice(0, 3) : activity

  return (
    <div className="mt-3 overflow-hidden rounded-xl bg-foreground/[0.028]">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[11px] font-medium text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-success" />
        {activity.length} update{activity.length === 1 ? '' : 's'} completed
      </div>
      <div className="divide-y divide-border">
        {visible.map((item, index) => {
          const Icon = entityIcon(item.entity_type)
          const route = getEntityRoute(item.entity_type, item.entity_id)
          return (
            <button
              key={`${item.entity_type}:${item.entity_id}:${item.change_type}:${index}`}
              type="button"
              disabled={!route}
              onClick={() => route && navigate(route)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.045] disabled:cursor-default"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.045] text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                <span className="font-medium">{ACTION_LABELS[item.change_type]}</span> · {item.display}
              </span>
              {route && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            </button>
          )
        })}
      </div>
      {activity.length > 4 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="h-[27px] w-full border-t border-border px-3 text-left text-[11px] font-medium text-primary hover:bg-foreground/[0.045]"
        >
          {expanded ? 'Show less' : `View ${activity.length - 3} more`}
        </button>
      )}
    </div>
  )
}
