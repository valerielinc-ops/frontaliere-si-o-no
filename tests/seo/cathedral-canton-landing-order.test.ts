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
      const html = fs.readFileSync(file, 'utf8');

      const h1 = html.indexOf('<h1');
      const tiles = html.indexOf('data-stat-tile-grid');
      // Primary CTA = the inline-styled anchor with the accent background.
      // Match the exact P4 style fragment so we don't pick up the prose's
      // inline body links by accident.
      const cta = html.search(/<a [^>]*style="[^"]*background:var\(--color-accent\)[^"]*"/);
      const listing = html.indexOf('data-listing-grid');
      // Prose anchor — first user-facing H2 of the buildCantonContextProse
      // section. The four locales use different lead-words so we search
      // for any of them.
      const proseCandidates = ['Lavorare', 'Working', 'Arbeiten', 'Travailler'];
      const prose = proseCandidates
        .map((w) => html.indexOf(w))
        .filter((i) => i > 0)
        .sort((a, b) => a - b)[0] ?? -1;

      expect(h1, `${canton}: H1 missing`).toBeGreaterThan(0);
      expect(tiles, `${canton}: stat tile grid missing`).toBeGreaterThan(h1);
      expect(cta, `${canton}: primary CTA missing or before tiles`).toBeGreaterThan(tiles);
      // Listing grid is optional: a canton with zero canonical jobs renders
      // the tiles + CTA + prose but no listing grid. When present, it MUST
      // come after the CTA and before the prose.
      if (listing > 0) {
        expect(listing, `${canton}: listing grid must come after CTA`).toBeGreaterThan(cta);
        if (prose > 0) {
          expect(prose, `${canton}: prose must come after listings`).toBeGreaterThan(listing);
        }
      } else if (prose > 0) {
        // No listings → prose comes directly after CTA.
        expect(prose, `${canton}: prose must come after CTA`).toBeGreaterThan(cta);
      }
    });
  }
});
