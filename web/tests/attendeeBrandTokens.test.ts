/**
 * Source-level guards for the attendee window's brand presets.
 *
 * These assert the stylesheet rather than the DOM on purpose: jsdom resolves
 * `var()` eagerly and has no compositor, so it cannot reproduce either failure
 * below. Both shipped once and both were invisible to every other test.
 */
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const CSS = readFile('src/styles/site-attendee.css', 'utf8')

describe('attendee window brand tokens', () => {
  // In a real engine a transitioned `background` SHORTHAND holding a var()
  // stays pending-substitution: the minified build kept painting the default
  // and every preset looked identical, while dev looked fine.
  it('transitions the canvas by longhand, never the background shorthand', async () => {
    const css = await CSS
    expect(css).toContain('background-color: var(--swp-paper)')
    expect(css).not.toMatch(/transition:[^;]*\bbackground\s+[\d.]/)
  })

  // Pin only the block of an inverted chip and a light-ink brand paints white
  // lettering onto a white pill — the exact bug the real public pages had.
  it('gives every inverted chip a paired foreground token', async () => {
    const css = await CSS
    expect(css).toContain('--swp-ink-on')
    expect(css).toContain('--swp-accent-on')
    expect(css).toMatch(/background:\s*var\(--swp-ink\);?[\s\S]{0,80}?}/)
    // No chip may hardcode white on a brand-controlled block.
    const inverted = css.match(/\.swp-(days span\.on|reg|act-p)\s*\{[^}]*\}/g) ?? []
    expect(inverted.length).toBeGreaterThan(0)
    for (const rule of inverted) expect(rule).not.toMatch(/color:\s*#fff/)
  })
})
