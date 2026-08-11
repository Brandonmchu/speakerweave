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
            'relative inline-flex h-auto w-full max-w-full flex-nowrap items-center justify-start gap-0 overflow-x-auto border-b border-border bg-transparent p-0 text-muted-foreground scrollbar-hide md:w-fit',
          // max-w-full is what makes overflow-x-auto engage: without a width cap
          // this inline-flex grows to its content width and overflows the
          // parent, so off-screen tabs become unreachable on narrow viewports.
          variant === 'underline' &&
            'relative inline-flex w-full max-w-full flex-nowrap items-center gap-0 overflow-x-auto border-b border-border bg-transparent p-0 scrollbar-hide',
          className
        )}
        {...props}
      >
        {children}
        {variant === 'underline' && indicator && (
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 h-px bg-foreground transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
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
        'group inline-flex items-center justify-center gap-2 whitespace-nowrap text-[13px] font-normal outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:hidden',
        variant === 'default' && [
          'cursor-pointer rounded-none border-0 px-3 py-2 text-muted-foreground',
          'hover:text-foreground',
          'data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-1px_0_hsl(var(--foreground))]',
        ],
        variant === 'underline' && [
          'cursor-pointer rounded-none border-0 bg-transparent px-3 py-2 text-muted-foreground',
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

const TabsCount = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn('font-mono text-[10.5px] font-normal tabular-nums text-placeholder group-data-[state=active]:text-foreground', className)}
      {...props}
    />
  ),
)
TabsCount.displayName = 'TabsCount'

export { Tabs, TabsList, TabsTrigger, TabsContent, TabsCount }
