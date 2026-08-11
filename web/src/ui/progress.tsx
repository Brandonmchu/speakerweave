import * as React from 'react'

import { cn } from '@/lib/utils'

function Progress({
  value = 0,
  max = 100,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { value?: number; max?: number }) {
  const safeMax = max > 0 ? max : 100
  const safeValue = Math.min(safeMax, Math.max(0, value))
  const percentage = (safeValue / safeMax) * 100

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeValue}
      className={cn('h-px w-[52px] overflow-hidden bg-foreground/[0.07]', className)}
      {...props}
    >
      <div className="h-full bg-success" style={{ width: `${percentage}%` }} />
    </div>
  )
}

export { Progress }
