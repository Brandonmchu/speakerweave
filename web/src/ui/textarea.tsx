import * as React from 'react'

import { cn } from '@/lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  autoResize?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoResize = false, ...props }, forwardedRef) => {
    const internalRef = React.useRef<HTMLTextAreaElement>(null)

    // Stable ref callback that merges the forwarded + internal refs.
    const savedForwardedRef = React.useRef(forwardedRef)
    savedForwardedRef.current = forwardedRef

    const mergedRef = React.useCallback((node: HTMLTextAreaElement | null) => {
      internalRef.current = node
      const fRef = savedForwardedRef.current
      if (typeof fRef === 'function') fRef(node)
      else if (fRef) fRef.current = node
    }, [])

    const adjustHeight = React.useCallback(() => {
      const textarea = internalRef.current
      if (textarea && autoResize) {
        textarea.style.height = 'auto'
        textarea.style.height = `${textarea.scrollHeight}px`
      }
    }, [autoResize])

    React.useEffect(() => {
      if (autoResize) adjustHeight()
    }, [props.value, autoResize, adjustHeight])

    // Typed off the prop so it tracks React's own event type (React 19 narrowed
    // onInput from FormEvent to InputEvent).
    const handleInput: TextareaProps['onInput'] = (e) => {
      if (autoResize) adjustHeight()
      props.onInput?.(e)
    }

    return (
      <textarea
        data-slot="textarea"
        className={cn(
          'flex min-h-[104px] w-full rounded-lg border border-transparent bg-foreground/[0.045] px-3 py-2 text-[13px] text-foreground outline-none transition-[color,box-shadow,border-color,background-color] placeholder:text-placeholder disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
          'focus-visible:border-input focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15',
          'aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/15',
          autoResize ? 'resize-none overflow-hidden' : 'resize-y',
          className
        )}
        ref={mergedRef}
        {...props}
        onInput={handleInput}
      />
    )
  }
)
Textarea.displayName = 'Textarea'

export { Textarea }
