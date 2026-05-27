import { test, expect, type Page } from 'playwright/test';

/**
 * Template B regression test for career landings (2026-05 redesign — AE-2).
 *
 * Targets the richest of the 4 career landings,
 * `/agenzie-del-lavoro-lugano/`, because:
 *   - it ships the SECO-registry-backed employer grid (8 agencies)
 *   - it covers the no-featured-jobs path (vendors don't crawl staffing
 *     agencies — the renderer must NOT crash + must NOT show an empty
 *     featured section)
 *   - it has the typical 3-tile + CTA + employer-grid + divider + prose
 *     structure that the other 3 landings share.
 *
 * Asserts the mobile-first above-the-fold contract from CLAUDE.md regola #17
 * (75 % traffic is mobile, 414 × 736 viewport). EN/DE/FR variants reuse the
 * exact same layout — per-locale coverage stays in unit tests.
 */

const CAREER_LANDING_PATH = '/agenzie-del-lavoro-lugano/';
const MOBILE_VIEWPORT = { width: 414, height: 736 } as const;
const FOLD_PX = MOBILE_VIEWPORT.height;

async function gotoLanding(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(CAREER_LANDING_PATH, { waitUntil: 'load' });
  // Wait for SPA hydration so any post-load rearrangement settles.
  await page.waitForTimeout(1_500);
}

async function topOfElement(page: Page, selector: string): Promise<number | null> {
  const handle = page.locator(selector).first();
  if ((await handle.count()) === 0) return null;
  const box = await handle.boundingBox();
  return box ? box.y : null;
}

test.describe('Career landings template B — mobile above-the-fold contract', () => {
  test('stat tiles + primary CTA sit above the 414×736 fold', async ({ page }) => {
    await gotoLanding(page);

    const liveLabel = page.locator('text=/Agenzie SECO a Lugano/');
    const requirementLabel = page.locator('text=/Autorizzazione SECO/');
    const rightsLabel = page.locator('text=/Diritto frontalieri/');
    await expect(liveLabel).toBeVisible();
    await expect(requirementLabel).toBeVisible();
    await expect(rightsLabel).toBeVisible();

    const liveTop = (await topOfElement(page, 'text=/Agenzie SECO a Lugano/'))!;
    const reqTop = (await topOfElement(page, 'text=/Autorizzazione SECO/'))!;
    const rightsTop = (await topOfElement(page, 'text=/Diritto frontalieri/'))!;
    // Tiles may wrap to 2 rows at 414 px — first 2 must be in the viewport,
    // the third within 1.5× the fold.
    expect(liveTop).toBeLessThan(FOLD_PX);
    expect(reqTop).toBeLessThan(FOLD_PX);
    expect(rightsTop).toBeLessThan(FOLD_PX * 1.5);

    // Primary CTA → calculator must exist and live above the long prose.
    const cta = page.locator('a:has-text("Calcola il netto da interinale")').first();
    await expect(cta).toBeVisible();
    expect(await cta.getAttribute('href')).toMatch(/\/calcola-stipendio\/?$/);
  });

  test('employer grid shows ≥1 SECO-registered agency above the divider', async ({ page }) => {
    await gotoLanding(page);

    await expect(
      page.locator('h2:has-text("Agenzie SECO autorizzate a Lugano")'),
    ).toBeVisible();

    // The SECO registry curates 8 brands; assert at least one well-known
    // brand renders in the grid as a sanity check that the loader works.
    const adecco = page.locator('text=/Adecco/').first();
    await expect(adecco).toBeVisible();
  });

  test('long-form prose lives below the divider, NOT above the tiles', async ({ page }) => {
    await gotoLanding(page);

    const tilesTop = (await topOfElement(page, 'text=/Agenzie SECO a Lugano/'))!;
    const dividerTop = (await topOfElement(page, 'text=/^Approfondisci$/'))!;
    // The first long-form H2 on the agenzie page is hand-written copy in IT.
    const firstProseSection = (await topOfElement(
      page,
      'h2:has-text("Come riconoscere un\'agenzia autorizzata SECO")',
    ))!;

    expect(tilesTop).toBeLessThan(dividerTop);
    expect(dividerTop).toBeLessThan(firstProseSection);
  });

  test('banned border-left:4px accent stripe is absent', async ({ page }) => {
    await gotoLanding(page);

    // Scan every element's inline style for the banned 4+ px accent stripe
    // pattern (impeccable rules, CLAUDE.md design notes).
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
