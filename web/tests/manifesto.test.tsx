/**
 * `/manifesto` — the page that says what this believes.
 *
 * The point of a document like this is that a reader can disagree with a
 * specific line, so the tests check that the positions are stated as positions
 * (numbered, one claim each) and that every one of them ends somewhere
 * checkable rather than in adjectives.
 */
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { Manifesto } from '@/pages/Manifesto'
import { REPO_URL } from '@/pages/siteShared'

function renderManifesto() {
  return render(
    <MemoryRouter initialEntries={['/manifesto']}>
      <Manifesto />
    </MemoryRouter>
  )
}

describe('Manifesto', () => {
  it('states seven numbered positions, each with its own claim', () => {
    const { container } = renderManifesto()

    const beliefs = container.querySelectorAll('.beliefs li')
    expect(beliefs).toHaveLength(7)
    for (const belief of beliefs) {
      expect(belief.querySelector('h2')?.textContent?.length).toBeGreaterThan(10)
      expect(belief.querySelector('p')?.textContent?.length).toBeGreaterThan(80)
    }

    expect(
      screen.getByRole('heading', { name: 'The agent is a surface, not a feature' })
    ).toBeInTheDocument()
    expect(screen.getByText(/stops at a human/i)).toBeInTheDocument()
  })

  it('sends the reader somewhere they can check the claims', () => {
    const { container } = renderManifesto()

    // The footer carries the same link, so this one is scoped to the closing CTA.
    const cta = container.querySelector('.ctas') as HTMLElement
    expect(within(cta).getByRole('link', { name: /Open it as any role/i })).toHaveAttribute(
      'href',
      '/judge'
    )
    expect(screen.getByRole('link', { name: /Read the source/i })).toHaveAttribute('href', REPO_URL)
    expect(screen.getByRole('link', { name: /Connect an agent/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/ai/mcp') as unknown as string
    )
  })

  it('is reachable from the site chrome, not just by URL', () => {
    const { container } = renderManifesto()

    const footer = container.querySelector('.footlinks') as HTMLElement
    expect(within(footer).getByRole('link', { name: 'Manifesto' })).toHaveAttribute(
      'href',
      '/manifesto'
    )
    expect(within(footer).getByRole('link', { name: /Open it as any role/i })).toHaveAttribute(
      'href',
      '/judge'
    )
  })
})
