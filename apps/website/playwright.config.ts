import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/website',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4317',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm build && PATH=/Users/gautammanch/.nvm/versions/node/v24.14.1/bin:$PATH corepack pnpm start --port 4317',
    port: 4317,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
