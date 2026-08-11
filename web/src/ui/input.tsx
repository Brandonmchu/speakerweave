import * as React from 'react'

import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-[30px] w-full min-w-0 rounded-lg border border-transparent bg-foreground/[0.045] px-3 py-1 text-[13px] text-foreground outline-none transition-[color,box-shadow,border-color,background-color] placeholder:text-placeholder disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:text-muted-foreground',
        'focus-visible:border-input focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15',
        'aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/15',
        className
      )}
      {...props}
    />
  )
}

export { Input }
