// Visual regression baselines for STABLE primary pages — run against the
// LIVE deployed site (post-deploy gate inside `validate-live`). When a
// regression is detected the deploy rolls back automatically: the previous
// dist (which by definition matched the baseline) is restored on Pages.
//
// Cases were chosen for their stability — pages that change visually only
// when intentional design / copy edits happen. Cron-generated pages
// (fuel-daily, weekly-employers, border-wait, AND job-board) were removed
// because their content updates daily and would produce false positives on
// every deploy. job-board renders job cards from cron crawlers that fire
// every few minutes, so the above-the-fold viewport reshuffles content
// continuously — rolling deploys back on those churn-pixel diffs is the
// opposite of what visual regression should catch.
//
// Even on "stable" pages there are inline widgets whose content rotates
// independently of code (article ticker, daily dialect phrase, weekly fact,
// achievement toast, unread-news badge, calculator result banner whose
// gradient pulses on hover). Those are masked below — masking forces those
// regions to be drawn as a solid pink rectangle in both the baseline and
// the actual screenshot, so dynamic content cannot trigger a regression.
//
// Regenerate baselines on demand via the
// `regenerate-visual-baselines.yml` workflow_dispatch (runs on Linux,
// commits *-linux.png to the repo).
import { test, expect } from 'playwright/test';

interface VisualCase {
  name: string;
  url: string;
  // Optional readiness selector. Must be visible before we screenshot —
  // ensures lazy/async-hydrated regions are mounted, not white. On
  // salary-calculator the right-side ResultsView is React-hydrated after
  // the page becomes interactive and its 'results-advantage-banner' is the
  // last element to mount; waiting for `domcontentloaded` + fonts is not
  // enough on the live env (CDN + analytics scripts slow first paint).
  readySelector?: string;
  // Optional extra mask selectors, ON TOP of DYNAMIC_REGION_SELECTORS, for
  // dynamic widgets that only exist on THIS case's page (so adding them to
  // the global list would be dead weight everywhere else — mask() silently
  // ignores selectors matching nothing, but a per-page testid still doesn't
  // belong in a page-agnostic list). E.g. currency-comparator's live
  // CHF/EUR rate + last-update timestamp: real-world FX values that move
  // independently of code, same false-positive class as the global list.
  extraMaskSelectors?: string[];
}

const CASES: VisualCase[] = [
  // Home renders CalcolatoreTabContent: InputCard is lazy + its locale chunk
  // (`it-calculator.ts`) is lazy too. But gating only on the left InputCard is
  // NOT enough: the right-side ResultsView hydrates independently (default
  // RAL=75k auto-computes), and `results-advantage-banner` is the last element
  // to mount — same as salary-calculator. Gating only on the input card let the
  // screenshot fire while the entire ResultsView (Analisi Comparativa + Vivere
  // cards) was still empty, baking an empty-results-pane baseline that then
  // diffed ~11% against every fully-hydrated live render (run 26999410533).
  // Gate on the banner so the capture is always at full hydration.
  { name: 'home', url: '/', readySelector: '[data-testid="results-advantage-banner"]' },
  {
    name: 'salary-calculator',
    url: '/calcola-stipendio/',
    readySelector: '[data-testid="results-advantage-banner"]',
  },
  // `/comparatori/cambio-valuta/` is a legacy-redirect URL: its STATIC HTML is a
  // thin "Pagina spostata" bridge tombstone, and the SPA only swaps in the real
  // CurrencyExchange comparator after hydration (router maps the legacy slug to
  // confronti/exchange). Without a readySelector the capture raced that swap —
  // baseline generation froze the pre-hydration tombstone, which then diffed
  // 100% against every fully-hydrated live render (validate-live recurring fail).
  // `#exchange-amount` is the comparator's amount input: it exists ONLY in the
  // hydrated comparator (never in the tombstone nor the static SEO shell — verified
  // by the guard in tests/noindex-builders.test.ts), so gating on it forces a
  // deterministic full-comparator capture on both sides.
  //
  // `exchange-rate-panel` (extraMaskSelectors) covers the live CHF/EUR
  // mid-market rate + "Aggiornato: HH:MM:SS" timestamp (useExchangeRate(),
  // TwelveData → Firestore cache) — a real-world value that ticks
  // independently of any code change. Unmasked, it produced a real (not
  // flaky — reproduced identically on both the initial attempt and the
  // Playwright retry) pixel diff on every deploy where the rate moved
  // between baseline capture and validate-live (run 28506482095: 26182px /
  // ratio 0.03, just over the 0.02 threshold). Not in the global
  // DYNAMIC_REGION_SELECTORS list because that testid only exists on this
  // one comparator page. A prior fix attempt (#3197, since superseded)
  // instead raised maxDiffPixelRatio to 0.04 for this case — masking the
  // actual dynamic region is the correct fix and keeps every case, including
  // this one, at the tight 0.02 default.
  {
    name: 'currency-comparator',
    url: '/comparatori/cambio-valuta/',
    readySelector: '#exchange-amount',
    extraMaskSelectors: ['[data-testid="exchange-rate-panel"]'],
  },
];

