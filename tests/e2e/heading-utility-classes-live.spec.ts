import { test, expect, type Page } from 'playwright/test';
import { resolveActiveJobDetailPath } from './lib/live-jobs';

/**
 * Live regression guard for the 2026-05-22 heading-clobber incident.
 *
 * `public/assets/seo-static.css` historically carried element-only rules
 * (`h1 { … } h2 { … } h3 { … }`) intended to size raw `<h1>` emitters in
 * crawler-facing static HTML (jobsSeoPagesPlugin city hubs, page-N,
 * sector/category landings, company hubs). After PRs #4979c9979d +
 * #6f59dfa4ec started linking that stylesheet from every SPA shell head,
 * those unlayered rules began winning against Tailwind `@layer utilities`
 * on hydrated headings — `<h3 class="text-xs text-subtle">` rendered at
 * 18px slate-900 instead of 12px slate-500 across every mobile page (most
 * visible on the job-board sidebar, currency comparator hub, salary hub).
 *
 * The fix scopes those rules to `main.seo-static-content X`. This spec
 * verifies the scoping holds on the deployed CDN by:
 *   1. Loading several real pages on a mobile viewport
 *   2. Synthesizing each `<hN class="text-xs/sm/xl">` inside `document.body`
 *      and asserting Tailwind utility font-sizes resolve (12 / 14 / 20 px)
 *   3. Spot-checking a real heading on the page that uses one of these
 *      utility classes (when present) — catches future regressions where
 *      an unlayered element rule is reintroduced anywhere in the stylesheet
 *      chain (vendor injection, accidental new CSS import, layer mishap).
 *
 * Why an assertion-driven test instead of a screenshot baseline: the
 * affected pages (job-board, salary-hub, currency comparator) contain
 * cron-churn widgets (job ticker, daily rates, calculator result banner)
 * that produce pixel diffs on every deploy. Visual regression here is the
 * font-size of the headings, not the surrounding pixels — measuring it
 * directly avoids the masking churn that already forced job-board out of
 * `seo-visual-regression.spec.ts`.
 *
 * Wired into `validate-live` via `playwright.live.config.ts` (`testMatch:
 * *-live.spec.ts`). LIVE_BASE_URL defaults to production.
 */

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

// Tailwind v3 default font-size scale (rem→px at 16px base). Values are
// asserted as the computed `fontSize` string — Tailwind never quantizes
// these so an exact string match is safe and the most precise signal.
const TAILWIND_FONT_SIZE_PX: Record<string, string> = {
  'text-xs': '12px',
  'text-sm': '14px',
  'text-base': '16px',
  'text-lg': '18px',
  'text-xl': '20px',
};

// URLs cover the surfaces where the regression was reported: job-detail
// (mobile snapshot block area) and the canonical currency comparator
// (Confronto Cambio Valuta h1). Home is included as a regression sanity
// case — historically it doesn't link seo-static.css, so a failure there
// would mean a new SPA-wide stylesheet started clobbering Tailwind.
//
// We intentionally do NOT target redirect/legacy aliases like
// `/comparatori/cambio-valuta/`: those resolve to bridge stub pages
// (`<main class="card">` + bridge.css, no SPA bundle), and probing
// Tailwind utility classes there is meaningless — Tailwind isn't shipped.
// The runtime skip below handles future cases where a URL silently
// becomes a bridge.
// Static surfaces with stable paths. The job-detail surface is resolved at
// runtime (see below) because pinning a listing slug time-bombs once it
// expires into a soft-landing page (200, no <main>) — see lib/live-jobs.ts.
const TARGETS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'home', path: '/' },
  { name: 'currency-comparator', path: '/compara-servizi/cambio-franco-euro/' },
];

// iPhone 13 viewport — matches the device class the regression was
// reported on (CLAUDE.md #15: 75% of traffic is mobile).
test.use({ viewport: { width: 390, height: 844 } });

