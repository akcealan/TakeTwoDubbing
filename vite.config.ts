import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg'],
    include: ['react', 'react/jsx-dev-runtime', 'react-dom/client', 'react-router-dom', 'zod'],
    noDiscovery: true,
    // Do not make initial requests wait for a cold-start crawl. The ffmpeg package must
    // stay unoptimized so its relative worker URL remains valid in real dev mode.
    holdUntilCrawlEnd: false,
  },
  server: {
    strictPort: true,
    watch: {
      // Generated local environments can contain tens of thousands of files. Watching
      // them blocks Vite's Windows event loop without contributing to frontend HMR.
      ignored: [
        '**/.tools/**',
        '**/ai/.venv*/**',
        '**/ai/.cache/**',
        '**/local-test-media/**',
        '**/.wrangler/**',
        '**/.worker-build/**',
        '**/public/runtime/**',
        '**/.ruff_cache/**',
        '**/.tmp-pytest*/**',
        '**/ai/.tmp-pytest*/**',
        '**/__pycache__/**',
        '**/.pytest_cache/**',
      ],
    },
    proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } },
  },
  preview: { proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    include: ['src/**/*.test.{ts,tsx}', 'shared/**/*.test.ts'],
  },
})
