import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '@/lib/utils'

type TabsVariant = 'default' | 'underline'

const TabsVariantContext = React.createContext<TabsVariant>('default')

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsVariant }
>(({ className, variant = 'default', children, ...props }, ref) => {
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = React.useState<{ left: number; width: number } | null>(null)

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
    },
    [ref]
  )

  // Sliding underline: measured off the active trigger's offsetLeft/offsetWidth
  // so it animates between tabs instead of just swapping color. Re-measures on
  // active-tab change (data-state mutation — Radix doesn't expose the active
  // value as a prop here) and on resize.
  React.useLayoutEffect(() => {
    if (variant !== 'underline') return
    const list = listRef.current
    if (!list) return

    const measure = () => {
      const active = list.querySelector<HTMLElement>('[data-state="active"]')
      setIndicator(active ? { left: active.offsetLeft, width: active.offsetWidth } : null)
    }

    measure()

    const mutationObserver = new MutationObserver(measure)
    mutationObserver.observe(list, { attributes: true, attributeFilter: ['data-state'], subtree: true })

    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(list)

    return () => {
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [variant, children])

  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        ref={setRefs}
        className={cn(
          variant === 'default' &&
            'inline-flex h-auto items-center justify-start gap-1 rounded-lg bg-muted p-1 text-muted-foreground w-full md:w-fit max-w-full overflow-x-auto scrollbar-hide flex-nowrap',
          // max-w-full is what makes overflow-x-auto engage: without a width cap
          // this inline-flex grows to its content width and overflows the
          // parent, so off-screen tabs become unreachable on narrow viewports.
          variant === 'underline' &&
            'relative inline-flex items-center gap-0 bg-transparent p-0 rounded-none border-b border-border w-full max-w-full overflow-x-auto scrollbar-hide flex-nowrap',
          className
        )}
        {...props}
      >
        {children}
        {variant === 'underline' && indicator && (
          <span
            aria-hidden
            className="absolute bottom-0 h-0.5 bg-primary transition-[left,width] duration-200 ease-out motion-reduce:transition-none pointer-events-none"
            style={{ left: indicator.left, width: indicator.width }}
          />
        )}
      </TabsPrimitive.List>
    </TabsVariantContext.Provider>
  )
})
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext)

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap text-sm font-medium gap-2 transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none [&_svg]:pointer-events-none [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0',
        variant === 'default' && [
          'rounded-md px-3 py-1.5 cursor-pointer',
          'border border-transparent text-muted-foreground',
          'hover:text-foreground',
          'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:border-border data-[state=active]:shadow-soft',
        ],
        variant === 'underline' && [
          'rounded-none px-4 py-2.5 cursor-pointer',
          'bg-transparent border-0 border-b-2 border-transparent text-muted-foreground',
          'hover:text-foreground',
          // The colored underline is the sliding indicator in TabsList, not a
          // per-trigger border.
          'data-[state=active]:text-foreground data-[state=active]:bg-transparent',
        ],
        className
      )}
      {...props}
    />
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('mt-4 outline-none', className)} {...props} />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
