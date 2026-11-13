import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
