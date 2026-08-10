/**
 * Shared chrome for the two public program pages (schedule + speakers).
 *
 * Deliberately light: a public conference microsite, not the organizer app. In
 * embed mode (`?embed=1`) none of this renders — the page is chrome-less and
 * only posts its height up to the embed.js iframe.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { initialsOf, sanitizeAccent } from '@/lib/programApi'
import { cn } from '@/lib/utils'

/**
 * When embedded, measure the page and post its height to the parent so the
 * embed.js iframe can size itself. Fires on mount and whenever the content box
 * resizes (images loading, a dialog opening).
 */
export function useEmbedHeight(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const post = () => {
      const height = Math.ceil(document.documentElement.scrollHeight)
      if (height > 0) window.parent.postMessage({ type: 'dais-embed-height', height }, '*')
    }
    post()
    const observer = new ResizeObserver(post)
    observer.observe(document.documentElement)
    window.addEventListener('load', post)
    return () => {
      observer.disconnect()
      window.removeEventListener('load', post)
    }
  }, [enabled])
}

export function Avatar({
  name,
  photoUrl,
  className,
}: {
  name: string
  photoUrl: string | null
  className?: string
}) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        loading="lazy"
        className={cn('h-full w-full object-cover', className)}
      />
    )
  }
  return (
    <div
      aria-hidden
      className={cn(
        'flex h-full w-full items-center justify-center bg-primary/10 text-sm font-semibold text-primary',
        className
      )}
    >
      {initialsOf(name)}
    </div>
  )
}

/** Scope a validated ?accent=RRGGBB value to one public program page. */
export function programAccentStyle(value: string | null): CSSProperties | undefined {
  const accent = sanitizeAccent(value)
  if (!accent) return undefined

  const red = Number.parseInt(accent.slice(0, 2), 16) / 255
  const green = Number.parseInt(accent.slice(2, 4), 16) / 255
  const blue = Number.parseInt(accent.slice(4, 6), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  const delta = max - min
  let hue = 0
  if (delta) {
    if (max === red) hue = ((green - blue) / delta) % 6
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  const hsl = `${Math.round(hue)} ${Math.round(saturation * 100)}% ${Math.round(lightness * 100)}%`
  const strong = `${Math.round(hue)} ${Math.round(saturation * 100)}% ${Math.max(
    0,
    Math.round(lightness * 100) - 6
  )}%`

  return {
    '--dais-accent': `#${accent}`,
    '--primary': hsl,
    '--primary-strong': strong,
    '--ring': hsl,
  } as CSSProperties
}

/** The public microsite frame: brand mark, event name, and Schedule/Speakers tabs. */
export function ProgramShell({
  slug,
  eventName,
  active,
  accent,
  compact = false,
  children,
}: {
  slug: string
  eventName: string | null | undefined
  active: 'schedule' | 'speakers'
  accent?: string | null
  compact?: boolean
  children: ReactNode
}) {
  return (
    <div
      data-testid="public-program-page"
      data-compact={compact ? 'true' : undefined}
      className="min-h-screen bg-[#FBFBFB]"
      style={programAccentStyle(accent ?? null)}
    >
      {!compact && <header
        data-testid="program-header"
        className="sticky top-0 z-10 border-b border-border bg-card/90 backdrop-blur"
      >
        <div className="mx-auto flex w-full max-w-[1040px] items-center gap-3 px-5 py-3.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            d
          </div>
          <span className="text-sm font-semibold tracking-tight text-foreground">dais</span>
          {eventName && (
            <>
              <span className="text-border">/</span>
              <span className="truncate text-sm text-muted-foreground">{eventName}</span>
            </>
          )}
        </div>
        <div className="mx-auto flex w-full max-w-[1040px] gap-1 px-5">
          <ShellTab to={`/e/${slug}/schedule`} label="Schedule" active={active === 'schedule'} />
          <ShellTab to={`/e/${slug}/speakers`} label="Speakers" active={active === 'speakers'} />
        </div>
      </header>}
      <main
        className={cn(
          'mx-auto w-full max-w-[1040px] px-5',
          compact ? 'py-3' : 'py-8 sm:py-10'
        )}
      >
        {children}
      </main>
      <footer className="mx-auto w-full max-w-[1040px] px-5 pb-12">
        <EmbedSnippet slug={slug} widget={active} />
        <p className="mt-6 text-center text-xs text-muted-foreground">Powered by dais</p>
      </footer>
    </div>
  )
}

function ShellTab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        'border-b-2 px-1 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </Link>
  )
}

/** The copy-paste embed doc, per the brief's "Embed this" affordance. */
export function EmbedSnippet({ slug, widget }: { slug: string; widget: 'schedule' | 'speakers' }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const snippet = `<script src="${origin}/public/program/${slug}/embed.js" data-dais-event="${slug}" data-dais-widget="${widget}"></script>`
  return (
    <details className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium text-foreground">
        Embed this {widget} on your site
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Paste this where the {widget} should appear. It auto-sizes to fit.
      </p>
      <pre className="mt-2 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs text-foreground">
        <code>{snippet}</code>
      </pre>
    </details>
  )
}