async function assertTailwindHeadingsResolve(page: Page, path: string): Promise<void> {
    const url = `${LIVE_BASE_URL}${path}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });

    // Skip redirect/legacy bridge stub pages — they ship bridge.css only,
    // no Tailwind bundle. This test asserts Tailwind utilities resolve, so
    // it's a category error to assert on a page that has no Tailwind.
    const isBridge = await page.evaluate(() => !!document.querySelector('body > main.card'));
    test.skip(isBridge, `${path} is a bridge/redirect stub (no Tailwind)`);

    // Wait until Tailwind utilities are actually active. The SPA loads
    // `index-{hash}.css` with `media="print" onload="this.media='all'"`
    // (PR #467 async-CSS pattern) — between `domcontentloaded` and the
    // onload swap, `.text-xs` resolves to the browser default. Polling
    // a synthetic node is the only reliable signal: it goes from a
    // non-12px value to 12px the instant the SPA bundle becomes active.
    await page.waitForFunction(
      () => {
        const probe = document.createElement('div');
        probe.className = 'text-xs';
        document.body.appendChild(probe);
        const fs = getComputedStyle(probe).fontSize;
        probe.remove();
        return fs === '12px';
      },
      undefined,
      { timeout: 15_000 },
    );

    await page.evaluate(() => document.fonts.ready);
    // Brief settle for any late-mounting CSS (async stylesheet load).
    await page.waitForTimeout(500);

    // Probe synthetic headings — isolates "Tailwind utility wins on a real
    // <hN> element" from "page happens to use this utility class".
    const probes = await page.evaluate((classes: string[]) => {
      const out: Record<string, Record<string, string>> = {};
      const tags = ['h1', 'h2', 'h3', 'h4'] as const;
      for (const tag of tags) {
        out[tag] = {};
        for (const cls of classes) {
          const el = document.createElement(tag);
          el.className = cls;
          el.textContent = 'probe';
          document.body.appendChild(el);
          out[tag][cls] = getComputedStyle(el).fontSize;
          el.remove();
        }
      }
      return out;
    }, Object.keys(TAILWIND_FONT_SIZE_PX));

    for (const tag of ['h1', 'h2', 'h3', 'h4'] as const) {
      for (const [cls, expected] of Object.entries(TAILWIND_FONT_SIZE_PX)) {
        expect(
          probes[tag][cls],
          `<${tag} class="${cls}"> must compute to ${expected} on ${path} (unlayered element rule regressed?)`,
        ).toBe(expected);
      }
    }

    // Spot-check a real heading on the page that already carries a
    // Tailwind size utility — confirms the utility resolves not just on
    // a synthetic node but on actual SPA-rendered DOM (catches scoping
    // chains that affect existing-tree nodes but not freshly-appended ones).
    const realMatch = await page.evaluate((classes: string[]) => {
      const tags = ['h1', 'h2', 'h3', 'h4'];
      for (const tag of tags) {
        for (const el of Array.from(document.querySelectorAll(tag))) {
          for (const cls of classes) {
            if (el.classList.contains(cls)) {
              return {
                tag,
                cls,
                fontSize: getComputedStyle(el).fontSize,
                text: (el.textContent || '').trim().slice(0, 60),
              };
            }
          }
        }
      }
      return null;
    }, Object.keys(TAILWIND_FONT_SIZE_PX));

    if (realMatch) {
      expect(
        realMatch.fontSize,
        `real <${realMatch.tag} class="${realMatch.cls}"> "${realMatch.text}" on ${path} must compute to ${TAILWIND_FONT_SIZE_PX[realMatch.cls]}`,
      ).toBe(TAILWIND_FONT_SIZE_PX[realMatch.cls]);
    }
}

for (const target of TARGETS) {
  test(`tailwind text-* utilities resolve on real <hN> after hydration: ${target.name}`, async ({ page }) => {
    await assertTailwindHeadingsResolve(page, target.path);
  });
}

// Job-detail mobile is the exact surface from the bug report. Resolve an
// active listing at runtime from the live sitemap — pinning a slug here
// time-bombs once the listing expires into a soft-landing page (200, no
// <main>) and the `main` wait hits a 30 s timeout (incident 2026-06-03).
test('tailwind text-* utilities resolve on real <hN> after hydration: job-detail', async ({ page }) => {
  const path = await resolveActiveJobDetailPath(page);
  await assertTailwindHeadingsResolve(page, path);
});
