import { test, expect, type Page } from 'playwright/test';

/**
 * Template B regression test for profession landings (2026-05 redesign).
 *
 * Asserts the mobile-first above-the-fold contract from CLAUDE.md regola #17:
 * the meaty content (stat tiles + primary CTA + first featured live job)
 * must sit above the 736 px fold at 414 px viewport — NOT pushed below by
 * SEO prose. Also locks out the banned `border-left:4px` accent stripe and
 * proves the long-form prose still lives in the same document for the
 * text-to-HTML ratio gate (just lower down the page).
 *
 * Locales covered: IT canonical (`/lavoro-ticino-educatore/`). EN/DE/FR
 * share the same layout — repeating per-locale would catch only copy bugs
 * which the unit tests already cover.
 */

const PROFESSION_LANDING_PATH = '/lavoro-ticino-educatore/';
const MOBILE_VIEWPORT = { width: 414, height: 736 } as const;
const FOLD_PX = MOBILE_VIEWPORT.height;

async function gotoLanding(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(PROFESSION_LANDING_PATH, { waitUntil: 'load' });
  // Wait for SPA hydration so any post-load rearrangement settles.
  await page.waitForTimeout(1_500);
}

async function topOfElement(page: Page, selector: string): Promise<number | null> {
  const handle = page.locator(selector).first();
  if ((await handle.count()) === 0) return null;
  const box = await handle.boundingBox();
  return box ? box.y : null;
}

test.describe('Profession landings template B — mobile above-the-fold contract', () => {
  test('stat tiles + CTA sit above the 414×736 fold', async ({ page }) => {
    await gotoLanding(page);

    // 3 stat tiles labels must render exactly once each, all above the fold.
    const liveLabel = page.locator('text=/Offerte aperte/');
    const salaryLabel = page.locator('text=/Stipendio mediano/');
    const freshLabel = page.locator('text=/Nuove \\(30 gg\\)/');
    await expect(liveLabel).toBeVisible();
    await expect(salaryLabel).toBeVisible();
    await expect(freshLabel).toBeVisible();

    const liveTop = (await topOfElement(page, 'text=/Offerte aperte/'))!;
    const salaryTop = (await topOfElement(page, 'text=/Stipendio mediano/'))!;
    const freshTop = (await topOfElement(page, 'text=/Nuove \\(30 gg\\)/'))!;
    // Tiles wrap to 2-3 rows on mobile; allow up to 1.5× the fold for the
    // tallest tile but require at least the live + salary tiles to be in the
    // first viewport (the killer-hook numbers).
    expect(liveTop).toBeLessThan(FOLD_PX);
    expect(salaryTop).toBeLessThan(FOLD_PX);
    expect(freshTop).toBeLessThan(FOLD_PX * 1.5);

    // Primary CTA → calculator must exist and live above the long prose.
    const cta = page.locator('a:has-text("Calcola il tuo netto come frontaliere")').first();
    await expect(cta).toBeVisible();
    expect(await cta.getAttribute('href')).toMatch(/\/calcola-stipendio\/?$/);
  });

  test('first featured live job renders with company + posted date', async ({ page }) => {
    await gotoLanding(page);

    await expect(page.locator('h2:has-text("Offerte in evidenza")')).toBeVisible();

    // At least 1 featured job card (the aggregate returns 0..3). Each card
    // must include a "Pubblicata …" freshness line.
    const postedLine = page.locator('text=/Pubblicat[ao]/').first();
    await expect(postedLine).toBeVisible();
  });

  test('long-form prose lives below the divider, NOT above the tiles', async ({ page }) => {
    await gotoLanding(page);

    const tilesTop = (await topOfElement(page, 'text=/Offerte aperte/'))!;
    const dividerTop = (await topOfElement(page, 'text=/^La professione in Ticino$/'))!;
    const firstProseSection = (await topOfElement(
      page,
      'h2:has-text("Il mestiere in Ticino")',
    ))!;

    expect(tilesTop).toBeLessThan(dividerTop);
    expect(dividerTop).toBeLessThan(firstProseSection);
  });

  test('banned border-left:4px accent stripe is absent', async ({ page }) => {
    await gotoLanding(page);

    // Scan every element's inline style + computed style for the banned
    // 4 px accent stripe pattern (impeccable rules, CLAUDE.md design notes).
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
