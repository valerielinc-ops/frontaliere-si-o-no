/**
 * P3-A — Mobile-first element order check for the canton-landing pages
 * emitted by `build-plugins/jobsSeoPagesPlugin.ts` (Phase 4 of the cathedral
 * canton-aware completion).
 *
 * CLAUDE.md NON-NEGOTIABLE #17 mandates this element order on every static
 * SEO landing page emitted by a build plugin:
 *
 *   <nav> breadcrumb
 *   <header> (eyebrow · H1 · 1-line tagline ≤120 chars)
 *   stat tile grid (3-5 tiles, OKLCH semantic tokens)
 *   primary CTA  (above the fold on mobile)
 *   data area    (listing grid / table / cards)
 *   long prose   (intro / methodology / frontaliere context / FAQ) — BELOW
 *
 * Pre-cathedral, the non-TI canton landings were skeleton pages —
 * H1 + 1-line lede + CTA + prose only, no tiles, no listings. Phase 4 fills
 * them in. This test guards the order so a future refactor cannot regress
 * back into the "filler above content" anti-pattern (CLAUDE.md #16).
 *
 * The TI canton-landing (/cerca-lavoro-ticino/) is owned by
 * `build-plugins/staticPagesPlugin.ts` and is intentionally NOT covered
 * here — Phase 4's TI-invariance contract says that file stays
 * byte-identical, so we only assert on cantons emitted by
 * `jobsSeoPagesPlugin`.
 *
 * The test is also skip-tolerant: when `dist/` has not been built (CI
 * matrix slot that runs only unit tests, no Vite build), the assertions
 * silently no-op rather than fail. This lets the test ship without
 * coupling to a specific CI shard order.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

/**
 * Shared order-assertion, factored out so the synthetic-fixture regression
 * test below exercises the exact same logic as the real dist/ check.
 */
function assertCantonLandingOrder(rawHtml: string, label: string): void {
  // Strip <script>...</script> blocks (JSON-LD structured data) before
  // measuring element order. The CollectionPage/ItemList schema emitted
  // in <head> embeds each job's raw title (`mainEntity.itemListElement[]
  // .name`), and those titles are free text pulled straight from the
  // source job posting. Stripping <script> blocks scopes every marker
  // search to actual rendered markup.
  const html = rawHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  const h1 = html.indexOf('<h1');
  const tiles = html.indexOf('data-stat-tile-grid');
  // Primary CTA = the anchor explicitly marked with `data-primary-cta`
  // in build-plugins/jobsSeoPagesPlugin.ts. Stable marker independent of
  // CSS implementation: PR #454 extracted inline styles to content-hashed
  // classes, so the previous `style="...background:var(--color-accent)..."`
  // selector no longer matched.
  const cta = html.search(/<a [^>]*\bdata-primary-cta\b/);
  const listing = html.indexOf('data-listing-grid');
  // Prose anchor — the buildCantonContextProse section's wrapper, marked
  // with the stable `data-canton-context-prose` attribute (mirrors the
  // data-stat-tile-grid / data-primary-cta / data-listing-grid
  // convention). Previously this searched for the first occurrence of a
  // locale lead-word ('Lavorare'/'Working'/'Arbeiten'/'Travailler')
  // anywhere in the HTML as a proxy for "where prose starts" — but that
  // collided with unrelated free text appearing earlier in the page
  // (e.g. an ATS-sourced `topSector` stat tile value containing
  // "Working"/"Home Working"), producing false positives (root cause of
  // #3232, a recurrence of the same substring-collision bug class
  // previously hit via JSON-LD job titles like "... (Working Student)
  // 60%"). A content-independent structural marker closes this class of
  // false positive permanently, regardless of what free text (job
  // titles, sector names, company names) appears anywhere else on the
  // page.
  const prose = html.indexOf('data-canton-context-prose');

  expect(h1, `${label}: H1 missing`).toBeGreaterThan(0);
  expect(tiles, `${label}: stat tile grid missing`).toBeGreaterThan(h1);
  expect(cta, `${label}: primary CTA missing or before tiles`).toBeGreaterThan(tiles);
  // Listing grid is optional: a canton with zero canonical jobs renders
  // the tiles + CTA + prose but no listing grid. When present, it MUST
  // come after the CTA and before the prose.
  if (listing > 0) {
    expect(listing, `${label}: listing grid must come after CTA`).toBeGreaterThan(cta);
    if (prose > 0) {
      expect(prose, `${label}: prose must come after listings`).toBeGreaterThan(listing);
    }
  } else if (prose > 0) {
    // No listings → prose comes directly after CTA.
    expect(prose, `${label}: prose must come after CTA`).toBeGreaterThan(cta);
  }
}

