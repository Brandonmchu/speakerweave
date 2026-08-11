import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex max-w-full shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border border-transparent bg-primary/10 text-primary',
        success: 'border border-transparent bg-success/15 text-success-strong',
        warning: 'border border-transparent bg-warning/15 text-warning-strong',
        destructive: 'border border-transparent bg-destructive/10 text-destructive-strong',
        muted: 'border border-transparent bg-foreground/5 text-muted-foreground',
        outline: 'bg-card border border-border text-foreground',
        /* Sessionboard's solid dark-slate lifecycle pill ("Open", etc.) */
        solid: 'border border-transparent bg-status-solid text-status-solid-foreground',
        dot: 'gap-2 rounded-none bg-transparent p-0 text-[12.5px] font-normal text-foreground before:h-[5px] before:w-[5px] before:shrink-0 before:rounded-full before:bg-status-neutral before:content-[\'\']',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean
}

function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : 'div'
  return <Comp className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
