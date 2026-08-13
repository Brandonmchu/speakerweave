import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInput } from '@/agent/components/ChatInput'

const searchAgentContext = vi.fn()

vi.mock('@/agent/lib/agentApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/lib/agentApi')>()
  return {
    ...actual,
    searchAgentContext: (...args: unknown[]) => searchAgentContext(...args),
  }
})

function openAtMode(editor: HTMLElement) {
  editor.focus()
  document.execCommand?.('insertText', false, '@')
  if (!editor.textContent) {
    // jsdom has no execCommand: emulate the keystroke by mutating the DOM
    // and dispatching input, which is what the browser produces.
    editor.textContent = '@'
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  fireEvent.input(editor)
}

function typeInEditor(editor: HTMLElement, text: string) {
  editor.textContent = text
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
  fireEvent.input(editor)
}

describe('scoped @ context search', () => {
  beforeEach(() => {
    searchAgentContext.mockReset()
    searchAgentContext.mockResolvedValue([
      { type: 'speaker', id: 's-1', display: 'Yuki Tanaka', sublabel: 'PixelMind' },
    ])
  })

  it('lists the category as soon as it is picked, with no query typed', async () => {
    render(
      <ChatInput onSend={() => {}} onCancel={() => {}} onRequestClose={() => {}} streaming={false} />,
    )
    const editor = screen.getByRole('textbox')
    openAtMode(editor)

    const speakersRow = await screen.findByRole('option', { name: /Speakers/ })
    fireEvent.mouseDown(speakersRow)
    fireEvent.click(speakersRow)

    await waitFor(() =>
      expect(searchAgentContext).toHaveBeenCalledWith('', 'speaker', expect.anything()),
    )
    expect(await screen.findByText('Yuki Tanaka')).toBeInTheDocument()
    expect(screen.queryByText(/Type at least/)).not.toBeInTheDocument()
  })

  it('inserts the badge when the query was typed in the dropdown, not the editor', async () => {
    render(
      <ChatInput onSend={() => {}} onCancel={() => {}} onRequestClose={() => {}} streaming={false} />,
    )
    const editor = screen.getByRole('textbox')
    openAtMode(editor)

    const speakersRow = await screen.findByRole('option', { name: /Speakers/ })
    fireEvent.mouseDown(speakersRow)
    fireEvent.click(speakersRow)

    // Typing here never reaches the editor, which still holds a bare "@".
    const search = await screen.findByPlaceholderText(/Search speakers/)
    fireEvent.change(search, { target: { value: 'yuki' } })

    const hit = await screen.findByRole('option', { name: /Yuki Tanaka/ })
    fireEvent.mouseDown(hit)
    fireEvent.click(hit)

    await waitFor(() => expect(editor.querySelector('.context-badge')).not.toBeNull())
    expect(editor.querySelector('.context-badge')?.getAttribute('data-context-id')).toBe('s-1')
    expect(editor.textContent).not.toContain('@')
  })

  it('searches within the drilled-in category when typing in the dropdown input', async () => {
    render(
      <ChatInput onSend={() => {}} onCancel={() => {}} onRequestClose={() => {}} streaming={false} />,
    )
    const editor = screen.getByRole('textbox')
    openAtMode(editor)

    const speakersRow = await screen.findByRole('option', { name: /Speakers/ })
    fireEvent.mouseDown(speakersRow)
    fireEvent.click(speakersRow)

    const search = await screen.findByPlaceholderText(/Search speakers/)
    fireEvent.change(search, { target: { value: 'yuki' } })

    await waitFor(
      () => expect(searchAgentContext).toHaveBeenCalledWith('yuki', 'speaker', expect.anything()),
      { timeout: 2000 },
    )
    expect(await screen.findByText('Yuki Tanaka')).toBeInTheDocument()
  })

  it('keeps editor keystrokes flowing into the scoped query after drill-in', async () => {
    render(
      <ChatInput onSend={() => {}} onCancel={() => {}} onRequestClose={() => {}} streaming={false} />,
    )
    const editor = screen.getByRole('textbox')
    openAtMode(editor)

    const speakersRow = await screen.findByRole('option', { name: /Speakers/ })
    fireEvent.mouseDown(speakersRow)
    fireEvent.click(speakersRow)

    // The category click keeps focus in the editor (mousedown is prevented);
    // continue typing there the way a fast user does.
    typeInEditor(editor, '@yu')

    await waitFor(
      () => expect(searchAgentContext).toHaveBeenCalledWith('yu', 'speaker', expect.anything()),
      { timeout: 2000 },
    )
  })
})
