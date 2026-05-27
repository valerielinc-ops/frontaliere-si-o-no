import { test, expect, type Page } from 'playwright/test';

/**
 * Live visual regression guard for job-detail company links.
 *
 * Direct `/azienda-*` URLs intentionally render as staticOverlay SEO pages.
 * But when a user clicks the company link from a hydrated job detail, the SPA
 * must keep ownership and show the interactive filtered JobBoard. A regression
 * here looks visibly obvious: the page falls back to a plain static document
 * instead of the rounded-card, token-styled job-board UI.
 *
 * This lives in validate-live via `playwright.live.config.ts` (`*-live.spec.ts`)
 * because the bug depends on the deployed static shell + hydrated SPA handoff.
 */

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

const JOB_DETAIL_CANDIDATES = [
  // Original reporter.
  '/cerca-lavoro-ticino/project-manager-in-progetti-clienti-100-agie-charmilles-sa-biel-bienne/',
  // Existing live smoke target.
  '/cerca-lavoro-ticino/meccanico-a-di-produzione-afc-bellinzona-ffs-officine-ferrovie-federali-bellinzona/',
  // Long-lived detail URL already used by live heading guards.
  '/cerca-lavoro-ticino/senior-manager-reporting-gestione-patrimoniale-100-remoto-tether-operations-lugano/',
] as const;

test.use({ viewport: { width: 1280, height: 800 } });

async function openJobDetailWithCompanyLink(page: Page): Promise<string> {
  for (const path of JOB_DETAIL_CANDIDATES) {
    const url = `${LIVE_BASE_URL}${path}`;
    const response = await page.request.get(url, { maxRedirects: 5, timeout: 15_000 }).catch(() => null);
    if (!response || response.status() === 404) continue;
    expect(response.status(), `${url} should respond 200 if selected as a live candidate`).toBe(200);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(800);

    const companyLink = page.locator('main a[href*="/cerca-lavoro-ticino/azienda-"]').first();
    if (await companyLink.isVisible().catch(() => false)) {
      return path;
    }
  }

  throw new Error('No live job-detail candidate exposed a visible /azienda-* company link.');
}

test('company link from job detail stays visually hydrated as the SPA job board', async ({ page }) => {
  const sourcePath = await openJobDetailWithCompanyLink(page);
  const companyLink = page.locator('main a[href*="/cerca-lavoro-ticino/azienda-"]').first();
  const companyHref = await companyLink.getAttribute('href');
  expect(companyHref, `job detail ${sourcePath} should expose a company link`).toContain('/azienda-');

  await companyLink.click();
  await page.waitForURL(/\/cerca-lavoro-ticino\/azienda-[^/]+\/?$/, { timeout: 15_000 });

  const searchInput = page.locator(
    'main input[aria-label*="Cerca"], main input[placeholder*="Cerca"], main input[aria-label*="Search"], main input[placeholder*="Search"]',
  ).first();
  await expect(searchInput, 'company-filter navigation should land on hydrated JobBoard controls').toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  const visualState = await page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.top < window.innerHeight &&
        cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
    };

    const roundedPanels = Array.from(document.querySelectorAll('main *')).filter((el) => {
      if (!visible(el)) return false;
      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const hasPanelShape = parseFloat(cs.borderRadius) >= 8 && rect.width * rect.height >= 1_200;
      const hasSurface = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      return hasPanelShape && hasSurface;
    }).length;

    const staticSeoMain = document.querySelector('main.seo-static-content');
    const staticSeoVisible = staticSeoMain ? visible(staticSeoMain) : false;
    const bodyFont = window.getComputedStyle(document.body).fontFamily;
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const mainText = (document.querySelector('main')?.textContent || '').trim().length;

    return { roundedPanels, staticSeoVisible, bodyFont, bodyBg, mainText };
  });

  await page.screenshot({
    path: 'test-results/live-company-filter-hydrated.png',
    fullPage: false,
    animations: 'disabled',
  });

  expect(visualState.staticSeoVisible, 'static SEO main must not own the viewport after an internal company click').toBe(false);
  expect(visualState.bodyFont, 'hydrated UI should not look like an unstyled static serif document').not.toMatch(/Times|Georgia|Cambria/i);
  expect(visualState.roundedPanels, 'hydrated JobBoard should render multiple rounded surface panels above the fold').toBeGreaterThanOrEqual(3);
  expect(visualState.mainText, 'hydrated company-filter view should contain substantial visible UI text').toBeGreaterThanOrEqual(250);
  expect(visualState.bodyBg, 'hydrated app background should not be plain browser white').not.toBe('rgb(255, 255, 255)');
});
