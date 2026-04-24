// Visual regression baselines for the 3 fixed SEO page families.
// Baselines are OS-sensitive (darwin vs linux). Set RUN_VISUAL_REGRESSION=1
// to opt in; otherwise the suite is skipped so the default `playwright test`
// invocation stays green on machines without matching baselines.
// Regenerate baselines with: `RUN_VISUAL_REGRESSION=1 npm run test:e2e:visual:update`.
import { test, expect } from 'playwright/test';

test.skip(
  !process.env.RUN_VISUAL_REGRESSION,
  'Set RUN_VISUAL_REGRESSION=1 to run visual regression (OS-specific baselines required)',
);

const CASES = [
  { name: 'border-wait-root', url: '/traffico-dogane/' },
  { name: 'fuel-daily-ticino', url: '/prezzi-benzina/oggi/' },
  { name: 'weekly-employers-hub', url: '/aziende-che-assumono/ticino/settimana-corrente/' },
];

test.use({ viewport: { width: 1280, height: 800 } });

for (const c of CASES) {
  test(`visual baseline: ${c.name}`, async ({ page }) => {
    await page.goto(c.url, { waitUntil: 'networkidle' });
    // Freeze dynamic bits: scroll to top, wait for fonts
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('main').first()).toHaveScreenshot(`${c.name}.png`, {
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    });
  });
}
