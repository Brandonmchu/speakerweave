import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AVATAR_GRADIENTS, GradientAvatar, avatarGradient, stableHash } from '@/ui/avatar'
import { Progress } from '@/ui/progress'

describe('redesign foundation primitives', () => {
  it('keeps a person on the same one of eight gradients', () => {
    expect(AVATAR_GRADIENTS).toHaveLength(8)
    expect(stableHash('speaker-42')).toBe(2_888_590_811)
    expect(avatarGradient('speaker-42')).toBe(AVATAR_GRADIENTS[3])
  })

  it('renders initials at the requested avatar size', () => {
    const { container } = render(<GradientAvatar id="speaker-42" name="Alex Rivera" size={28} />)
    const avatar = container.firstElementChild
    expect(avatar).toHaveTextContent('AR')
    expect(avatar).toHaveStyle({ width: '28px', height: '28px' })
  })

  it('exposes a clamped hairline progress value accessibly', () => {
    render(<Progress value={120} max={100} aria-label="Onboarding progress" />)
    expect(screen.getByRole('progressbar', { name: 'Onboarding progress' })).toHaveAttribute('aria-valuenow', '100')
  })
})
