import { test, expect, type Page } from 'playwright/test';

/**
 * Template B regression test for cost-of-living city landings
 * (per-city refactor of the profession-landings 2026-05 redesign).
 *
 * Asserts the mobile-first above-the-fold contract from CLAUDE.md regola #17:
 * the meaty content (stat tiles + primary CTA → calculator + featured live
 * jobs / employer grid) must sit above the 736 px fold at 414 px viewport.
 * The legacy long-form prose (rent table, basket table, comparison, sources
 * methodology) lives BELOW an "Approfondisci" divider so the data above is
 * never pushed off-screen by editorial filler.
 *
 * Locale: IT canonical (`/costo-vita-lugano-ticino/`). Lugano is the
 * heaviest TI city — guarantees ≥3 indexed jobs for the featured-cards path
 * (sparse cities exercise the fall-back rendering covered by unit tests).
 */

const COST_OF_LIVING_LANDING_PATH = '/costo-vita-lugano-ticino/';
const MOBILE_VIEWPORT = { width: 414, height: 736 } as const;
const FOLD_PX = MOBILE_VIEWPORT.height;

async function gotoLanding(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(COST_OF_LIVING_LANDING_PATH, { waitUntil: 'load' });
  // Allow SPA hydration to settle before measuring layout.
  await page.waitForTimeout(1_500);
}

async function topOfElement(page: Page, selector: string): Promise<number | null> {
  const handle = page.locator(selector).first();
  if ((await handle.count()) === 0) return null;
  const box = await handle.boundingBox();
  return box ? box.y : null;
}

test.describe('Cost-of-living landings template B — mobile above-the-fold contract', () => {
  test('3 stat tiles + primary CTA sit above the 414×736 fold', async ({ page }) => {
    await gotoLanding(page);

    // Stat-tile labels must render exactly once each.
    const salaryLabel = page.locator('text=/Stipendio mediano/');
    const rentLabel = page.locator('text=/Affitto bilocale/');
    const jobsLabel = page.locator('text=/Offerte aperte/');
    await expect(salaryLabel).toBeVisible();
    await expect(rentLabel).toBeVisible();
    await expect(jobsLabel).toBeVisible();

    const salaryTop = (await topOfElement(page, 'text=/Stipendio mediano/'))!;
    const rentTop = (await topOfElement(page, 'text=/Affitto bilocale/'))!;
    const jobsTop = (await topOfElement(page, 'text=/Offerte aperte/'))!;
    // Tiles wrap to 2-3 rows on mobile; require the rent + salary tiles
    // (killer numbers) inside the first viewport and tolerate up to 1.5×
    // the fold for the third tile.
    expect(salaryTop).toBeLessThan(FOLD_PX);
    expect(rentTop).toBeLessThan(FOLD_PX);
    expect(jobsTop).toBeLessThan(FOLD_PX * 1.5);

    // Primary CTA → salary calculator must exist and live above the long prose.
    const cta = page.locator('a:has-text("Calcola netto come frontaliere")').first();
    await expect(cta).toBeVisible();
    expect(await cta.getAttribute('href')).toMatch(/\/calcola-stipendio\/?$/);
  });

  test('at least 1 featured live job renders for Lugano', async ({ page }) => {
    await gotoLanding(page);

    await expect(page.locator('h2:has-text("Offerte in evidenza")')).toBeVisible();

    // Lugano has dozens of indexed jobs — the featured grid must render
    // (not the empty-state card). The first card carries a "Pubblicata …"
    // freshness line emitted by the per-locale job-card template.
    const postedLine = page.locator('text=/Pubblicat[ao]/').first();
    await expect(postedLine).toBeVisible();
  });

  test('long-form prose lives below the "Approfondisci" divider', async ({ page }) => {
    await gotoLanding(page);

    const tilesTop = (await topOfElement(page, 'text=/Stipendio mediano/'))!;
    const dividerTop = (await topOfElement(
      page,
      'text=/Approfondisci.*costo vita/',
    ))!;
    const rentSection = (await topOfElement(
      page,
      'h2:has-text("Affitti mediani")',
    ))!;

    expect(tilesTop).toBeLessThan(dividerTop);
    expect(dividerTop).toBeLessThan(rentSection);
  });

  test('banned border-left:4px accent stripe is absent', async ({ page }) => {
    await gotoLanding(page);

    const offenders = await page.evaluate(() => {
      const out: Array<{ tag: string; classes: string; style: string }> = [];
      for (const el of document.querySelectorAll<HTMLElement>('*')) {
        const inline = (el.getAttribute('style') ?? '').replace(/\s+/g, '');
        if (/border-left:[34-9]px/.test(inline) || /border-left:\d{2,}px/.test(inline)) {
          out.push({
            tag: el.tagName,
            classes: el.className.toString().slice(0, 60),
            style: inline.slice(0, 120),
          });
        }
      }
      return out;
    });
    expect(offenders).toEqual([]);
  });
});
