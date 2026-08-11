import { cn } from '@/lib/utils'

/**
 * The SpeakerWeave mark: an S ribbon woven through a diagonal thread —
 * over at the top crossing, under at the bottom. Ink tile version.
 * Size via className (e.g. "h-8 w-8"); the glyph scales with the tile.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground',
        className,
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" className="h-full w-full">
        <path
          d="M9.9 22.3 L13.7 18.5"
          stroke="#fff"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M19.8 12.4 L21.8 10.4"
          stroke="#fff"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M21.7 9.2c-1.1-1.2-2.8-1.9-4.7-1.9-2.9 0-5 1.6-5 3.9 0 2.1 1.5 3.2 4.3 3.9l1.3.3"
          stroke="#fff"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M20.4 16.8c1.8.6 2.7 1.5 2.7 2.9 0 2.3-2.1 3.9-5 3.9-1.9 0-3.6-.7-4.7-1.9"
          stroke="#fff"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </span>
  )
}
