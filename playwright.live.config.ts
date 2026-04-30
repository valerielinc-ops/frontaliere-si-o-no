import { defineConfig, devices } from 'playwright/test';

/**
 * Playwright config for LIVE post-deploy rendering checks against
 * `https://frontaliereticino.ch` (or whatever `LIVE_BASE_URL` points at).
 *
 * Differences vs the default `playwright.config.ts`:
 *   - No `webServer` block — we never start vite preview here. The site under
 *     test is the deployed production endpoint.
 *   - No `baseURL` — every spec uses absolute URLs derived from `LIVE_BASE_URL`
 *     so accidental relative-path routes can't silently fall back to localhost.
 *   - Single retry in CI because Fastly edge caches can briefly serve mixed
 *     versions during CDN propagation; one retry absorbs the flap window.
 *   - `testMatch` is narrowly scoped to `*-live.spec.ts` so a future generic
 *     `playwright test` against this config can't accidentally bring in
 *     local-preview specs that expect `localhost:4173`.
 *
 * Wired into deploy.yml after `wait-for-pages-propagation.mjs` so the deploy
 * fails if the freshly published HTML regresses on the rendering invariants
 * documented in `tests/e2e/post-deploy-rendering-live.spec.ts`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*-live\.spec\.ts$/,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
