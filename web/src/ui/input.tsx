import * as React from 'react'

import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'bg-card border border-input text-foreground placeholder:text-placeholder flex w-full h-9 min-w-0 rounded-md px-3 py-1 text-base transition-[color,box-shadow,border-color] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:text-muted-foreground',
        'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20',
        'aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20',
        className
      )}
      {...props}
    />
  )
}

export { Input }
