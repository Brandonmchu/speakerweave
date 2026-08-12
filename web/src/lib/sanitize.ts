/**
 * Minimal, dependency-free HTML strip — the belt to the backend's braces.
 *
 * The server (bleach) is the authoritative sanitizer for welcome_html /
 * confirmation_html. This repeats only the highest-value subset in the browser
 * so a pre-existing unsanitized row can't fire when injected via
 * dangerouslySetInnerHTML. It is NOT a general-purpose sanitizer: do not rely on
 * it as the only line of defense.
 *
 * Removed: <script> elements (and their contents), on* event-handler
 * attributes, and javascript: URLs on href/src.
 */
export function stripUnsafeHtml(html: string): string {
  if (!html) return ''
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\/?script\b[^>]*>/gi, '')
    .replace(/\s+on[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, ' $1=$2#')
}

/**
 * Rich-text answers arrive as HTML (the public form's editor stores it), but
 * several organizer/reviewer surfaces display them as plain text — which used
 * to show literal `<p>` tags. This converts HTML to readable text: block ends
 * and <br> become newlines, tags go away, entities decode. Plain text passes
 * through unchanged. DOMParser documents are inert (nothing loads or runs).
 */
export function plainTextFromHtml(value: string): string {
  if (!value || !/[<&]/.test(value)) return value
  const withBreaks = value
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html')
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
}
