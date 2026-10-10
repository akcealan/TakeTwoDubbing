import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/render',
  testMatch: /phase9-real\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 10 * 60_000,
  use: {
    baseURL: 'http://127.0.0.1:8790',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'npx wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8790 --persist-to .tools/production-render-worker-state',
    url: 'http://127.0.0.1:8790/api/health',
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
