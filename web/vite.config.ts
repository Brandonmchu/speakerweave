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
    // One entry, one chunk. ~160 kB gzipped is well inside the TTI budget; the
    // default 500 kB warning is measuring uncompressed bytes.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
})
