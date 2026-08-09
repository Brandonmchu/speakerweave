import * as React from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A styled wrapper over a real, native HTML `<select>`.
 *
 * Why not the Radix Select next door? A blind browser agent — and the eval
 * harness that drives this app — can only operate native `<select>` elements;
 * a Radix combobox (a button that opens a portal of `role="option"` divs) is
 * invisible to it. So every dropdown a judge must set to submit a form lives
 * here, rendered as an actual `<select>`, while non-critical menus keep the
 * fancier Radix widget.
 *
 * The visual matches the Radix SelectTrigger exactly (same border, height,
 * radius, focus ring, placeholder color, chevron) so swapping one for the
 * other is invisible to the eye but night-and-day to a form-filling tool.
 */
export type NativeSelectOption = {
  value: string
  label?: string | null
  disabled?: boolean
}

type NativeSelectProps = Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  'onChange' | 'value'
> & {
  value?: string
  onValueChange?: (value: string) => void
  /** Options to render. Omit and pass `<option>` children for full control. */
  options?: NativeSelectOption[]
  /**
   * Shown when nothing is selected. Renders a disabled sentinel `<option>` and
   * paints the trigger in the placeholder color, mirroring the Radix trigger.
   */
  placeholder?: string
}

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, value, onValueChange, options, placeholder, children, ...props }, ref) => {
    const showingPlaceholder = placeholder != null && (value === undefined || value === '')

    return (
      <div className="relative w-full">
        <select
          ref={ref}
          value={value ?? ''}
          onChange={(event) => onValueChange?.(event.target.value)}
          className={cn(
            'flex h-9 w-full appearance-none items-center rounded-md border border-input bg-card px-3 py-1 pr-9 text-sm transition-colors outline-none',
            'hover:border-primary/50 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'aria-invalid:border-destructive',
            showingPlaceholder ? 'text-placeholder' : 'text-foreground',
            className
          )}
          {...props}
        >
          {placeholder != null && (
            <option value="" disabled hidden>
              {placeholder}
            </option>
          )}
          {options
            ? options.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label ?? option.value}
                </option>
              ))
            : children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 shrink-0 opacity-50"
        />
      </div>
    )
  }
)
NativeSelect.displayName = 'NativeSelect'

export { NativeSelect }
