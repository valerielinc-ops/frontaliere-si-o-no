import { test, expect } from 'playwright/test';

/**
 * E2E regression test: the calculator page (homepage) must render without
 * React runtime errors.
 *
 * Root cause (fixed): SegmentControl used `typeof icon === 'function'` to
 * detect component references vs ReactNode. lucide-react icons are
 * React.forwardRef objects (typeof 'object'), so the check fell through
 * and rendered the raw object as a React child → React#31.
 *
 * This was invisible in dev mode because Vite's HMR refresh wrapper makes
 * forwardRef components appear as functions.
 */

test.describe('Calculator page renders without errors', () => {
  test('homepage loads without React errors in console', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(3_000);

    // The segment control tabs in "Analisi Comparativa" should be visible
    const segmentButtons = page.locator('div[role="group"] button');
    await expect(segmentButtons.first()).toBeVisible({ timeout: 10_000 });

    // Icons inside segment buttons should render as SVGs, not raw text/objects
    const svgIcons = page.locator('div[role="group"] button svg');
    const iconCount = await svgIcons.count();
    expect(iconCount).toBeGreaterThanOrEqual(1);

    // No React runtime errors
    const reactErrors = errors.filter((e) => e.includes('Objects are not valid as a React child'));
    expect(reactErrors, 'React#31: forwardRef rendered as object instead of element').toHaveLength(0);
  });

  test('switching chart tabs does not produce errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(3_000);

    const segmentButtons = page.locator('div[role="group"] button');
    await expect(segmentButtons.first()).toBeVisible({ timeout: 10_000 });

    // Click each segment tab
    const count = await segmentButtons.count();
    for (let i = 0; i < count; i++) {
      await segmentButtons.nth(i).click();
      await page.waitForTimeout(500);
    }

    // No errors after switching tabs
    expect(errors).toHaveLength(0);
  });
});
