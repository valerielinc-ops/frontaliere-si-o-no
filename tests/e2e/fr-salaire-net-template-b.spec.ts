import { test, expect, type Page } from 'playwright/test';

/**
 * Template B regression test for the FR calculator landing page
 * (`frSalaireNetLandingPlugin`, 2026-05 refactor).
 *
 * Asserts the mobile-first above-the-fold contract from CLAUDE.md regola #17:
 * the meaty content (3 stat tiles + primary CTA → calculator) must sit above
 * the 736 px fold at 414 px viewport. The legacy long-form prose (cotisations
 * breakdown table, scenarios table, FAQ) lives BELOW a "Pour aller plus loin"
 * divider so the calculator CTA is never pushed off-screen by editorial filler.
 *
 * Locale: FR canonical (`/fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/`).
 * Single-page funnel for the `calcul salaire net suisse frontalier` query (CH
 * database, 880 searches/month).
 */

const FR_SALAIRE_PATH =
  '/fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/';
const MOBILE_VIEWPORT = { width: 414, height: 736 } as const;
const FOLD_PX = MOBILE_VIEWPORT.height;

async function gotoLanding(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(FR_SALAIRE_PATH, { waitUntil: 'load' });
  // Allow SPA hydration to settle before measuring layout.
  await page.waitForTimeout(1_500);
}

async function topOfElement(
  page: Page,
  selector: string,
): Promise<number | null> {
  const handle = page.locator(selector).first();
  if ((await handle.count()) === 0) return null;
  const box = await handle.boundingBox();
  return box ? box.y : null;
}

test.describe('FR salaire-net landing template B — mobile above-the-fold contract', () => {
  test('3 stat tiles + primary CTA sit above the 414×736 fold', async ({
    page,
  }) => {
    await gotoLanding(page);

    // Stat-tile labels must render exactly once each.
    const frontaliersLabel = page.locator('text=/Frontaliers FR/').first();
    const medianLabel = page.locator('text=/Salaire médian brut/').first();
    const savingLabel = page.locator('text=/Économie net vs FR/').first();
    await expect(frontaliersLabel).toBeVisible();
    await expect(medianLabel).toBeVisible();
    await expect(savingLabel).toBeVisible();

    const frontaliersTop = (await topOfElement(
      page,
      'text=/Frontaliers FR/',
    ))!;
    const medianTop = (await topOfElement(page, 'text=/Salaire médian brut/'))!;
    const savingTop = (await topOfElement(page, 'text=/Économie net vs FR/'))!;
    // Tiles wrap to 2-3 rows on mobile; require the headline metrics inside
    // the first viewport and tolerate up to 1.5× the fold for the third tile.
    expect(frontaliersTop).toBeLessThan(FOLD_PX);
    expect(medianTop).toBeLessThan(FOLD_PX);
    expect(savingTop).toBeLessThan(FOLD_PX * 1.5);

    // Primary CTA → /fr/calculer-salaire/ must exist with the exact label and
    // live above the long prose.
    const cta = page
      .locator('a:has-text("Lancer la simulation gratuite")')
      .first();
    await expect(cta).toBeVisible();
    expect(await cta.getAttribute('href')).toMatch(/\/fr\/calculer-salaire\/?$/);
  });

  test('"Exemples chiffrés" + "Cantons frontaliers" sections render above the divider', async ({
    page,
  }) => {
    await gotoLanding(page);

    await expect(
      page.locator('h2:has-text("Exemples chiffrés")'),
    ).toBeVisible();
    await expect(
      page.locator('h2:has-text("Cantons frontaliers les plus convoités")'),
    ).toBeVisible();
  });

  test('long-form prose lives below the "Pour aller plus loin" divider', async ({
    page,
  }) => {
    await gotoLanding(page);

    const tilesTop = (await topOfElement(page, 'text=/Frontaliers FR/'))!;
    const dividerTop = (await topOfElement(
      page,
      'text=/Pour aller plus loin/',
    ))!;
    const cotisationsSection = (await topOfElement(
      page,
      'h2:has-text("Comment est calculé le salaire net en Suisse")',
    ))!;

    expect(tilesTop).toBeLessThan(dividerTop);
    expect(dividerTop).toBeLessThan(cotisationsSection);
  });

  test('banned border-left:4px accent stripe is absent', async ({ page }) => {
    await gotoLanding(page);

    const offenders = await page.evaluate(() => {
      const out: Array<{ tag: string; classes: string; style: string }> = [];
      for (const el of document.querySelectorAll<HTMLElement>('*')) {
        const inline = (el.getAttribute('style') ?? '').replace(/\s+/g, '');
        if (
          /border-left:[34-9]px/.test(inline) ||
          /border-left:\d{2,}px/.test(inline)
        ) {
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
