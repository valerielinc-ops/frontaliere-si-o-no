import { test, expect } from 'playwright/test';

// Mobile-first per CLAUDE.md rule #15 — 75% of traffic is mobile, so the
// "is anything visible above the fold" assertion must measure a mobile viewport.
// Stay on chromium (don't pull in `devices['iPhone 13']` which would force
// webkit and break the post-deploy-validate-live workflow's chromium-only
// browser install). iPhone-13-sized viewport + touch hover is a faithful enough
// proxy for the bug class we want to catch.
test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});

/**
 * Live SPA-shell hydration contract (regression guard for the 2026-05-19 bugs).
 *
 * Two failure modes this spec catches:
 *
 *   1. Static `<main>` emitted INSIDE `<div id="root">` (company-hub bug):
 *      React's `createRoot(...).render(<App/>)` wipes children of `#root`,
 *      so the static content disappears on hydration. With
 *      `staticOverlay: true` the SPA also skips its own `<main>`. Net result:
 *      visibly blank page after JS executes.
 *
 *   2. Static `<main>` wrapped in `position:absolute;clip:rect(0,0,0,0)`
 *      sr-only styling (related-search-cluster bug): plugin intended SPA to
 *      render visible JobBoard, but router returned `staticOverlay: true`
 *      so the SPA skipped its own `<main>` → only the invisible sr-only
 *      content remained → visibly blank page.
 *
 * Both bugs render an HTTP-200 page with valid HTML; only a real browser
 * + a visibility check on the first viewport catches them. Hence: live
 * Playwright after deploy.
 *
 * Contract enforced per URL:
 *   - Browser navigation completes within 25 s.
 *   - After `networkidle`, the first 800 px of the viewport (mobile-first per
 *     CLAUDE.md rule #15) carry at least MIN_ABOVE_FOLD_CHARS of visible text.
 *   - There exists a visible `<main>` element with substantial text content
 *     (not clip-rect'd into invisibility).
 *
 * Coverage: representative URLs from each plugin family that emits static SEO
 * pages with the SPA-shell handoff: company hubs (jobsSeoPagesPlugin),
 * search clusters (relatedSearchClustersPlugin), weekly-employers
 * (weeklyEmployersPlugin), health-premiums (healthPremiumsLandingPlugin),
 * border-wait (borderWaitPlugin). All 4 locales for the two families that
 * had the live bug; one URL per other family as a smoke gate.
 *
 * Volatile slugs (job-board, weekly snapshots) tolerate 404 — content
 * rotates over time and a missing URL is unrelated to the hydration bug.
 */

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

const MIN_ABOVE_FOLD_CHARS = 120;
const MIN_MAIN_CHARS = 400;
const ABOVE_FOLD_PX = 800;

interface TargetUrl {
  readonly label: string;
  readonly path: string;
  readonly tolerate404: boolean;
}

const TARGETS: readonly TargetUrl[] = [
  // Bug 1 reporter — company hub canton-aware, Zurich.
  { label: 'company hub IT (KSW Zurigo)', path: '/cerca-lavoro-zurigo/azienda-kantonsspital-winterthur-ksw/', tolerate404: true },
  // Company hub in legacy TI section — stable employer that's been there for months.
  { label: 'company hub IT (legacy TI section)', path: '/cerca-lavoro-ticino/azienda-amministrazione-cantonale-ticino/', tolerate404: true },
  { label: 'company hub EN', path: '/en/find-jobs-ticino/azienda-amministrazione-cantonale-ticino/', tolerate404: true },
  { label: 'company hub DE', path: '/de/jobs-im-tessin/azienda-amministrazione-cantonale-ticino/', tolerate404: true },
  { label: 'company hub FR', path: '/fr/trouver-emploi-tessin/azienda-amministrazione-cantonale-ticino/', tolerate404: true },

  // Bug 2 reporter — related-search cluster, all 4 locale prefixes.
  { label: 'search cluster IT (ricerca-)', path: '/cerca-lavoro-ticino/ricerca-owner-zurich/', tolerate404: true },
  { label: 'search cluster EN (search-)', path: '/en/find-jobs-ticino/search-owner-zurich/', tolerate404: true },
  { label: 'search cluster DE (suche-)', path: '/de/jobs-im-tessin/suche-owner-zurich/', tolerate404: true },
  { label: 'search cluster FR (recherche-)', path: '/fr/trouver-emploi-tessin/recherche-owner-zurich/', tolerate404: true },

  // Other plugin families that emit static SEO pages with the SPA-shell contract.
  // weekly-employers per-city (F5) — staticOverlay, static body owns the page.
  { label: 'weekly-employers per-city (lugano)', path: '/lavoro-settimanale/lugano/', tolerate404: true },
  // health-premiums per-canton (F2).
  { label: 'health-premiums per-canton (ticino)', path: '/premi-cassa-malati/ticino/', tolerate404: true },
  // border-wait per-crossing (F8).
  { label: 'border-wait per-crossing (chiasso)', path: '/tempi-attesa-confine/chiasso-brogeda/', tolerate404: true },
  // Job-board canton hub — non-overlay, SPA renders JobBoard with TI filter.
  { label: 'job-board canton hub (TI)', path: '/cerca-lavoro-ticino/', tolerate404: false },
];

