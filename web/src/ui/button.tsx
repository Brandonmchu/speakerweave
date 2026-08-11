import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] text-[13px] font-medium outline-none transition-[color,background-color,box-shadow,opacity,transform] active:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:active:translate-y-0 [&_svg]:pointer-events-none [&_svg]:h-3.5 [&_svg]:w-3.5",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-strong',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive-strong',
        secondary: 'bg-foreground/[0.045] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground',
        outline: 'bg-foreground/[0.045] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground',
        ghost: 'bg-foreground/[0.045] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground',
        link: 'bg-transparent text-primary underline underline-offset-4 hover:text-primary-strong',
      },
      size: {
        default: 'h-[30px] px-3.5',
        xs: "h-6 gap-1 rounded-[7px] px-2 text-[11px] [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-[27px] gap-1.5 rounded-lg px-3 text-xs',
        lg: 'h-9 px-5 text-sm',
        icon: 'h-[30px] w-[30px]',
        'icon-sm': 'h-[27px] w-[27px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
