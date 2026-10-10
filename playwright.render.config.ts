import { defineConfig } from '@playwright/test'

const verifyViteDevelopmentRuntime = process.env.PHASE8_RENDER_DEV === '1'
const frontendPort = verifyViteDevelopmentRuntime ? 5173 : 4173

export default defineConfig({
  testDir: './tests/render',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 10 * 60_000,
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: 'retain-on-failure',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: [
    {
      command:
        'npm run worker:dev -- --ip 127.0.0.1 --port 8787 --persist-to .tools/render-worker-state',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: verifyViteDevelopmentRuntime
        ? 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort --force'
        : 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
    },
  ],
})
