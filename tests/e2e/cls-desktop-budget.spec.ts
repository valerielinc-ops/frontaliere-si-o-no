/**
 * CLS desktop budget guard — Phase 6 of the 2026-05-18 traffic-subs recovery.
 *
 * Goal: keep p75 cumulative-layout-shift under the Google "needs improvement"
 * threshold (0.25) on the 4 highest-revenue paths. Real CrUX desktop p75 on
 * the homepage was 1.02 (4x over) at plan time; baseline this test against the
 * post-fix value to prevent regressions.
 *
 * Two run modes:
 *   1. Local / CI: `npx playwright test tests/e2e/cls-desktop-budget.spec.ts`
 *      → spins up `vite preview` on port 4173 (per playwright.config.ts).
 *   2. Live: `LIVE_BASE_URL=https://frontaliereticino.ch SKIP_PROD_CLS=0 \
 *               npx playwright test tests/e2e/cls-desktop-budget.spec.ts`
 *      → measures CLS on the deployed site. Skipped by default in CI because
 *      live network variability adds flake.
 */

import { test, expect } from 'playwright/test';

const CRITICAL_PATHS = [
  '/',
  '/cerca-lavoro-ticino/',
  '/calcola-stipendio/',
  '/articoli-frontaliere/',
] as const;

// Allow opting out when only the dev server is running (e.g. local build cache).
const SKIP_LIVE = process.env.SKIP_PROD_CLS === '1';

test.describe('CLS desktop budget (Phase 6 guard)', () => {
  test.describe.configure({ mode: 'serial' });

  for (const path of CRITICAL_PATHS) {
    test(`CLS budget < 0.25 desktop on ${path}`, async ({ page, baseURL }) => {
      if (SKIP_LIVE && (baseURL ?? '').startsWith('https://')) {
        test.skip(true, 'SKIP_PROD_CLS=1 set');
      }

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(path, { waitUntil: 'networkidle' });

      // Sample CLS via the Web Performance API. Mirrors the spec used by
      // CrUX / web-vitals.js (skip entries with hadRecentInput).
      const cls = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let total = 0;
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries() as PerformanceEntry[]) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const e = entry as any;
                if (!e.hadRecentInput) total += e.value;
              }
            });
            observer.observe({ type: 'layout-shift', buffered: true });
            setTimeout(() => {
              observer.disconnect();
              resolve(total);
            }, 4000);
          }),
      );

      // 0.25 is Google's "poor" threshold. We test under 0.25, not under the
      // current value, so a future regression that doesn't cross "poor"
      // still passes — the goal is to prevent re-entering the red zone.
      expect(cls, `CLS on ${path} = ${cls.toFixed(3)} (budget < 0.25)`).toBeLessThan(0.25);
    });
  }
});
