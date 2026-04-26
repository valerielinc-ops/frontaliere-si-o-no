/**
 * Phase 2-hreflang regression test.
 *
 * Walks every `dist/*.html` produced by the build and asserts that every
 * `<link rel="alternate" hreflang="...">` tag points at a target that
 * actually exists on disk. The hreflangPostprocessPlugin is responsible
 * for stripping broken alternates; this test guards against future
 * emitters bypassing that guard.
 *
 * Skips automatically when `dist/` is absent (e.g. plain `npm test`
 * without a prior build). Used by the CI pipeline which runs after
 * `vite build`.
 *
 * Performance: dist/ may contain ~200k HTML files (every job listing × 4
 * locales). To keep the test fast we (a) build a Set of existing
 * pathnames in one pass, then (b) check hreflang targets via O(1) Set
 * lookup. Empirically this runs in <30s on the full dist/.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BASE = 'https://frontaliereticino.ch';

const HREFLANG_RX =
  /<link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s*\/?>/g;

function* walkHtml(dir: string): Iterable<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      yield* walkHtml(p);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      yield p;
    }
  }
}

/**
 * Build a Set of every reachable pathname (relative to DIST, no leading
 * slash, no trailing slash) so hreflang lookups are O(1).
 *
 * Each emitted HTML produces TWO keys: the directory form (`foo/bar` for
 * `foo/bar/index.html`) and the flat-stem form (`foo/bar` for
 * `foo/bar.html`). They collapse to the same key so a single lookup
 * matches either layout.
 */
function buildPathSet(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const file of walkHtml(DIST)) {
    const rel = path.relative(DIST, file).replace(/\\/g, '/');
    if (rel === 'index.html') {
      out.add('');
      continue;
    }
    if (rel.endsWith('/index.html')) {
      out.add(rel.slice(0, -'/index.html'.length));
    } else if (rel.endsWith('.html')) {
      out.add(rel.slice(0, -'.html'.length));
    }
  }
  return out;
}

function hrefToKey(href: string): string | null {
  if (!href.startsWith(BASE)) return null;
  const rel = href.slice(BASE.length).replace(/\/+$/, '');
  if (rel === '' || rel === '/') return '';
  return rel.startsWith('/') ? rel.slice(1) : rel;
}

describe('hreflang alternates point to existing files', () => {
  const distExists = fs.existsSync(DIST);

  (distExists ? it : it.skip)(
    'every hreflang link in dist/*.html resolves to a file on disk',
    async () => {
      const existing = buildPathSet();
      const broken: Array<{ file: string; locale: string; href: string }> = [];
      let totalLinks = 0;

      for (const file of walkHtml(DIST)) {
        const html = fs.readFileSync(file, 'utf-8');
        if (!html.includes('hreflang=')) continue;
        HREFLANG_RX.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = HREFLANG_RX.exec(html)) !== null) {
          totalLinks++;
          const [, locale, href] = m;
          const key = hrefToKey(href);
          if (key === null) continue; // off-host
          if (!existing.has(key)) {
            broken.push({
              file: path.relative(DIST, file),
              locale,
              href,
            });
            // Cap collection — one broken hreflang fails the suite; we just
            // need a reasonable diagnostic sample.
            if (broken.length >= 25) return assertEmpty(broken, totalLinks);
          }
        }
      }

      assertEmpty(broken, totalLinks);
    },
    240_000,
  );
});

function assertEmpty(
  broken: Array<{ file: string; locale: string; href: string }>,
  totalLinks: number,
): void {
  const sample = broken.slice(0, 10);
  expect(
    broken.length,
    `Found ${broken.length}+ broken hreflang(s) out of ${totalLinks} total. ` +
      `Sample: ${JSON.stringify(sample, null, 2)}`,
  ).toBe(0);
}
