import type { CSSProperties } from 'react'

export const FONT_TOKENS = [
  'instrument-sans',
  'instrument-serif',
  'inter',
  'space-grotesk',
  'dm-sans',
  'ibm-plex-sans',
  'figtree',
  'playfair-display',
  'source-serif',
  'lora',
  'jetbrains-mono',
  'ibm-plex-mono',
] as const

export type FontToken = (typeof FONT_TOKENS)[number]
export type RadiusToken = 'none' | 'small' | 'medium' | 'large'
export type ScheduleLayout = 'list' | 'tracks' | 'grid'
export type SpeakerLayout = 'grid' | 'list'
export type BrandingDensity = 'comfortable' | 'compact'
export type HeaderStyle = 'minimal' | 'banner'

export interface BrandingConfig {
  accent: string | null
  background: string | null
  surface: string | null
  ink: string | null
  heading_font: FontToken
  body_font: FontToken
  radius: RadiusToken
  schedule_layout: ScheduleLayout
  speaker_layout: SpeakerLayout
  density: BrandingDensity
  header_style: HeaderStyle
  logo_url: string | null
  logo_path: string | null
  favicon_url: string | null
  favicon_path: string | null
  show_powered_by: boolean
}

export const DEFAULT_BRANDING: BrandingConfig = {
  accent: null,
  background: null,
  surface: null,
  ink: null,
  heading_font: 'instrument-serif',
  body_font: 'instrument-sans',
  radius: 'medium',
  schedule_layout: 'list',
  speaker_layout: 'grid',
  density: 'comfortable',
  header_style: 'minimal',
  logo_url: null,
  logo_path: null,
  favicon_url: null,
  favicon_path: null,
  show_powered_by: true,
}

export const FONT_LABELS: Record<FontToken, string> = {
  'instrument-sans': 'Instrument Sans',
  'instrument-serif': 'Instrument Serif',
  inter: 'Inter',
  'space-grotesk': 'Space Grotesk',
  'dm-sans': 'DM Sans',
  'ibm-plex-sans': 'IBM Plex Sans',
  figtree: 'Figtree',
  'playfair-display': 'Playfair Display',
  'source-serif': 'Source Serif',
  lora: 'Lora',
  'jetbrains-mono': 'JetBrains Mono',
  'ibm-plex-mono': 'IBM Plex Mono',
}

const FONT_STACKS: Record<FontToken, string> = {
  'instrument-sans': "'Instrument Sans Variable', 'Instrument Sans', system-ui, sans-serif",
  'instrument-serif': "'Instrument Serif', Georgia, serif",
  inter: "'Inter Variable', Inter, system-ui, sans-serif",
  'space-grotesk': "'Space Grotesk Variable', 'Space Grotesk', system-ui, sans-serif",
  'dm-sans': "'DM Sans Variable', 'DM Sans', system-ui, sans-serif",
  'ibm-plex-sans': "'IBM Plex Sans Variable', 'IBM Plex Sans', system-ui, sans-serif",
  figtree: "'Figtree Variable', Figtree, system-ui, sans-serif",
  'playfair-display': "'Playfair Display Variable', 'Playfair Display', Georgia, serif",
  'source-serif': "'Source Serif 4 Variable', 'Source Serif 4', Georgia, serif",
  lora: "'Lora Variable', Lora, Georgia, serif",
  'jetbrains-mono': "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
  'ibm-plex-mono': "'IBM Plex Mono', ui-monospace, monospace",
}

const RADIUS_VALUES: readonly RadiusToken[] = ['none', 'small', 'medium', 'large']
const SCHEDULE_LAYOUTS: readonly ScheduleLayout[] = ['list', 'tracks', 'grid']
const SPEAKER_LAYOUTS: readonly SpeakerLayout[] = ['grid', 'list']
const DENSITIES: readonly BrandingDensity[] = ['comfortable', 'compact']
const HEADER_STYLES: readonly HeaderStyle[] = ['minimal', 'banner']
const HEX_RE = /^[0-9a-fA-F]{6}$/
const DEFAULT_ACCENT = 'a85e3e'
const DEFAULT_BACKGROUND = 'f7f5f1'
const DEFAULT_SURFACE = 'fffdfb'
const DARK_INK = '1c1a17'
const WHITE = 'ffffff'