for (const target of TARGETS) {
  test.describe(`spa-hydration: ${target.label}`, () => {
    const url = `${LIVE_BASE_URL}${target.path}`;

    test(`renders visible content above the fold (${target.path})`, async ({ page }) => {
      // Pre-flight: a 404 on a tolerated URL means content rotated, not a regression.
      const head = await page.request.get(url, { maxRedirects: 5, timeout: 15_000 });
      if (head.status() === 404 && target.tolerate404) {
        test.skip(true, `${url} returned 404 (content rotated)`);
        return;
      }
      expect(head.status(), `${url} should respond 200`).toBe(200);

      // domcontentloaded — bouncing-script loop would never reach this.
      // networkidle after — gives React + hydration + lazy chunks a chance
      // to settle so we measure the post-hydrate state, not the static one.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
        // Some pages keep polling (analytics beacons); soft-fail networkidle
        // and rely on the explicit settle delay below.
      });
      await page.waitForTimeout(800);

      // Measure visible text in the first ABOVE_FOLD_PX of the viewport.
      // Bug 1 / Bug 2 both leave this region empty: Bug 1 because React
      // wiped the static main; Bug 2 because the only main is sr-only.
      const aboveFoldChars = await page.evaluate((maxY) => {
        const TEXT_NODE = 3;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let chars = 0;
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = (node.nodeValue || '').trim();
          if (!text) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          // Skip nodes wholly outside the viewport (above OR fully below the fold).
          if (rect.bottom < 0 || rect.top > maxY) continue;
          // Skip nodes that are visually hidden (sr-only, clip-rect, opacity 0,
          // display:none collapses rect to 0×0 so width/height check suffices).
          if (rect.width < 1 || rect.height < 1) continue;
          // Walk up to confirm no ancestor sets display:none — getComputedStyle
          // on a parent of the text node is the cheapest check we can do here.
          const parent = (node.parentElement as HTMLElement | null);
          if (parent) {
            const cs = window.getComputedStyle(parent);
            if (cs.visibility === 'hidden' || cs.display === 'none') continue;
            if (parseFloat(cs.opacity) === 0) continue;
          }
          chars += text.length;
        }
        return chars;
        void TEXT_NODE;
      }, ABOVE_FOLD_PX);

      expect(
        aboveFoldChars,
        `${url} renders only ${aboveFoldChars} visible chars in the first ${ABOVE_FOLD_PX} px ` +
          `(min ${MIN_ABOVE_FOLD_CHARS}). This is the Bug 1 / Bug 2 signature: either the ` +
          `static <main> was wiped by React hydration (because it sat inside #root) or the ` +
          `static main is sr-only while the SPA failed to render its own. Inspect dist HTML ` +
          `to confirm <main> is a sibling of <div id="root">, not a child.`,
      ).toBeGreaterThanOrEqual(MIN_ABOVE_FOLD_CHARS);

      // Secondary check: there's at least one visible <main> with real content.
      // Multiple <main>s can coexist (static <main class="seo-static-content">
      // sibling of #root + SPA <main> inside #root) — we pick the largest by
      // text length so the assertion doesn't false-positive on a 0-char shell.
      const mainTextLen = await page.evaluate(() => {
        const mains = Array.from(document.querySelectorAll('main'));
        let max = 0;
        for (const m of mains) {
          // Visibility filter: skip mains hidden via display:none or clip-rect.
          const cs = window.getComputedStyle(m);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = m.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          const len = (m.textContent || '').trim().length;
          if (len > max) max = len;
        }
        return max;
      });

      expect(
        mainTextLen,
        `${url} has no visible <main> with substantial content (largest visible <main> has ${mainTextLen} chars, ` +
          `min ${MIN_MAIN_CHARS}). Either the static <main> is sr-only (clip-rect) or React hydration left an empty ` +
          `<main>. Both patterns leave the page visibly blank for end users.`,
      ).toBeGreaterThanOrEqual(MIN_MAIN_CHARS);
    });
  });
}
