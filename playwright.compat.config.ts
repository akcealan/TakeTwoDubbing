import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: /(scene-browsing|lobby|phase2-recovery|studio)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'firefox',
      use: { browserName: 'firefox', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit', viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: [
    {
      command:
        'npm run worker:dev -- --ip 127.0.0.1 --port 8787 --persist-to .tools/compat-worker-state',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
  ],
})