function recordOf(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function colorValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^#/, '')
  return HEX_RE.test(normalized) ? normalized.toLowerCase() : null
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function sanitizeBranding(raw: unknown): BrandingConfig {
  const value = recordOf(raw)
  return {
    accent: colorValue(value.accent),
    background: colorValue(value.background),
    surface: colorValue(value.surface),
    ink: colorValue(value.ink),
    heading_font: enumValue(value.heading_font, FONT_TOKENS, DEFAULT_BRANDING.heading_font),
    body_font: enumValue(value.body_font, FONT_TOKENS, DEFAULT_BRANDING.body_font),
    radius: enumValue(value.radius, RADIUS_VALUES, DEFAULT_BRANDING.radius),
    schedule_layout: enumValue(
      value.schedule_layout,
      SCHEDULE_LAYOUTS,
      DEFAULT_BRANDING.schedule_layout
    ),
    speaker_layout: enumValue(
      value.speaker_layout,
      SPEAKER_LAYOUTS,
      DEFAULT_BRANDING.speaker_layout
    ),
    density: enumValue(value.density, DENSITIES, DEFAULT_BRANDING.density),
    header_style: enumValue(value.header_style, HEADER_STYLES, DEFAULT_BRANDING.header_style),
    logo_url: stringOrNull(value.logo_url),
    logo_path: stringOrNull(value.logo_path),
    favicon_url: stringOrNull(value.favicon_url),
    favicon_path: stringOrNull(value.favicon_path),
    show_powered_by:
      typeof value.show_powered_by === 'boolean'
        ? value.show_powered_by
        : DEFAULT_BRANDING.show_powered_by,
  }
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ]
}

function linearChannel(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const [red, green, blue] = rgb(hex)
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue)
}

export function contrastRatio(first: string, second: string): number {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second))
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second))
  return (light + 0.05) / (dark + 0.05)
}

export function contrastForeground(background: string): string {
  return contrastRatio(background, DARK_INK) >= contrastRatio(background, WHITE) ? DARK_INK : WHITE
}

function readableInk(background: string, requested: string | null): string {
  if (requested && contrastRatio(background, requested) >= 4.5) return requested
  return contrastForeground(background)
}

function hslParts(hex: string): { h: number; s: number; l: number } {
  const [r8, g8, b8] = rgb(hex)
  const red = r8 / 255
  const green = g8 / 255
  const blue = b8 / 255
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
  return { h: Math.round(hue), s: Math.round(saturation * 100), l: Math.round(lightness * 100) }
}

function hsl(hex: string, lightnessOffset = 0): string {
  const value = hslParts(hex)
  return `${value.h} ${value.s}% ${Math.min(100, Math.max(0, value.l + lightnessOffset))}%`
}

const RADIUS_CSS: Record<RadiusToken, string> = {
  none: '0rem',
  small: '0.25rem',
  medium: '0.5rem',
  large: '1rem',
}

export function brandingStyle(
  branding: BrandingConfig,
  overrides: Partial<BrandingConfig> = {}
): CSSProperties {
  const resolved = sanitizeBranding({ ...branding, ...overrides })
  const accent = resolved.accent ?? DEFAULT_ACCENT
  const background = resolved.background ?? DEFAULT_BACKGROUND
  const surface = resolved.surface ?? DEFAULT_SURFACE
  const style: Record<string, string> = {
    '--dais-accent': `#${accent}`,
    '--primary': hsl(accent),
    '--primary-strong': hsl(accent, -6),
    '--primary-subtle': `${hslParts(accent).h} ${Math.min(hslParts(accent).s, 40)}% 92%`,
    '--primary-foreground': hsl(contrastForeground(accent)),
    '--ring': hsl(accent),
    '--radius': RADIUS_CSS[resolved.radius],
    '--brand-heading-font': FONT_STACKS[resolved.heading_font],
    '--brand-body-font': FONT_STACKS[resolved.body_font],
  }

  if (resolved.background) style['--background'] = hsl(resolved.background)
  if (resolved.surface) style['--card'] = hsl(resolved.surface)
  if (resolved.ink || resolved.background) style['--foreground'] = hsl(readableInk(background, resolved.ink))
  if (resolved.ink || resolved.surface) style['--card-foreground'] = hsl(readableInk(surface, resolved.ink))

  // The neutrals in theme.css are the DEFAULT ink at low alpha — dark grey text
  // and near-black hairlines that assume a paper canvas. An event that picks a
  // dark background flips --foreground to white but would keep those, leaving
  // `text-muted-foreground` (the most-used class on these pages) and
  // `border-border` invisible against it. Re-derive the family from the ink
  // that actually won, so it composites correctly over any canvas. Emitted only
  // when the organizer customized the canvas: an unbranded event keeps the
  // hand-tuned palette exactly as it is.
  if (resolved.background || resolved.surface || resolved.ink) {
    const inkParts = hslParts(readableInk(background, resolved.ink))
    const inkHsl = (alpha: number) => `${inkParts.h} ${inkParts.s}% ${inkParts.l}% / ${alpha}`
    style['--muted-foreground'] = inkHsl(0.68)
    style['--placeholder-foreground'] = inkHsl(0.45)
    style['--border'] = inkHsl(0.14)
    style['--input'] = inkHsl(0.24)
    style['--muted'] = inkHsl(0.06)
    style['--secondary'] = inkHsl(0.06)
    style['--secondary-foreground'] = inkHsl(0.78)
    style['--accent'] = inkHsl(0.06)
    style['--accent-foreground'] = inkHsl(1)
  }

  return style as CSSProperties
}
