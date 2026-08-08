import { describe, expect, it } from 'vitest'

import { stripUnsafeHtml } from '@/lib/sanitize'

describe('stripUnsafeHtml — belt to the backend sanitizer', () => {
  it('returns an empty string for empty input', () => {
    expect(stripUnsafeHtml('')).toBe('')
  })

  it('keeps benign formatting untouched', () => {
    const html = '<p>Hello <strong>there</strong></p>'
    expect(stripUnsafeHtml(html)).toBe(html)
  })

  it('removes <script> elements and their contents', () => {
    const out = stripUnsafeHtml('<p>ok</p><script>steal()</script>')
    expect(out).toBe('<p>ok</p>')
    expect(out).not.toContain('steal')
  })

  it('strips on* event-handler attributes', () => {
    const out = stripUnsafeHtml('<img src="x" onerror="alert(1)">')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('alert(1)')
  })

  it('neutralizes javascript: URLs on href', () => {
    const out = stripUnsafeHtml('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('click')
  })

  it('leaves ordinary links alone', () => {
    const html = '<a href="https://example.com" title="site">link</a>'
    expect(stripUnsafeHtml(html)).toBe(html)
  })
})
