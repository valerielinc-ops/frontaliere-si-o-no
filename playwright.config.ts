import { defineConfig, devices } from 'playwright/test';

// When LIVE_BASE_URL is set (validate-live step), tests hit the deployed
// site directly — no local preview server. Otherwise default to local
// `vite preview` for dev / dist e2e.
const liveBaseURL = process.env.LIVE_BASE_URL;
const baseURL = liveBaseURL || 'http://localhost:4173';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Only spin up the local preview when targeting localhost.
  ...(liveBaseURL
    ? {}
    : {
        webServer: {
          command: 'npx vite preview --port 4173',
          port: 4173,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
      }),
});