// Selectors for non-deterministic widgets that auto-rotate or depend on
// time/cron data. Each must exist in the rendered DOM before the test takes
// the screenshot — keep these in sync with the data-testid attributes in
// the component sources. Missing selectors are silently ignored by mask().
const DYNAMIC_REGION_SELECTORS = [
  '[data-testid="news-ticker"]',
  '[data-testid="daily-dialect-phrase"]',
  '[data-testid="weekly-fact"]',
  '[data-testid="gamification-toast"]',
  '[data-testid="whats-new-badge"]',
  '[data-testid="results-advantage-banner"]',
];

// Single source of truth for the captured viewport — the skeleton net below
// scans this exact above-the-fold region, so the two must never drift.
const VIEWPORT = { width: 1280, height: 800 } as const;

test.use({ viewport: VIEWPORT });

// ---- Structural guardrail against partial-hydration baselines ----
// A per-case `readySelector` only proves ONE element mounted. Other
// above-the-fold regions can still be showing a loading skeleton when the
// screenshot fires — and if that happens during baseline *generation*, the
// partial state is frozen into the PNG and diffs against every fully-hydrated
// live render forever (the home ResultsView empty-pane bug, run 26999410533,
// 108122px / ratio 0.11). Because both baseline-gen and validate-live share
// this spec, a single capture-path gate fixes both sides.
//
// Every loading placeholder in the app carries the same signature: the
// `animate-pulse` class AND a `surface-raised` background (see the `pulse`
// primitive in components/shared/Skeletons.tsx and every Suspense fallback in
// the calculator tree). Decorative pulses (Lucide icons: Volume2, Trophy) use
// `animate-pulse` WITHOUT a surface-raised background, so they're excluded.
// AdSense slots never match this signature, so the ad system is untouched.
//
// This is generic: a future VisualCase whose `readySelector` resolves early
// while another hero region is still a skeleton is caught here, with no
// per-page knowledge required.
async function waitForNoAboveFoldSkeletons(
  page: import('playwright/test').Page,
  viewportHeight: number,
): Promise<void> {
  await page.waitForFunction(
    (vh) => {
      const nodes = Array.from(document.querySelectorAll('[class*="animate-pulse"]'));
      return !nodes.some((el) => {
        const cls = (el.getAttribute('class') ?? '').toString();
        // Skeleton loaders carry a surface-raised bg; decorative icon pulses don't.
        if (!cls.includes('surface-raised')) return false;
        const r = el.getBoundingClientRect();
        // Only count placeholders intersecting the captured viewport.
        return r.top < vh && r.bottom > 0 && r.width > 0 && r.height > 0;
      });
    },
    viewportHeight,
    { timeout: 20_000 },
  );
}

// `salary-calculator` baseline is stale after commit 5f81803062
// ("fix(seo): scope seo-static.css h1-h4 + main rules to main.seo-static-content"):
// SPA H1/H2 sizes now correctly resolve via Tailwind preflight + per-component
// utility classes instead of the unscoped 48px global element rule that
// previously bled from seo-static.css. The new render is CORRECT — the
// snapshot is OUTDATED. We can't regenerate from live because validate-live
// rollback keeps the pre-fix dist live on prod, so the regen workflow recaptures
// the same stale baseline (circular dependency observed in run 26318669115:
// "No baseline changes — already up to date").
//
// Skip salary-calculator temporarily so the new dist actually reaches main,
// then re-trigger `regenerate-visual-baselines.yml` once it's live to capture
// the correct 30px H1 baseline, then remove this skip in a follow-up PR.
const STALE_BASELINES = new Set(['salary-calculator']);

for (const c of CASES) {
  const testFn = STALE_BASELINES.has(c.name) ? test.skip : test;
  testFn(`visual baseline: ${c.name}`, async ({ page }) => {
    // `networkidle` is unreliable on SPAs with analytics/polling
    // (home/calculator never settle). Use `domcontentloaded` + wait for
    // the <main> element to be attached + fonts ready, which is what
    // visual stability actually requires.
    await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });
    if (c.readySelector) {
      await page.locator(c.readySelector).first().waitFor({ state: 'visible', timeout: 20_000 });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    // Structural net: no above-the-fold loading skeleton may remain, on ANY
    // page, before we capture — prevents freezing a partial-hydration baseline
    // even if a future case's readySelector under-specifies readiness.
    await waitForNoAboveFoldSkeletons(page, page.viewportSize()?.height ?? 800);
    // Brief settle: wait for layout shift to stabilize after font load.
    await page.waitForTimeout(500);
    // Viewport-only screenshot (1280x800). Full-page / element screenshots
    // are unstable on SPA pages with lazy-loaded cards + ads auto-inject —
    // the page keeps growing taller and Playwright fails with "Failed to
    // take two consecutive stable screenshots". Visual regression on the
    // above-the-fold viewport is what actually matters for header / hero /
    // first-paint UX, which is the value visual baselines provide.
    await expect(page).toHaveScreenshot(`${c.name}.png`, {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
      mask: [...DYNAMIC_REGION_SELECTORS, ...(c.extraMaskSelectors ?? [])].map((sel) => page.locator(sel)),
    });
  });
}
