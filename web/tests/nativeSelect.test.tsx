/**
 * NativeSelect is the eval-legible dropdown: a real `<select>` a blind browser
 * agent (and the competition harness) can actually drive. These tests pin the
 * two things that matter — it renders as a native `<select>` with an accessible
 * name, and a native change fires onValueChange with the chosen value.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'

describe('NativeSelect', () => {
  it('renders a real native <select> associated with its label', () => {
    render(
      <>
        <Label htmlFor="track">Track</Label>
        <NativeSelect
          id="track"
          value=""
          placeholder="Select an option"
          options={[
            { value: 'platform', label: 'Platform' },
            { value: 'ai', label: 'AI & ML' },
          ]}
        />
      </>
    )

    const select = screen.getByLabelText('Track')
    expect(select.tagName).toBe('SELECT')
    // Placeholder renders as a disabled sentinel option, real options follow.
    expect(screen.getByRole('option', { name: 'Platform' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'AI & ML' })).toBeInTheDocument()
  })

  it('fires onValueChange with the selected value', () => {
    const onValueChange = vi.fn()
    render(
      <>
        <Label htmlFor="track">Track</Label>
        <NativeSelect
          id="track"
          value=""
          placeholder="Select an option"
          onValueChange={onValueChange}
          options={[
            { value: 'platform', label: 'Platform' },
            { value: 'ai', label: 'AI & ML' },
          ]}
        />
      </>
    )

    fireEvent.change(screen.getByLabelText('Track'), { target: { value: 'ai' } })
    expect(onValueChange).toHaveBeenCalledWith('ai')
  })

  it('renders `<option>` children when no options prop is given', () => {
    render(
      <NativeSelect aria-label="Timezone" value="UTC">
        <option value="UTC">UTC</option>
        <option value="America/New_York">America/New_York</option>
      </NativeSelect>
    )

    const select = screen.getByLabelText('Timezone') as HTMLSelectElement
    expect(select.value).toBe('UTC')
    expect(screen.getByRole('option', { name: 'America/New_York' })).toBeInTheDocument()
  })

  it('can size its wrapper independently for inline filter bars', () => {
    render(
      <NativeSelect
        aria-label="Inline filter"
        wrapperClassName="w-auto"
        value="all"
        options={[{ value: 'all', label: 'All' }]}
      />
    )

    expect(screen.getByLabelText('Inline filter').parentElement).toHaveClass('relative', 'w-auto')
  })
})
