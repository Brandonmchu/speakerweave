import { apiGet } from '@/lib/api'

/**
 * Fetch a short-lived demo token for the shared, fully-seeded demo workspace.
 *
 * The path starts with `/public`, so `request()` sends it anonymously — no
 * Authorization header, no existing session required. Store the result with
 * `setToken()` and the existing dev-token auth path lets the app in.
 */
export async function fetchDemoToken(): Promise<string> {
  const { token } = await apiGet<{ token: string }>('/public/demo-token')
  return token
}

/** The three audiences the demo workspace can be entered as. */
export type DemoPersona = 'organizer' | 'reviewer' | 'speaker'

/**
 * How to open the demo as one persona.
 *
 * The organizer gets the same short-lived token as `fetchDemoToken`; the
 * reviewer and the speaker get a real magic link — the same one an organizer
 * would have emailed them — which the app redeems on arrival. Two shapes rather
 * than one because those two surfaces genuinely authenticate differently.
 */
export type DemoEntry =
  | { persona: DemoPersona; kind: 'token'; token: string }
  | { persona: DemoPersona; kind: 'path'; path: string }

export async function fetchDemoEntry(persona: DemoPersona): Promise<DemoEntry> {
  return apiGet<DemoEntry>(`/public/demo-entry/${persona}`)
}
