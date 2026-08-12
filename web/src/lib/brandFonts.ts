import { useEffect } from 'react'

import type { BrandingConfig, FontToken } from '@/lib/branding'

export const BRAND_FONT_LOADERS: Record<FontToken, () => Promise<unknown>> = {
  'instrument-sans': () => import('@fontsource-variable/instrument-sans'),
  'instrument-serif': () => import('@fontsource/instrument-serif'),
  inter: () => import('@fontsource-variable/inter'),
  'space-grotesk': () => import('@fontsource-variable/space-grotesk'),
  'dm-sans': () => import('@fontsource-variable/dm-sans'),
  'ibm-plex-sans': () => import('@fontsource-variable/ibm-plex-sans'),
  figtree: () => import('@fontsource-variable/figtree'),
  'playfair-display': () => import('@fontsource-variable/playfair-display'),
  'source-serif': () => import('@fontsource-variable/source-serif-4'),
  lora: () => import('@fontsource-variable/lora'),
  'jetbrains-mono': () => import('@fontsource-variable/jetbrains-mono'),
  // IBM Plex Mono has no variable release on fontsource; the static face is the
  // only one published, so this is the single non-variable entry in the roster.
  'ibm-plex-mono': () => import('@fontsource/ibm-plex-mono'),
}

const loaded = new Set<FontToken>()

export function useBrandingFonts(branding: BrandingConfig): void {
  useEffect(() => {
    const tokens = new Set<FontToken>([branding.heading_font, branding.body_font])
    for (const token of tokens) {
      if (loaded.has(token)) continue
      loaded.add(token)
      void BRAND_FONT_LOADERS[token]().catch(() => {
        // The CSS stack already ends in a local system fallback. Let a later
        // navigation retry a transient chunk failure without delaying paint.
        loaded.delete(token)
      })
    }
  }, [branding.body_font, branding.heading_font])
}

export function useBrandingFavicon(branding: BrandingConfig): void {
  useEffect(() => {
    if (!branding.favicon_url || typeof document === 'undefined') return
    let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
    const created = !link
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    const previousHref = link.getAttribute('href')
    link.href = branding.favicon_url
    return () => {
      if (created) link?.remove()
      else if (previousHref === null) link?.removeAttribute('href')
      else link?.setAttribute('href', previousHref)
    }
  }, [branding.favicon_url])
}
