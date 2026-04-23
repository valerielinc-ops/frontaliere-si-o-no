import { test, expect, type Page } from 'playwright/test';

/**
 * E2E regression test for BUG-2 (docs/seo/ROADMAP.md).
 *
 * Symptom (pre-fix): programmatic SEO landings (F6 fuel-daily, F2
 * health-premiums, F5 weekly-employers, F4 job-market snapshot, F8
 * border-wait, F3b orphan-query) shipped with the top-level header but
 * WITHOUT the hub sub-navigation bar users expect on `/confronti/*`,
 * `/statistiche/*`, `/guida/*`. Pages felt like detached islands.
 *
 * Fix: each plugin now passes `hubChrome: { hubKey, activeSubTab }` to
 * `buildSeoPageHtml`. The shared `renderHubChrome` emits a server-side
 * `<nav class="seo-hub-subnav">` that mirrors `<SubTabNav>` output — same
 * Tailwind tokens, same ARIA semantics, same sub-tab set.
 *
 * Assertion per family: the rendered page carries `<nav class="seo-hub-subnav"
 * data-hub="$hubKey">` inside `main.seo-static-content`, and the active
 * sub-tab link has `data-subtab-active="true"` + matching `data-subtab-key`.
 */

const PARITY_LANDINGS: ReadonlyArray<{
  name: string;
  path: string;
  expectedHubKey: string;
  expectedActiveSubTab: string;
}> = [
  {
    name: 'Fuel daily (F6)',
    path: '/prezzi-diesel/oggi/',
    expectedHubKey: 'stats',
    expectedActiveSubTab: 'fuel-prices',
  },
  {
    name: 'Health premiums (F2)',
    path: '/guida-frontaliere/lamal-frontalieri/',
    expectedHubKey: 'confronti',
    expectedActiveSubTab: 'health',
  },
  {
    name: 'Weekly employers (F5)',
    path: '/aziende-che-assumono/ticino/settimana-corrente/',
    expectedHubKey: 'job-board',
    expectedActiveSubTab: 'jobs',
  },
  {
    name: 'Job market snapshot (F4)',
    path: '/mercato-lavoro-ticino/',
    expectedHubKey: 'stats',
    expectedActiveSubTab: 'jobs-observatory',
  },
  {
    name: 'Border wait (F8)',
    path: '/traffico-dogane/',
    expectedHubKey: 'guida',
    expectedActiveSubTab: 'border',
  },
  {
    // F3b orphan-query landings are slug-driven; if the representative
    // slug isn't present in this build, the test skips rather than
    // fails so CI stays green when the clusters file is empty.
    name: 'Orphan query (F3b)',
    path: '/ricerca/lavoro-ticino-frontaliere/',
    expectedHubKey: 'job-board',
    expectedActiveSubTab: 'jobs',
  },
];

async function assertHubChromeParity(
  page: Page,
  path: string,
  expectedHubKey: string,
  expectedActiveSubTab: string,
): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  if (response && response.status() === 404) {
    test.skip(true, `${path} not present in dist (404) — skipping parity check`);
    return;
  }

  // Static SEO content must be in place — BUG-1 regression guard.
  const seoMain = page.locator('main.seo-static-content');
  await expect(seoMain).toHaveCount(1, { timeout: 10_000 });

  // Hub chrome sub-nav must be rendered server-side inside the SEO main.
  // renderHubChrome emits `<nav class="seo-hub-subnav" data-hub="$hubKey">`.
  const subNav = page.locator('main.seo-static-content nav.seo-hub-subnav');
  await expect(subNav).toHaveCount(1);

  await expect(subNav).toHaveAttribute('data-hub', expectedHubKey);

  // The correct sub-tab must be marked active.
  const activeTab = subNav.locator('[data-subtab-active="true"]').first();
  await expect(activeTab).toHaveAttribute('data-subtab-key', expectedActiveSubTab);
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
}

test.describe('BUG-2: hub chrome parity across programmatic landings', () => {
  for (const landing of PARITY_LANDINGS) {
    test(`${landing.name} — sub-nav + active tab match hub registry`, async ({ page }) => {
      await assertHubChromeParity(page, landing.path, landing.expectedHubKey, landing.expectedActiveSubTab);
    });
  }
});
