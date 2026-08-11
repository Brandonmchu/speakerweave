import type { AgentEntityType, ContextItem } from '@/agent/types'

const ICON_SVG: Record<AgentEntityType, string> = {
  event:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/></svg>',
  submission:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/><path d="M13.5 4.5 19.5 10.5M14 4l6 6M13 11l-1 4 4-1 5-5a2.1 2.1 0 0 0-3-3Z"/></svg>',
  speaker:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
  session:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 8h10M7 12h7M7 16h4"/></svg>',
  form:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/></svg>',
  content:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7h-9M14 17H5M17 12H5M3 7h2M19 17h2"/></svg>',
  contact:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
}

function isEntityType(type: string): type is AgentEntityType {
  return type in ICON_SVG
}

export function contextIconSvg(type: string): string {
  return isEntityType(type) ? ICON_SVG[type] : ICON_SVG.event
}

export function createContextToken(item: ContextItem): string {
  return JSON.stringify({ context_type: item.type, id: item.id, display: item.display })
}

export function buildContextBadgeElement(item: ContextItem): HTMLSpanElement {
  const badge = document.createElement('span')
  badge.className =
    'context-badge mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-md border border-primary/20 bg-primary-subtle px-1.5 py-0.5 align-baseline text-xs font-medium leading-5 text-primary transition-[opacity,transform] duration-150'
  badge.setAttribute('contenteditable', 'false')
  badge.setAttribute('data-context-type', item.type)
  badge.setAttribute('data-context-id', item.id)
  badge.setAttribute('data-context-display', item.display)

  const icon = document.createElement('span')
  icon.className = 'badge-icon inline-flex h-3 w-3 shrink-0 [&>svg]:h-3 [&>svg]:w-3'
  icon.innerHTML = contextIconSvg(item.type) // hardcoded trusted SVG only

  const label = document.createElement('span')
  label.className = 'badge-text truncate'
  label.textContent = item.display // entity labels are untrusted; never use innerHTML

  badge.append(icon, label)
  return badge
}

export function contextItemFromBadge(element: Element): ContextItem | null {
  const type = element.getAttribute('data-context-type')
  const id = element.getAttribute('data-context-id')
  const display = element.getAttribute('data-context-display')
  return type && id && display !== null ? { type, id, display } : null
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  if (node.classList.contains('context-badge')) {
    const item = contextItemFromBadge(node)
    return item ? createContextToken(item) : ''
  }
  if (node.tagName === 'BR') return '\n'
  const body = Array.from(node.childNodes).map(serializeNode).join('')
  return node.tagName === 'DIV' || node.tagName === 'P' ? `${body}\n` : body
}

export function serializeEditorContents(editor: HTMLElement): string {
  return Array.from(editor.childNodes).map(serializeNode).join('').replace(/\n$/, '')
}

export function contextItemsFromEditor(editor: HTMLElement): ContextItem[] {
  return Array.from(editor.querySelectorAll('.context-badge'))
    .map(contextItemFromBadge)
    .filter((item): item is ContextItem => Boolean(item))
}

export function serializeComposerMessage(
  editor: HTMLElement,
  trackedItems: ContextItem[] = contextItemsFromEditor(editor),
): string {
  const body = serializeEditorContents(editor).trim()
  const unique = new Map<string, ContextItem>()
  trackedItems.forEach((item) => unique.set(`${item.type}:${item.id}`, item))
  if (unique.size === 0) return body
  const tokens = [...unique.values()].map(createContextToken).join(' ')
  return `Context: ${tokens}\n\nUser: ${body}`
}

export interface ParsedContextToken {
  item: ContextItem
  raw: string
  startIndex: number
  endIndex: number
}

/**
 * Entity wire objects are JSON embedded directly in prose. This scanner keeps
 * the same key contract while also accepting escaped quotes in display text,
 * which a flat `[^\"]*` regex cannot round-trip safely.
 */
export function parseContextTokens(text: string): ParsedContextToken[] {
  const matches: ParsedContextToken[] = []
  const startPattern = /\{\s*"context_type"\s*:/g
  let startMatch: RegExpExecArray | null
  while ((startMatch = startPattern.exec(text))) {
    const start = startMatch.index
    let inString = false
    let escaped = false
    let depth = 0
    let end = -1
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{') depth += 1
      else if (character === '}' && --depth === 0) {
        end = index + 1
        break
      }
    }
    if (end === -1) continue
    const raw = text.slice(start, end)
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      if (
        typeof value.context_type === 'string' &&
        typeof value.id === 'string' &&
        typeof value.display === 'string'
      ) {
        matches.push({
          item: { type: value.context_type, id: value.id, display: value.display },
          raw,
          startIndex: start,
          endIndex: end,
        })
        startPattern.lastIndex = end
      }
    } catch {
      // Model prose can contain arbitrary braces; only valid context objects count.
    }
  }
  return matches
}

export function stripContextHeader(message: string): {
  content: string
  contexts: ContextItem[]
} {
  if (!message.startsWith('Context: ')) return { content: message, contexts: [] }
  const separator = message.indexOf('\n\nUser: ')
  if (separator === -1) return { content: message, contexts: [] }
  const contexts = parseContextTokens(message.slice('Context: '.length, separator)).map(
    ({ item }) => item,
  )
  return { content: message.slice(separator + '\n\nUser: '.length), contexts }
}

export function insertContextBadge(
  editor: HTMLElement,
  absoluteAtOffset: number,
  queryLength: number,
  item: ContextItem,
): boolean {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let currentOffset = 0
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    const localStart = absoluteAtOffset - currentOffset
    const localEnd = localStart + queryLength + 1
    if (localStart >= 0 && localEnd <= length) {
      const text = node.textContent ?? ''
      const badge = buildContextBadgeElement(item)
      const fragment = document.createDocumentFragment()
      if (localStart > 0) fragment.append(document.createTextNode(text.slice(0, localStart)))
      fragment.append(badge, document.createTextNode(` ${text.slice(localEnd)}`))
      node.parentNode?.replaceChild(fragment, node)
      setTimeout(() => {
        const selection = window.getSelection()
        const trailing = badge.nextSibling
        if (!selection || !trailing) return
        const range = document.createRange()
        range.setStart(trailing, Math.min(1, trailing.textContent?.length ?? 0))
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        editor.focus()
      }, 0)
      return true
    }
    currentOffset += length
    node = walker.nextNode()
  }
  return false
}
