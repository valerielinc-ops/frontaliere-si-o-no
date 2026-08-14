/**
 * staticPagesPlugin — the locale-root skip guard must be able to fire, and
 * must be tested exactly once (issue #5369 §8).
 *
 * What was wrong
 * --------------
 * `closeBundle` walks `italianUrls`, whose elements are `SitemapUrl`s built as:
 *
 *     const pathNoSlash = rawPath === '/' ? '/' : rawPath.replace(/\/+$/, '');
 *     urls.push({ loc, path: pathNoSlash, canonicalPath, hreflangs, priority });
 *
 * i.e. `url.path` is NORMALIZED WITHOUT a trailing slash — `/` is the only path
 * that keeps one. The guard that issue #5468 added to hand `/en/`, `/de/`,
 * `/fr/` to the post-loop "Locale-root SPA shells" ratchet nevertheless read
 *
 *     const isLocaleRoot = url.path === '/en/' || url.path === '/de/' || …
 *
 * which cannot be true for ANY input. The guard was inert: what actually keeps
 * the three locale roots out of that loop today is the `italianUrls` filter
 * (`!p.startsWith('/en')` &c.) — a second, unrelated mechanism. So the write
 * race #5468 closed was being held shut by something other than the code that
 * claims to hold it shut, and relaxing the filter would have reopened it with
 * a green CI.
 *
 * Twelve lines below the guard the SAME condition was tested a second time, to
 * inject the homepage SEO block. That test was unreachable by local control
 * flow whatever `url.path` holds, because the guard above it `continue`s.
 *
 * Why this file scans the source instead of importing the plugin
 * --------------------------------------------------------------
 * Importing `build-plugins/staticPagesPlugin` pulls ~12 files under `data/`
 * and `public/assets/` at module scope, which are git-tracked but absent from
 * a sparse worktree — an import-based test is red locally and green in CI (see
 * CLAUDE.md, and `tests/build-plugins/localeRootMainNav.test.ts`, which does
 * import it and therefore only runs in a full checkout). The invariants here
 * are syntactic, so a text scan proves them in both places.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  path.resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'),
  'utf-8',
);

/** `url.path === '/en'` … in either the slashed or unslashed form. */
const LOCALE_ROOT_TRIPLE_RX =
  /url\.path === '\/en\/?' \|\| url\.path === '\/de\/?' \|\| url\.path === '\/fr\/?'/g;

describe('staticPagesPlugin — SitemapUrl.path is trailing-slash free', () => {
  it('builds `path` by stripping the trailing slash (the premise of every === comparison on it)', () => {
    // If this ever changes, the guard below must change with it — that is the
    // whole point of pinning the producer and the consumer in one file.
    expect(SOURCE).toMatch(
      /const pathNoSlash = rawPath === '\/' \? '\/' : rawPath\.replace\(\/\\\/\+\$\/, ''\);/,
    );
    expect(SOURCE).toMatch(/urls\.push\(\{ loc, path: pathNoSlash,/);
    expect(SOURCE).toContain('path: string; // normalized path without trailing slash');
  });
});

describe('staticPagesPlugin — locale-root skip guard (issue #5468, repaired in #5369)', () => {
  it('compares against the unslashed form, so the guard can actually fire', () => {
    const line = SOURCE.split('\n').find((l) => l.includes('const isLocaleRoot ='));
    expect(line, '`const isLocaleRoot = …` not found — has the guard been renamed?').toBeTruthy();
    // The slashed form is the defect: it can never equal a normalized url.path.
    expect(
      line,
      "isLocaleRoot compares against '/en/' — url.path never carries a trailing slash, so the guard is inert",
    ).not.toMatch(/'\/en\/'|'\/de\/'|'\/fr\/'/);
    for (const p of ["'/en'", "'/de'", "'/fr'"]) {
      expect(line, `isLocaleRoot must test ${p}`).toContain(p);
    }
  });

  it('the guard continues, handing the three locale roots to the post-loop ratchet', () => {
    const idx = SOURCE.indexOf('const isLocaleRoot =');
    expect(idx).toBeGreaterThan(-1);
    // The next statement must be the skip: `if (isLocaleRoot) { count++; continue; }`.
    expect(SOURCE.slice(idx, idx + 200)).toMatch(
      /if \(isLocaleRoot\) \{\s*\n\s*count\+\+;\s*\n\s*continue;/,
    );
  });

  it('tests the locale-root condition exactly once (no branch re-tests what the guard already continued on)', () => {
    const hits = SOURCE.match(LOCALE_ROOT_TRIPLE_RX) ?? [];
    expect(
      hits.length,
      `the /en|/de|/fr triple appears ${hits.length}× — a second test after the guard's ` +
        'continue is unreachable by local control flow: ' + JSON.stringify(hits),
    ).toBe(1);
    // …and the one occurrence is the guard's own assignment.
    const line = SOURCE.split('\n').find((l) => LOCALE_ROOT_TRIPLE_RX.test(l));
    LOCALE_ROOT_TRIPLE_RX.lastIndex = 0;
    expect(line).toContain('const isLocaleRoot =');
  });

  it('the post-loop ratchet is the single owner of the locale-root SEO block', () => {
    // The reason the deleted branch is not missed: renderLocaleRootShell runs
    // unconditionally for en/de/fr after the loop and is idempotent.
    expect(SOURCE).toMatch(/out = injectHomepageSeoContent\(out, locale\);/);
    expect(SOURCE).toContain('Locale-root SPA shells');
    const ratchetIdx = SOURCE.indexOf('// ── Locale-root SPA shells');
    expect(ratchetIdx).toBeGreaterThan(-1);
    expect(SOURCE.slice(ratchetIdx, ratchetIdx + 2000)).toMatch(
      /for \(const loc of \['en', 'de', 'fr'\] as const\)/,
    );
    expect(SOURCE.slice(ratchetIdx, ratchetIdx + 2000)).toContain('renderLocaleRootShell');
  });
});
