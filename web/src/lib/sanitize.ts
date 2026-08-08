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