describe('canton landing mobile-first element order (CLAUDE.md #17)', () => {
  // Three representative IT-locale cantons from different language regions:
  // ZH (German-speaking), GE (French-speaking), VD (French-speaking) — gives
  // coverage across the locale tile-label paths without exploding the matrix.
  const cantons = ['cerca-lavoro-zurigo', 'cerca-lavoro-ginevra', 'cerca-lavoro-vaud'];

  for (const canton of cantons) {
    it(`${canton}/index.html order: H1 → tiles → CTA → listings → prose`, () => {
      const file = path.join(DIST, canton, 'index.html');
      if (!fs.existsSync(file)) {
        // No dist/ in this run (e.g. unit-test-only CI shard) — silently
        // skip. The deploy/CI shard that runs `npm run build:ci` will hit
        // the real assertions.
        return;
      }
      const rawHtml = fs.readFileSync(file, 'utf8');
      assertCantonLandingOrder(rawHtml, canton);
    });
  }

  // Regression fixture for #3232: reproduces the exact false-positive shape
  // that broke `cerca-lavoro-zurigo` — a stat tile rendering an ATS-sourced
  // `topSector` free-text value ("Home Working") that appears in the markup
  // BEFORE the real listing grid / prose section. This does not depend on a
  // built dist/, so it always runs (no build-fixture skip) and pins the fix
  // independently of CI shard/build availability.
  it('does not mistake a free-text stat-tile value for the prose section (#3232 regression)', () => {
    const collidingHtml = [
      '<main>',
      '<nav>breadcrumb</nav>',
      '<header><h1>Zurigo</h1><p>lede</p></header>',
      // Stat tile grid: one tile renders a raw ATS sector string containing
      // an English loanword that used to be mistaken for the prose marker.
      '<section data-stat-tile-grid><div class="tile">Home Working</div></section>',
      '<p><a data-primary-cta href="/lavoro/">Vedi le offerte</a></p>',
      '<section data-listing-grid><article>Job Title (Working Student) 60%</article></section>',
      // The real prose section, correctly placed after the listing grid.
      '<section class="s-0P4kC8" data-canton-context-prose>',
      '<h2>Lavorare nel Canton Zurigo come frontaliere</h2>',
      '<p>...</p>',
      '</section>',
      '</main>',
    ].join('');

    // Sanity check on the fixture itself: the old substring search WOULD
    // have found "Working" inside the stat tile, before the listing grid —
    // i.e. this fixture genuinely reproduces the #3232 false positive.
    const legacyProseCandidates = ['Lavorare', 'Working', 'Arbeiten', 'Travailler'];
    const legacyProseIdx = legacyProseCandidates
      .map((w) => collidingHtml.indexOf(w))
      .filter((i) => i > 0)
      .sort((a, b) => a - b)[0] ?? -1;
    const listingIdx = collidingHtml.indexOf('data-listing-grid');
    expect(
      legacyProseIdx,
      'fixture must reproduce the pre-fix false positive (legacy prose hit before the listing grid)'
    ).toBeLessThan(listingIdx);

    // The fixed assertion, using the stable marker, must pass despite the
    // colliding free text in both the stat tile and the listing grid.
    expect(() => assertCantonLandingOrder(collidingHtml, 'synthetic-fixture')).not.toThrow();
  });
});
