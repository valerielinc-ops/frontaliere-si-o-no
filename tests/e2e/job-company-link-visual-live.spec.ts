import { test, expect, type Page } from 'playwright/test';
import { listActiveJobDetailPaths } from './lib/live-jobs';

/**
 * Live guard for the job-detail → company-hub handoff.
 *
 * Clicking the company link from a job detail navigates to the per-company
 * hub `/cerca-lavoro-ticino/azienda-{slug}/`. Per #1156 this is a deliberate
 * FULL navigation to the static company hub (HTTP 200) — the hub lists the
 * employer's openings across ALL cantons, whereas an in-canton SPA re-filter
 * would clobber the list with an empty result for cross-canton employers
 * (e.g. PwC: 109 static jobs vs 0 in the TI shard). See JobBoard.tsx
 * `openCompanyFilter` / `openGateCompanyFilter`.
 *
 * The regression this catches (the reason the guard exists): the destination
 * falling back to a plain, unstyled static document / empty page instead of a
 * properly token-styled company hub that actually lists the company's jobs.
 * The assertions therefore validate the LANDING CONTRACT — styled shell, real
 * company heading, substantial body, at least one job link into the board —
 * which holds whether the click full-navigates to the static hub (#1156) or is
 * intercepted into the broadened SPA hub (#1262); both must be a real, usable
 * company page, never a degraded document.
 *
 * Lives in validate-live via `playwright.live.config.ts` (`*-live.spec.ts`)
 * because the bug depends on the deployed static shell + navigation handoff.
 * Job-detail URLs are discovered at runtime from the live sitemap — pinning
 * slugs time-bombed once a listing expired into a soft-landing (incident
 * 2026-06-03). See lib/live-jobs.ts.
 */

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

async function openJobDetailWithCompanyLink(page: Page): Promise<string> {
  // Discover active listings (with a company link in their static HTML) from
  // the live sitemap. Some layouts hide the company link, so we navigate and
  // gate on runtime visibility, falling through to the next candidate when it
  // is not clickable.
  const candidates = await listActiveJobDetailPaths(page, { limit: 8, requireCompanyLink: true });

  for (const path of candidates) {
    await page.goto(`${LIVE_BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(800);

    const companyLink = page.locator('main a[href*="/cerca-lavoro-ticino/azienda-"]').first();
    if (await companyLink.isVisible().catch(() => false)) {
      return path;
    }
  }

  throw new Error('No active live job-detail exposed a visible /azienda-* company link.');
}

test.use({ viewport: { width: 1280, height: 800 } });

test('company link from job detail lands on a real, styled company hub', async ({ page }) => {
  const sourcePath = await openJobDetailWithCompanyLink(page);
  const companyLink = page.locator('main a[href*="/cerca-lavoro-ticino/azienda-"]').first();
  const companyHref = await companyLink.getAttribute('href');
  expect(companyHref, `job detail ${sourcePath} should expose a company link`).toContain('/azienda-');

  await companyLink.click();
  await page.waitForURL(/\/cerca-lavoro-ticino\/azienda-[^/]+\/?$/, { timeout: 15_000 });

  // Let the destination settle (full nav to the static hub, or SPA handoff).
  await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  const hub = await page.evaluate(() => {
    const main = document.querySelector('main');
    const bodyCs = window.getComputedStyle(document.body);
    const h1 = (main?.querySelector('h1')?.textContent || '').trim();
    // Job-detail links into the board prove the hub actually lists the
    // company's openings (not an empty / soft-404 / error document). Exclude
    // other hub/category/pagination/company links.
    const jobLinks = Array.from(main?.querySelectorAll('a[href*="/cerca-lavoro-ticino/"]') || []).filter((a) => {
      const href = a.getAttribute('href') || '';
      return !/\/(azienda-|company-|unternehmen-|entreprise-|settori|categoria-|category-|kategorie-|categorie-|pagina-|page-|seite-)/.test(href)
        && /\/cerca-lavoro-ticino\/[^/]+\/?$/.test(href);
    }).length;
    return {
      mainText: (main?.textContent || '').trim().length,
      h1,
      jobLinks,
      bodyFont: bodyCs.fontFamily,
      bodyBg: bodyCs.backgroundColor,
    };
  });

  await page.screenshot({
    path: 'test-results/live-company-hub-landing.png',
    fullPage: false,
    animations: 'disabled',
  });

  // Landing contract for the company hub — must be a real, styled page, never
  // a plain unstyled document or an empty list.
  expect(hub.h1, `company hub for ${companyHref} should expose a heading`).not.toEqual('');
  expect(hub.mainText, 'company hub should contain substantial body text').toBeGreaterThanOrEqual(250);
  expect(hub.jobLinks, 'company hub should list at least one of the company\'s job openings').toBeGreaterThanOrEqual(1);
  expect(hub.bodyFont, 'company hub should not look like an unstyled static serif document').not.toMatch(/Times|Georgia|Cambria/i);
  expect(hub.bodyBg, 'company hub background should not be plain browser white').not.toBe('rgb(255, 255, 255)');
});
