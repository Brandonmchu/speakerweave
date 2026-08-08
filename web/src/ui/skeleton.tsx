import * as React from 'react'

import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // Surface-relative ink wash, not a fixed gray — reads on white cards and on
  // the slate canvas alike.
  return <div className={cn('animate-pulse rounded-md bg-foreground/[0.06]', className)} {...props} />
}

export { Skeleton }
