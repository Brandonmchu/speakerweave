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
  // A property whose value is a var() does not re-resolve when only that custom
  // property changes while a transition is declared on it — shorthand OR
  // longhand. The minified build kept painting the default white and every
  // preset looked identical; dev looked fine, which is how it reached prod.
  // So: nothing brand-controlled may sit behind a background transition.
  it('never transitions a background whose value is a brand token', async () => {
    const css = await CSS
    expect(css).toContain('background-color: var(--swp-paper)')
    expect(css).not.toMatch(/transition:[^;]*background/)
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
