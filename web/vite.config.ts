/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Adapted from every-react/vite.config.ts. Deliberately dropped: the multi-page
// dev rewriter, versionFilePlugin and the service-worker eviction guard — dais
// ships one HTML entry and no service worker.
const BACKEND_TARGET = process.env.VITE_API_TARGET || 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // react-router/react-router-dom must be deduped alongside react. Without
    // them, dev-mode pre-bundling can split the router into separate chunks
    // with their own context instances, so any useNavigate() under the app
    // Router throws "useNavigate outside Router" and dev crashes to the error
    // boundary. Prod builds are unaffected (Rollup dedupes fine).
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react-router', 'react-router-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime', 'react-router', 'react-router-dom'],
  },
  server: {
    host: true,
    port: parseInt(process.env.VITE_DEV_PORT || '5173'),
    proxy: {
      // Everything goes through the FastAPI backend — no direct DB access from
      // the browser. `/api` is the authed surface, `/public` the anonymous one
      // (CFP forms, public agenda).
      '/api': { target: BACKEND_TARGET, changeOrigin: true, secure: false },
      '/public': { target: BACKEND_TARGET, changeOrigin: true, secure: false },
    },
  },
  build: {
    minify: 'esbuild',
    cssMinify: true,
    // Organizer-only routes load on demand; keep a warning aligned with the
    // public entry-chunk budget so accidental eager imports are visible.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/react-router/') ||
            id.includes('/node_modules/react-router-dom/') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'framework'
          }
          if (id.includes('/node_modules/@clerk/') || id.includes('/node_modules/swr/')) {
            return 'auth'
          }
          if (id.includes('/node_modules/@tanstack/')) return 'query'
          if (
            id.includes('/node_modules/react-markdown/') ||
            id.includes('/node_modules/remark-gfm/') ||
            id.includes('/node_modules/rehype-raw/') ||
            id.includes('/node_modules/rehype-sanitize/')
          ) {
            return 'markdown'
          }
          if (id.includes('/node_modules/@dnd-kit/')) return 'dnd'

          // Do not collapse every remaining dependency into a global vendor/UI
          // chunk. Rollup can then keep dnd-kit, Markdown and route-specific
          // Radix primitives behind the dynamic import that actually needs them.
          return undefined
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
})
