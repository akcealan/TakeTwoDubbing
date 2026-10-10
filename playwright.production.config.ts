import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/production',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8790',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'npx wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8790 --persist-to .tools/production-worker-state',
    url: 'http://127.0.0.1:8790/api/health',
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
