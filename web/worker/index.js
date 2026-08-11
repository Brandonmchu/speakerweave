/**
 * Cloudflare Workers deployment of the SpeakerWeave web tier.
 *
 * Mirrors web/nginx/default.conf: static SPA from edge assets, with the
 * backend paths (/api, /public, /mcp, /oauth, OAuth well-knowns) proxied to
 * the FastAPI origin. Configure the origin with the BACKEND_URL var (scheme +
 * host, no trailing slash) — same contract as the nginx image.
 */

const BACKEND_PATH = /^\/((api|public)\/|mcp(\/|$)|oauth\/|\.well-known\/oauth-)/

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return new Response('OK', { headers: { 'content-type': 'text/plain' } })
    }

    if (BACKEND_PATH.test(url.pathname)) {
      const origin = new URL(env.BACKEND_URL)
      const upstream = new URL(url.pathname + url.search, origin)
      // Railway's edge routes by Host header; fetch() sets it from the URL.
      const proxied = new Request(upstream, request)
      proxied.headers.set('X-Forwarded-Host', url.host)
      proxied.headers.set('X-Forwarded-Proto', 'https')
      // Returning the fetch Response directly keeps SSE streaming intact.
      return fetch(proxied)
    }

    const assetResponse = await env.ASSETS.fetch(request)
    const contentType = assetResponse.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) return assetResponse

    // HTML documents: never cache (they carry the hashed asset names), and
    // keep the embed routes framable exactly like the nginx config does.
    const headers = new Headers(assetResponse.headers)
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    if (url.pathname.startsWith('/e/')) {
      headers.delete('X-Frame-Options')
      headers.set('Content-Security-Policy', 'frame-ancestors *')
    } else {
      headers.set('X-Frame-Options', 'SAMEORIGIN')
    }
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    })
  },
}
