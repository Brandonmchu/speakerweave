/**
 * Shared chrome for the two public program pages (schedule + speakers).
 *
 * Deliberately light: a public conference microsite, not the organizer app. In
 * embed mode (`?embed=1`) none of this renders — the page is chrome-less and
 * only posts its height up to the embed.js iframe.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { BrandMark } from '@/ui/brand'
import { Link } from 'react-router-dom'

import {
  DEFAULT_BRANDING,
  brandingStyle,
  sanitizeBranding,
  type BrandingConfig,
} from '@/lib/branding'
import { initialsOf, sanitizeAccent } from '@/lib/programApi'
import { cn } from '@/lib/utils'
import { avatarGradient } from '@/ui/avatar'

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
  id,
  name,
  photoUrl,
  className,
}: {
  id?: string | null
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
  const [start, end] = avatarGradient(id || name)
  return (
    <div
      aria-hidden
      className={cn(
        'flex h-full w-full items-center justify-center text-sm font-semibold text-white',
        className
      )}
      style={{ backgroundImage: `linear-gradient(145deg, ${start}, ${end})` }}
    >
      {initialsOf(name)}
    </div>
  )
}

/** Scope URL accent > stored event branding > product defaults to one page. */
export function programAccentStyle(
  value: string | null,
  storedBranding?: BrandingConfig
): CSSProperties | undefined {
  const accent = sanitizeAccent(value)
  if (!storedBranding && !accent) return undefined
  return brandingStyle(storedBranding ?? DEFAULT_BRANDING, accent ? { accent } : undefined)
}

/** The public microsite frame: brand mark, event name, and Schedule/Speakers tabs. */
export function ProgramShell({
  slug,
  eventName,
  active,
  accent,
  branding,
  compact = false,
  children,
}: {
  slug: string
  eventName: string | null | undefined
  active: 'schedule' | 'speakers'
  accent?: string | null
  branding?: unknown
  compact?: boolean
  children: ReactNode
}) {
  const resolvedBranding = sanitizeBranding(branding)
  const banner = resolvedBranding.header_style === 'banner'

  return (
    <div
      data-testid="public-program-page"
      data-branding-root
      data-compact={compact ? 'true' : undefined}
      className="min-h-[100dvh] bg-background text-foreground"
      style={programAccentStyle(accent ?? null, resolvedBranding)}
    >
      {!compact && <header
        data-testid="program-header"
        className="border-b border-border bg-card"
      >
        <div
          className={cn(
            'mx-auto flex w-full max-w-[1280px] px-5 sm:px-14',
            banner ? 'flex-col items-start gap-4 py-8 sm:py-12' : 'items-center gap-3 py-4'
          )}
        >
          {resolvedBranding.logo_url ? (
            <img
              src={resolvedBranding.logo_url}
              alt={eventName || 'Event'}
              className={cn('max-w-full object-contain object-left', banner ? 'h-16 sm:h-20' : 'h-7 w-auto')}
            />
          ) : (
            <>
              <BrandMark className={banner ? 'h-8 w-8' : 'h-5 w-5'} />
              {!banner && (
                <span className="text-[13px] font-medium tracking-tight text-foreground">SpeakerWeave</span>
              )}
            </>
          )}
          {banner ? (
            eventName && (
              <h1 className="text-3xl font-normal leading-tight tracking-tight text-foreground sm:text-5xl">
                {eventName}
              </h1>
            )
          ) : eventName ? (
            <>
              {!resolvedBranding.logo_url && <span className="text-border">/</span>}
              <span className="truncate text-[13px] text-muted-foreground">{eventName}</span>
            </>
          ) : null}
        </div>
        <div className="mx-auto flex w-full max-w-[1280px] gap-5 px-5 sm:px-14">
          <ShellTab to={`/e/${slug}/schedule`} label="Schedule" active={active === 'schedule'} />
          <ShellTab to={`/e/${slug}/speakers`} label="Speakers" active={active === 'speakers'} />
        </div>
      </header>}
      <main
        className={cn(
          'mx-auto w-full max-w-[1280px] px-5 sm:px-14',
          compact ? 'py-3' : 'py-10 sm:py-11'
        )}
      >
        {children}
      </main>
      <footer className="mx-auto w-full max-w-[1280px] px-5 pb-12 sm:px-14">
        <EmbedSnippet slug={slug} widget={active} />
        {resolvedBranding.show_powered_by && (
          <p className="mt-5 border-t border-border pt-4 text-[11px] text-placeholder">
            Powered by SpeakerWeave
          </p>
        )}
      </footer>
    </div>
  )
}

function ShellTab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        'border-b px-0 py-2.5 text-[12.5px] font-normal transition-colors',
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
    <details className="text-[12.5px] text-muted-foreground">
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
