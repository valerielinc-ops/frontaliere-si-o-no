// Visual regression baselines for the 3 fixed SEO page families.
// Run `npm run test:e2e:visual:update` after any intentional visual change to regenerate baselines.
import { test, expect } from 'playwright/test';

const CASES = [
  { name: 'border-wait-root', url: '/traffico-dogane/' },
  { name: 'fuel-daily-ticino', url: '/prezzi-benzina-oggi/' },
  { name: 'weekly-employers-hub', url: '/aziende-che-assumono/' },
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
