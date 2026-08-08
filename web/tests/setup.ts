import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom ships neither of these; Radix primitives and our Tabs indicator use
// them. Real browsers have had both for years.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
}

afterEach(() => {
  cleanup()
})

// Tests exercise the dev-token auth path deterministically — Clerk mode is
// env-driven and would otherwise flip on whenever a local .env holds a key.
import { vi } from 'vitest'
vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', '')
