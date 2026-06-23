/**
 * Regression gate: the staticOverlay SEO landings emitted by
 * `staticPagesPlugin.ts` (hubChromeSplit branch) MUST ship the side-rail portal
 * targets `#rail-left-root` / `#rail-right-root` that wrap the centre <main> in
 * the xlw rail grid. App.tsx mounts <ArticleRailAdStack> into them on
 * staticOverlay pages (App.tsx:2673 — activeTab-agnostic, fires whenever the
 * page is staticOverlay AND the DOM targets exist).
 *
 * Background: PR #2592 added the rails to the buildSimplePage / seoPageShell
 * path (htmlTemplate.ts) but MISSED `staticPagesPlugin.ts`, which hand-rolls its
 * own body for editorial / hub landings. So pages like
 * /vita-in-ticino/vacanze-scolastiche-ticino-2026/ rendered with NO rails while
 * fuel/health/profession landings already had them. The shared `railGutters()`
 * helper now feeds both emitters.
 *
 * Scope: the explicit non-job staticOverlay landings from
 * STATIC_OVERLAY_HUB_CHROME (vita-in-ticino + guida-frontaliere). These are
 * deterministic paths that all route through hubChromeSplit. Job-board hub /
 * detail / collection pages (jobsSeoPagesPlugin, separate emitter) are out of
 * scope for this gate — see the PR `## Non implementato`.
 *
 * Dist-driven: skips silently when a page is absent (so `npm test` works without
 * a build). CI runs `npm run build:ci` before tests, enforcing the gate.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST_DIR = resolve(__dirname, '..', 'dist');

/** Explicit staticOverlay portal landings owned by staticPagesPlugin. */
const PORTAL_LANDINGS: readonly string[] = [
  'vita-in-ticino/outlet-svizzera-fox-town-mendrisio',
  'vita-in-ticino/ponti-2026-ticino',
  'vita-in-ticino/vacanze-scolastiche-ticino-2026',
  'guida-frontaliere/lamal-frontalieri',
  'guida-frontaliere/tassa-salute-frontalieri',
];

function readLanding(slug: string): string | null {
  const file = join(DIST_DIR, slug, 'index.html');
  return existsSync(file) ? readFileSync(file, 'utf-8') : null;
}

describe('staticPagesPlugin staticOverlay landings emit the side-rail portal targets', () => {
  const present = PORTAL_LANDINGS.map((slug) => ({ slug, html: readLanding(slug) })).filter(
    (p): p is { slug: string; html: string } => p.html !== null,
  );

  if (present.length === 0) {
    it.skip('dist/ not populated — run `npm run build` to enforce', () => {
      // no-op
    });
    return;
  }

  it('every landing contains both rail portal targets in the xlw grid', () => {
    const offenders: string[] = [];

    for (const { slug, html } of present) {
      const ok =
        html.includes('id="rail-left-root"') &&
        html.includes('id="rail-right-root"') &&
        /xlw:grid-cols-\[300px_minmax\(0,1fr\)_300px\]/.test(html);
      if (!ok) offenders.push(slug);
    }

    expect(
      offenders,
      `Missing #rail-left-root / #rail-right-root (or the xlw grid) on ${offenders.length} ` +
        `staticOverlay landing(s): ${offenders.join(', ')}. App.tsx portals <ArticleRailAdStack> ` +
        `into them — without the targets the page renders no side-rail ads.`,
    ).toEqual([]);
  });

  it('orders the rails left | main | right and keeps footer-root last', () => {
    const offenders: string[] = [];

    for (const { slug, html } of present) {
      const left = html.indexOf('rail-left-root');
      const main = html.indexOf('<main class="seo-static-content"');
      const right = html.indexOf('rail-right-root');
      const footer = html.indexOf('<div id="footer-root">');
      if (left === -1 || right === -1) continue; // covered by the previous test

      const ordered = left < main && main < right && (footer === -1 || right < footer);
      if (!ordered) offenders.push(slug);
    }

    expect(
      offenders,
      `Rail gutters mis-ordered (expected left | main | right | footer) on: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
