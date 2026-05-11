// Visual regression baselines for STABLE primary pages — run against the
// LIVE deployed site (post-deploy gate inside `validate-live`). When a
// regression is detected the deploy rolls back automatically: the previous
// dist (which by definition matched the baseline) is restored on Pages.
//
// Cases were chosen for their stability — pages that change visually only
// when intentional design / copy edits happen. Cron-generated pages
// (fuel-daily, weekly-employers, border-wait, AND job-board) were removed
// because their content updates daily and would produce false positives on
// every deploy. job-board renders job cards from cron crawlers that fire
// every few minutes, so the above-the-fold viewport reshuffles content
// continuously — rolling deploys back on those churn-pixel diffs is the
// opposite of what visual regression should catch.
//
// Even on "stable" pages there are inline widgets whose content rotates
// independently of code (article ticker, daily dialect phrase, weekly fact,
// achievement toast, unread-news badge, calculator result banner whose
// gradient pulses on hover). Those are masked below — masking forces those
// regions to be drawn as a solid pink rectangle in both the baseline and
// the actual screenshot, so dynamic content cannot trigger a regression.
//
// Regenerate baselines on demand via the
// `regenerate-visual-baselines.yml` workflow_dispatch (runs on Linux,
// commits *-linux.png to the repo).
import { test, expect } from 'playwright/test';

interface VisualCase {
  name: string;
  url: string;
  // Optional readiness selector. Must be visible before we screenshot —
  // ensures lazy/async-hydrated regions are mounted, not white. On
  // salary-calculator the right-side ResultsView is React-hydrated after
  // the page becomes interactive and its 'results-advantage-banner' is the
  // last element to mount; waiting for `domcontentloaded` + fonts is not
  // enough on the live env (CDN + analytics scripts slow first paint).
  readySelector?: string;
}

const CASES: VisualCase[] = [
  { name: 'home', url: '/' },
  {
    name: 'salary-calculator',
    url: '/calcola-stipendio/',
    readySelector: '[data-testid="results-advantage-banner"]',
  },
  { name: 'currency-comparator', url: '/comparatori/cambio-valuta/' },
];

// Selectors for non-deterministic widgets that auto-rotate or depend on
// time/cron data. Each must exist in the rendered DOM before the test takes
// the screenshot — keep these in sync with the data-testid attributes in
// the component sources. Missing selectors are silently ignored by mask().
const DYNAMIC_REGION_SELECTORS = [
  '[data-testid="news-ticker"]',
  '[data-testid="daily-dialect-phrase"]',
  '[data-testid="weekly-fact"]',
  '[data-testid="gamification-toast"]',
  '[data-testid="whats-new-badge"]',
  '[data-testid="results-advantage-banner"]',
];

test.use({ viewport: { width: 1280, height: 800 } });

for (const c of CASES) {
  test(`visual baseline: ${c.name}`, async ({ page }) => {
    // `networkidle` is unreliable on SPAs with analytics/polling
    // (home/calculator never settle). Use `domcontentloaded` + wait for
    // the <main> element to be attached + fonts ready, which is what
    // visual stability actually requires.
    await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });
    if (c.readySelector) {
      await page.locator(c.readySelector).first().waitFor({ state: 'visible', timeout: 20_000 });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    // Brief settle: wait for layout shift to stabilize after font load.
    await page.waitForTimeout(500);
    // Viewport-only screenshot (1280x800). Full-page / element screenshots
    // are unstable on SPA pages with lazy-loaded cards + ads auto-inject —
    // the page keeps growing taller and Playwright fails with "Failed to
    // take two consecutive stable screenshots". Visual regression on the
    // above-the-fold viewport is what actually matters for header / hero /
    // first-paint UX, which is the value visual baselines provide.
    await expect(page).toHaveScreenshot(`${c.name}.png`, {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
      mask: DYNAMIC_REGION_SELECTORS.map((sel) => page.locator(sel)),
    });
  });
}
