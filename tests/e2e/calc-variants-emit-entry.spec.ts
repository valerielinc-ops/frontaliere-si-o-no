/**
 * E2E regression test — Phase 4 of the May 18 traffic-and-subscriptions
 * recovery plan.
 *
 * Diagnosis: `data/recovery-2026-05-18/calc-funnel.md` showed
 * `funnel_step:entry` (funnel=calculator) was firing on the canonical
 * `/calcola-stipendio/` route but NOT on SEO calc variants that mount the
 * same calculator (e.g. `/calcola-stipendio/nuovi-frontalieri-oltre-20-km`,
 * `/calcola-stipendio/confronta-retribuzione-ral`,
 * `/verifica-congedo-parentale`). Result: a fake "−71% drop entry →
 * input_start" funnel that was actually a tracking artifact.
 *
 * Fix: `fireCalcEntryIfNeeded(path)` is now called from the analytics-init
 * block AND from the SPA route-change listener in `hooks/useUIState.ts`. It
 * matches every calc route (canonical + SEO variant + sibling calc tool)
 * and emits once per session via a sessionStorage flag.
 *
 * This test navigates to 3 calc variants in 3 fresh contexts and asserts
 * PostHog received `funnel_step` with `step=entry` and `funnel=calculator`
 * for each — capturing the event via PostHog's first-party reverse proxy
 * at `/e/?ip=...` (configured in the inline init snippet, see the HTML
 * `<head>` of every emitted page).
 */

import { test, expect, type Page, type Request } from 'playwright/test';

const CALC_VARIANTS = [
  '/calcola-stipendio/',
  '/calcola-stipendio/nuovi-frontalieri-oltre-20-km/',
  '/verifica-congedo-parentale/',
];

interface CapturedFunnelStep {
  step?: string;
  funnel?: string;
  landing_path?: string;
  [k: string]: unknown;
}

/**
 * Wait for at least one `funnel_step` PostHog capture and return its parsed
 * properties. PostHog's batch endpoint POSTs JSON to /e/ with an `event`
 * field and a `properties` object. The first-party reverse proxy keeps the
 * /e/ path but rewrites the host, so we match on URL pathname.
 */
async function waitForFunnelStepCalc(page: Page, timeoutMs = 15_000): Promise<CapturedFunnelStep[]> {
  const captured: CapturedFunnelStep[] = [];

  const handler = async (req: Request) => {
    try {
      const url = new URL(req.url());
      // PostHog reverse proxy: /e/ (or /e/?...) — match by pathname suffix
      if (!url.pathname.endsWith('/e/') && !url.pathname.endsWith('/e')) return;
      const postData = req.postData();
      if (!postData) return;
      const payload = JSON.parse(postData);
      // PostHog payload can be either a single event object or an array
      const events = Array.isArray(payload) ? payload : [payload];
      for (const ev of events) {
        if (ev?.event === 'funnel_step') {
          captured.push((ev.properties ?? {}) as CapturedFunnelStep);
        }
      }
    } catch {
      // Ignore — not every /e/ request is JSON-decodable funnel_step
    }
  };
  page.on('request', handler);

  // Wait until we get at least one calculator entry event OR the deadline
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const calcEntry = captured.find(
      (c) => c.step === 'entry' && c.funnel === 'calculator',
    );
    if (calcEntry) break;
    await page.waitForTimeout(250);
  }

  page.off('request', handler);
  return captured;
}

test.describe('Calculator funnel: entry event fires on every calc variant', () => {
  for (const variant of CALC_VARIANTS) {
    test(`emits funnel_step:entry (funnel=calculator) on ${variant}`, async ({ browser }) => {
      // Fresh context per variant → fresh sessionStorage → independent
      // verification that the entry helper fires for each landing URL.
      const context = await browser.newContext();
      const page = await context.newPage();

      // Pre-arm consent (silent default — services/consentService.ts grants
      // analytics+advertising on first load). Setting it explicitly avoids any
      // race between `setDefaultConsent()` and the analytics-init check.
      await page.addInitScript(() => {
        localStorage.setItem(
          'frontaliere_consent',
          JSON.stringify({ analytics: true, advertising: true, timestamp: Date.now() }),
        );
      });

      await page.goto(variant, { waitUntil: 'domcontentloaded' });

      // Trigger a user gesture — the analytics-init runs `requestIdleCallback`
      // gated on first interaction (see hooks/useUIState.ts:78–106).
      await page.mouse.move(200, 200);
      await page.mouse.click(200, 200);

      const captured = await waitForFunnelStepCalc(page);

      const calcEntries = captured.filter(
        (c) => c.step === 'entry' && c.funnel === 'calculator',
      );
      expect(
        calcEntries,
        `Expected at least one funnel_step:entry (funnel=calculator) on ${variant}. Captured funnel_step events: ${JSON.stringify(captured, null, 2)}`,
      ).toHaveLength(1);
      expect(calcEntries[0].landing_path).toMatch(/^\//);

      await context.close();
    });
  }
});

test.describe('Calculator funnel: dead-click hotspot — accent tile is now a tap target', () => {
  test('first accent stat tile on nuovi-frontalieri-oltre-20-km wraps as <a>', async ({ page }) => {
    await page.goto('/calcola-stipendio/nuovi-frontalieri-oltre-20-km/', {
      waitUntil: 'domcontentloaded',
    });

    // The first tile carries `tone: 'accent'` in salaryLandingShell HUB
    // scenarios. After the fix, it's wrapped as `<a data-tile-cta="1">`
    // pointing at `ctaPrimary.href`. Pre-fix this was an inert `<div>`.
    const tileLink = page.locator('a[data-tile-cta="1"]').first();
    await expect(
      tileLink,
      'Accent stat tile should be a tap target (closes $dead_click hotspot)',
    ).toBeVisible();

    const href = await tileLink.getAttribute('href');
    expect(href, 'Tile href must point at the primary CTA').toBeTruthy();
    // ctaPrimary on this scenario is /calcola-stipendio/?tipo=NEW&zona=OVER_20KM
    expect(href).toContain('/calcola-stipendio/');
  });
});
