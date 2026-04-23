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
 * The test is a **no-op when `dist/` does not exist or is empty**, so it
 * does not require a pre-build step to run (Vitest will just skip).
 * In CI, the suite runs AFTER `vite build` (see pre-push hook), so any
 * indexable page missing breadcrumbs will fail the push.
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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DIST_ROOT = join(REPO_ROOT, 'dist');

const ALLOWED_MISSING: ReadonlySet<string> = new Set([
  '/404.html',
  '/index.html',
  '/', // homepage emitted as /index.html — safe to list twice.
]);

const BREADCRUMB_JSONLD_RE = /"@type"\s*:\s*"BreadcrumbList"/;
const NOINDEX_RE = /<meta[^>]*\bname\s*=\s*["']robots["'][^>]*\bcontent\s*=\s*["'][^"']*noindex/i;
// Canonical bridge pages (built via `buildCanonicalBridgePage` in
// build-plugins/constants.ts) ship the signature hero string
// "Questa URL legacy" (or its localised variant) + a `<link rel="canonical">`
// pointing at a different URL. They exist only to consolidate crawl signals
// from legacy slugs/redirects into the primary canonical — BreadcrumbList on
// them would confuse SERPs because they never surface directly. The
// canonical target already carries the breadcrumb.
const BRIDGE_PAGE_RE = /Questa URL\s+(?:legacy|azienda|alias|di ricerca|dell[’'\\s]annuncio)/i;

function walkHtml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === 'assets' || name === 'node_modules') continue;
        stack.push(full);
      } else if (st.isFile() && full.endsWith('.html')) {
        out.push(full);
      }
    }
  }
  return out;
}

function fileToUrlPath(filePath: string, distRoot: string): string {
  const rel = '/' + relative(distRoot, filePath).split('\\').join('/');
  if (rel === '/index.html') return '/index.html';
  if (rel.endsWith('/index.html')) return rel.slice(0, -'index.html'.length);
  return rel;
}

describe('SEO: breadcrumb coverage (D.2)', () => {
  const files = walkHtml(DIST_ROOT);

  if (files.length === 0) {
    it.skip('no dist/ — run `vite build` first to exercise coverage', () => {
      /* intentional skip */
    });
    return;
  }

  const missing: Array<{ url: string; file: string }> = [];

  for (const f of files) {
    const url = fileToUrlPath(f, DIST_ROOT);
    if (ALLOWED_MISSING.has(url)) continue;
    const html = readFileSync(f, 'utf-8');
    // Noindex pages never surface BreadcrumbList in SERPs — skip by design.
    if (NOINDEX_RE.test(html)) continue;
    // Canonical bridge pages consolidate signals into their canonical target
    // and are therefore exempt from the breadcrumb coverage requirement.
    if (BRIDGE_PAGE_RE.test(html)) continue;
    if (!BREADCRUMB_JSONLD_RE.test(html)) {
      missing.push({ url, file: relative(REPO_ROOT, f) });
    }
  }

  it('every non-exempt dist/ HTML page includes a BreadcrumbList JSON-LD block', () => {
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
