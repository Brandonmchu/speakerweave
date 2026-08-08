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
