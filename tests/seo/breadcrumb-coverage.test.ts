/**
 * Breadcrumb coverage — Workstream D.2
 *
 * Asserts that every **indexable** HTML file emitted in `dist/` includes
 * a `BreadcrumbList` JSON-LD block. The "indexable" qualifier matters:
 * `BreadcrumbList` is a SERP-display feature, so pages with
 * `<meta name="robots" content="noindex">` are exempt by design —
 * they never appear in SERPs. This exemption covers:
 *   - legacy redirect pages (`legacyRedirectsPlugin`)
 *   - the admin shell at `/gestione-contenuti-xk9mp2q/`
 *   - internal design-lab pages in `public/job-detail-*.html`
 *
 * Additional hard-coded allow-list (these are roots of the breadcrumb
 * chain or do not represent content pages):
 *   - `/index.html` (homepage)
 *   - `/404.html`   (GitHub Pages SPA fallback)
 *
 * Mirror of `scripts/audit-breadcrumb-coverage.mjs` — that script sibling
 * runs inside `npm run audit:all`, blocking, against the SAME dist/ as part
 * of the single unified walk (`validate-dist-postbuild` job). Per the
 * pattern `tests/seo/faqpage-validity.test.ts` and
 * `tests/seo/image-object-license-fields.test.ts` already established, this
 * file therefore only runs when `RUN_DIST_GATES=1` is set (opt-in, no
 * workflow sets it) — running it unconditionally inside `gate:seo-source`
 * was a SECOND full-corpus walk of a dist/ that has outgrown what a vitest
 * gate can bound in wall time (issue #5874: the walk aborted after its
 * budget, 768k files in, never reaching a verdict). The real gate is the
 * audit-all auditor; this vitest copy stays as a standalone/manual check.
 *
 * Breadcrumb injection is verified in each page-emitting build plugin:
 *   - build-plugins/staticPagesPlugin.ts
 *   - build-plugins/jobsSeoPagesPlugin.ts
 *   - build-plugins/ogPagesPlugin.ts
 *   - build-plugins/pdfWhitepapersPlugin.ts
 *   - build-plugins/*Landing*.ts
 *   - build-plugins/*Pages*.ts
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SCAN_TEST_TIMEOUT_MS,
  assertScanCompleted,
  scanDistHtml,
} from '../helpers/distHtmlScan';

const DIST_ROOT = resolve(__dirname, '..', '..', 'dist');

const ALLOWED_MISSING: ReadonlySet<string> = new Set([
  '/404.html',
  '/index.html',
  '/', // homepage emitted as /index.html — safe to list twice.
]);

const BREADCRUMB_JSONLD_RE = /"@type"\s*:\s*"BreadcrumbList"/;
// Quote-flexible: scripts/dist-shrink.mjs removes attribute quotes, so
// `name="robots" content="noindex,follow"` becomes
// `name=robots content="noindex,follow"` (commas force quotes, plain
// `name=robots` does not). Match both shapes.
const NOINDEX_RE =
  /<meta[^>]*\bname\s*=\s*["']?robots["']?[^>]*\bcontent\s*=\s*["']?[^"'>]*noindex/i;
// Canonical bridge pages (built via `buildCanonicalBridgePage` in
// build-plugins/constants.ts) ship the signature hero string
// "Questa URL legacy" (or its localised variant) + a `<link rel="canonical">`
// pointing at a different URL. They exist only to consolidate crawl signals
// from legacy slugs/redirects into the primary canonical — BreadcrumbList on
// them would confuse SERPs because they never surface directly. The
// canonical target already carries the breadcrumb.
const BRIDGE_PAGE_RE = /Questa URL\s+(?:legacy|azienda|alias|di ricerca|dell[’'\\s]annuncio)/i;

function fileToUrlPath(relPath: string): string {
  if (relPath === '/index.html') return '/index.html';
  if (relPath.endsWith('/index.html')) return relPath.slice(0, -'index.html'.length);
  return relPath;
}

describe('SEO: breadcrumb coverage (D.2)', () => {
  if (process.env.RUN_DIST_GATES !== '1' || !existsSync(DIST_ROOT)) {
    it.skip('set RUN_DIST_GATES=1 after `npx vite build` to enable this gate — the real gate is npm run audit:breadcrumb-coverage (audit-all)', () => {
      /* intentional skip */
    });
    return;
  }

  // Scans EVERY indexable page (breadcrumb coverage cannot be sampled like
  // cathedral-hreflang-x-default), so this must use the shared streaming
  // scan — a materialised string[] of dist/'s ~3.8M HTML files run inside
  // describe() itself (not an it()) is the exact OOM/stall pattern #5729
  // fixed for the four gate:dist-quality tests. This file is opt-in
  // (RUN_DIST_GATES=1, see file header) and no workflow sets it — the real
  // gate is scripts/audit-breadcrumb-coverage.mjs via `npm run audit:all`.
  it('every non-exempt dist/ HTML page includes a BreadcrumbList JSON-LD block', { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
    const missing: Array<{ url: string; file: string }> = [];

    const scan = scanDistHtml(DIST_ROOT, (relPath, html) => {
      const url = fileToUrlPath(relPath);
      if (ALLOWED_MISSING.has(url)) return;
      // Zero-byte files are corrupted artifacts (e.g. from an OOM crash
      // mid-build), not real indexable pages — skip rather than count as a
      // coverage gap.
      if (html.length === 0) return;
      // Noindex pages never surface BreadcrumbList in SERPs — skip by design.
      if (NOINDEX_RE.test(html)) return;
      // Canonical bridge pages consolidate signals into their canonical target
      // and are therefore exempt from the breadcrumb coverage requirement.
      if (BRIDGE_PAGE_RE.test(html)) return;
      if (!BREADCRUMB_JSONLD_RE.test(html)) {
        missing.push({ url, file: `dist${relPath}` });
      }
    });
    assertScanCompleted(
      scan,
      'breadcrumb coverage',
      missing.map((m) => `${m.url}  (${m.file})`),
    );

    if (missing.length > 0) {
      const sample = missing.slice(0, 20).map((m) => `  - ${m.url}  (${m.file})`).join('\n');
      const tail = missing.length > 20 ? `\n  …and ${missing.length - 20} more` : '';
      throw new Error(
        `Breadcrumb coverage gap: ${missing.length} page(s) missing BreadcrumbList JSON-LD:\n${sample}${tail}`
      );
    }
    expect(missing).toEqual([]);
  });
});
