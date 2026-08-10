import { describe, expect, it } from 'vitest'

import {
  buildContextBadgeElement,
  parseContextTokens,
  serializeComposerMessage,
  stripContextHeader,
} from '@/agent/components/contextBadge'

describe('agent context tokens', () => {
  it('round-trips a safe composer badge through the Every wire format', () => {
    const display = '\"><img src=x onerror=alert(1)> "quoted" proposal'
    const editor = document.createElement('div')
    editor.append(
      document.createTextNode('Compare '),
      buildContextBadgeElement({ type: 'submission', id: 'sub-17', display }),
      document.createTextNode(' with the accepted set.'),
    )

    const badge = editor.querySelector('.context-badge')!
    expect(badge.querySelector('img')).toBeNull()
    expect(badge.querySelector('.badge-text')).toHaveTextContent(display)

    const serialized = serializeComposerMessage(editor)
    const header = stripContextHeader(serialized)
    expect(header.contexts).toEqual([{ type: 'submission', id: 'sub-17', display }])
    expect(header.content).toContain('Compare ')

    const bodyTokens = parseContextTokens(header.content)
    expect(bodyTokens).toHaveLength(1)
    expect(bodyTokens[0].item).toEqual({ type: 'submission', id: 'sub-17', display })
  })

  it('deduplicates repeated context chips in the Context header', () => {
    const item = { type: 'speaker' as const, id: 'person-4', display: 'Rina <Lead>' }
    const editor = document.createElement('div')
    editor.append(buildContextBadgeElement(item), document.createTextNode(' and '), buildContextBadgeElement(item))
    const serialized = serializeComposerMessage(editor)
    expect(stripContextHeader(serialized).contexts).toEqual([item])
    expect(parseContextTokens(stripContextHeader(serialized).content)).toHaveLength(2)
  })
})

