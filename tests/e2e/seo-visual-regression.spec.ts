// Visual regression baselines for STABLE primary pages — run against the
// LIVE deployed site (post-deploy gate inside `validate-live`). When a
// regression is detected the deploy rolls back automatically: the previous
// dist (which by definition matched the baseline) is restored on Pages.
//
// Cases were chosen for their stability — pages that change visually only
// when intentional design / copy edits happen. Cron-generated pages
// (fuel-daily, weekly-employers, border-wait) were removed because their
// content updates daily and would produce false positives on every deploy.
//
// Regenerate baselines on demand via the
// `regenerate-visual-baselines.yml` workflow_dispatch (runs on Linux,
// commits *-linux.png to the repo).
import { test, expect } from 'playwright/test';

const CASES = [
  { name: 'home', url: '/' },
  { name: 'salary-calculator', url: '/calcola-stipendio/' },
  { name: 'currency-comparator', url: '/comparatori/cambio-valuta/' },
  { name: 'job-board', url: '/cerca-lavoro-ticino/' },
];

test.use({ viewport: { width: 1280, height: 800 } });

for (const c of CASES) {
  test(`visual baseline: ${c.name}`, async ({ page }) => {
    await page.goto(c.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('main').first()).toHaveScreenshot(`${c.name}.png`, {
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    });
  });
}
