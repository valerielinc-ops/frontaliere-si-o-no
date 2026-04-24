import { test, expect } from 'playwright/test';
import { contrastRatio } from './helpers/contrast';

test.describe('Border-wait hero card', () => {
  test('hero or fluid-traffic banner renders with WCAG AA contrast', async ({ page }) => {
    await page.goto('/traffico-dogane/', { waitUntil: 'networkidle' });

    const banner = page.locator('main >> css=[style*="--color-success-subtle"]').first();
    await expect(banner).toBeVisible();

    const bg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Grab the strongest-weight text inside the banner
    const strong = banner.locator('strong, [style*="font-weight:600"]').first();
    const fg = await strong.evaluate((el) => getComputedStyle(el).color);

    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test('hero card vertical padding is within expected range (not collapsed)', async ({ page }) => {
    await page.goto('/traffico-dogane/', { waitUntil: 'networkidle' });
    const banner = page.locator('main >> css=[style*="--color-success-subtle"]').first();
    const box = await banner.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height, 'banner height').toBeGreaterThanOrEqual(44);
    expect(box!.height, 'banner should not be huge either').toBeLessThanOrEqual(160);
  });
});

test.describe('Fuel daily sparkline shape', () => {
  test('chart is not squashed — bounding box aspect ratio <= 4:1', async ({ page }) => {
    // Pick a URL known to ship after build
    await page.goto('/prezzi-benzina/oggi/', { waitUntil: 'networkidle' });
    const svg = page.locator('svg[role="img"][aria-label*="prezzo"], svg[role="img"][aria-label*="price"]').first();
    if (await svg.count() === 0) test.skip(true, 'No chart on this page — skipping');
    const box = await svg.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width / box!.height, 'chart aspect ratio').toBeLessThanOrEqual(4);
    expect(box!.height, 'chart height').toBeGreaterThanOrEqual(160);
  });
});
