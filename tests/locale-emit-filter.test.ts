import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * localeEmitFilter reads BUILD_LOCALE once at module load, so each scenario
 * sets the env var and re-imports the module via vi.resetModules().
 */
async function loadFilter(buildLocale: string | undefined) {
  vi.resetModules();
  const prev = process.env.BUILD_LOCALE;
  if (buildLocale === undefined) delete process.env.BUILD_LOCALE;
  else process.env.BUILD_LOCALE = buildLocale;
  try {
    return await import('../build-plugins/shared/localeEmitFilter');
  } finally {
    if (prev === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = prev;
  }
}

const DIST = '/home/runner/work/repo/repo/dist';

afterEach(() => {
  vi.resetModules();
});

describe('localeEmitFilter — default (no BUILD_LOCALE) is a pure no-op', () => {
  it('emits all four locales and reports the filter inactive', async () => {
    const f = await loadFilter(undefined);
    expect(f.EMIT_ALL_LOCALES).toBe(true);
    for (const loc of ['it', 'en', 'de', 'fr']) {
      expect(f.shouldEmitLocale(loc)).toBe(true);
    }
    // Every path is emitted regardless of locale prefix.
    expect(f.shouldEmitPath(`${DIST}/en/find-jobs/x/index.html`, DIST)).toBe(true);
    expect(f.shouldEmitPath(`${DIST}/cerca-lavoro/x/index.html`, DIST)).toBe(true);
    expect(f.shouldEmitPath(`${DIST}/sitemap.xml`, DIST)).toBe(true);
  });

  it('treats empty / whitespace / garbage BUILD_LOCALE as all-locales (never an empty shard)', async () => {
    for (const raw of ['', '   ', ',', 'xx', 'spanish']) {
      const f = await loadFilter(raw);
      expect(f.EMIT_ALL_LOCALES, `raw=${JSON.stringify(raw)}`).toBe(true);
      expect(f.shouldEmitLocale('de')).toBe(true);
    }
  });
});

describe('localeEmitFilter — locale ownership of dist paths', () => {
  it('classifies prefixed subtrees and root/shared files correctly', async () => {
    const f = await loadFilter('en'); // any active filter; localeOfDistPath is filter-independent
    expect(f.localeOfDistPath(`${DIST}/en/find-jobs/x/index.html`, DIST)).toBe('en');
    expect(f.localeOfDistPath(`${DIST}/de/jobs/x/index.html`, DIST)).toBe('de');
    expect(f.localeOfDistPath(`${DIST}/fr/emploi/x/index.html`, DIST)).toBe('fr');
    // IT lives at the root.
    expect(f.localeOfDistPath(`${DIST}/cerca-lavoro-ticino/x/index.html`, DIST)).toBe('it');
    // Shared / non-locale artifacts → it (ship in the main shard).
    expect(f.localeOfDistPath(`${DIST}/sitemap.xml`, DIST)).toBe('it');
    expect(f.localeOfDistPath(`${DIST}/robots.txt`, DIST)).toBe('it');
    expect(f.localeOfDistPath(`${DIST}/data/jobs-en.json`, DIST)).toBe('it');
    expect(f.localeOfDistPath(`${DIST}/assets/index-abc.js`, DIST)).toBe('it');
    // A path that merely CONTAINS a locale token mid-tree is still it
    // (only the leading segment decides ownership).
    expect(f.localeOfDistPath(`${DIST}/cerca/enoteca/index.html`, DIST)).toBe('it');
  });
});

describe('localeEmitFilter — single-locale shard', () => {
  it('BUILD_LOCALE=en emits only the en subtree, drops it/de/fr writes', async () => {
    const f = await loadFilter('en');
    expect(f.EMIT_ALL_LOCALES).toBe(false);
    expect(f.shouldEmitLocale('en')).toBe(true);
    expect(f.shouldEmitLocale('it')).toBe(false);
    expect(f.shouldEmitLocale('de')).toBe(false);

    expect(f.shouldEmitPath(`${DIST}/en/find-jobs/x/index.html`, DIST)).toBe(true);
    expect(f.shouldEmitPath(`${DIST}/de/jobs/x/index.html`, DIST)).toBe(false);
    // Root + shared files belong to it → NOT emitted by the en shard.
    expect(f.shouldEmitPath(`${DIST}/cerca-lavoro-ticino/x/index.html`, DIST)).toBe(false);
    expect(f.shouldEmitPath(`${DIST}/sitemap.xml`, DIST)).toBe(false);
  });

  it('BUILD_LOCALE=it owns the root + shared files, drops en/de/fr', async () => {
    const f = await loadFilter('it');
    expect(f.shouldEmitPath(`${DIST}/cerca-lavoro-ticino/x/index.html`, DIST)).toBe(true);
    expect(f.shouldEmitPath(`${DIST}/sitemap.xml`, DIST)).toBe(true);
    expect(f.shouldEmitPath(`${DIST}/robots.txt`, DIST)).toBe(true);
    expect(f.shouldEmitPath(`${DIST}/en/find-jobs/x/index.html`, DIST)).toBe(false);
  });
});

describe('localeEmitFilter — ownerEmitLocale normalises hreflang values to the owning base locale', () => {
  it('maps x-default to it and strips region/script subtags', async () => {
    const f = await loadFilter('en'); // filter-independent, any active value works
    expect(f.ownerEmitLocale('x-default')).toBe('it');
    expect(f.ownerEmitLocale('X-Default')).toBe('it');
    // Region/script-tagged values collapse to their base locale.
    expect(f.ownerEmitLocale('en-US')).toBe('en');
    expect(f.ownerEmitLocale('de-CH')).toBe('de');
    expect(f.ownerEmitLocale('fr-CH')).toBe('fr');
    expect(f.ownerEmitLocale('zh-Hant')).toBe('zh');
    // Plain base locales pass through (lowercased); unknown values unchanged.
    expect(f.ownerEmitLocale('it')).toBe('it');
    expect(f.ownerEmitLocale('EN')).toBe('en');
    expect(f.ownerEmitLocale('  de  ')).toBe('de');
    expect(f.ownerEmitLocale('es')).toBe('es');
  });
});

describe('localeEmitFilter — multi-locale shard (comma list)', () => {
  it('BUILD_LOCALE=en,de emits both, drops it/fr', async () => {
    const f = await loadFilter('en, DE'); // trims + lowercases
    expect(f.EMIT_ALL_LOCALES).toBe(false);
    expect(f.shouldEmitLocale('en')).toBe(true);
    expect(f.shouldEmitLocale('de')).toBe(true);
    expect(f.shouldEmitLocale('fr')).toBe(false);
    expect(f.shouldEmitLocale('it')).toBe(false);
    expect(f.shouldEmitPath(`${DIST}/en/x/index.html`, DIST)).toBe(true);
    expect(f.shouldEmitPath(`${DIST}/de/x/index.html`, DIST)).toBe(true);
    expect(f.shouldEmitPath(`${DIST}/fr/x/index.html`, DIST)).toBe(false);
  });
});

/**
 * Regression for the fatal `[trunk-guard]` on `dist/{en,de,fr}.html` that
 * failed every validate-dist job of run 31240103446 (issue #5327 class).
 *
 * `isLocaleRootPath` is what staticPagesPlugin's locale-variant loop consults
 * before writing the flat `.html` twin of a page it just emitted as
 * `<path>/index.html`. The bare locale roots are the one place that twin must
 * not be written: `dist/en.html` is routed to the en shard by
 * locale-router.js's LOCALE_RE, never reaches it, and is redundant with
 * `dist/en/index.html` — which is what `/en/` (canonical, and the 301 target
 * of `/en`) is actually served from.
 *
 * The two negative families matter as much as the positives. A predicate that
 * merely tested `startsWith('/en')` would also swallow `/enterprise` and every
 * real locale page (`/en/find-jobs-ticino`), silently stripping the flat twin
 * from ~1M pages that legitimately have one.
 */
describe('localeEmitFilter — isLocaleRootPath (flat locale-root twin guard)', () => {
  it('matches the bare locale roots in every slash/case shape', async () => {
    const f = await loadFilter(undefined); // env-independent: a pure predicate
    for (const p of ['/en', 'en', '/en/', 'en/', '//en//', '/EN', '  /en  ', '/de', '/fr']) {
      expect(f.isLocaleRootPath(p), `${JSON.stringify(p)} is a bare locale root`).toBe(true);
    }
  });

  it('does not match locale PAGES — they keep their flat twin', async () => {
    const f = await loadFilter(undefined);
    for (const p of [
      '/en/find-jobs-ticino',
      '/en/find-jobs-ticino/',
      '/de/jobs-im-tessin',
      '/fr/trouver-emploi-tessin',
      '/en/cross-border-articles/some-slug',
    ]) {
      expect(f.isLocaleRootPath(p), `${JSON.stringify(p)} is a page, not a root`).toBe(false);
    }
  });

  it('does not match look-alikes, the IT root, or non-locale prefixes', async () => {
    const f = await loadFilter(undefined);
    for (const p of [
      '/', '', '/enterprise', '/energia', '/rss-en.xml', '/en.html',
      '/it', '/frontaliere', '/deutschland', '/france',
    ]) {
      expect(f.isLocaleRootPath(p), `${JSON.stringify(p)} must not be treated as a locale root`).toBe(false);
    }
  });
});

/**
 * The emitter half of the same regression. staticPagesPlugin.ts is 5 600 lines
 * and its closeBundle needs a real dist/ + a parsed sitemap + the SPA bundle
 * manifest to run, so the write site is pinned by source shape rather than by
 * executing it — the same approach tests/static-pages-blog-skip.test.ts uses
 * for this file. The behavioural half lives in tests/prune-locale-shard.test.ts,
 * which drives the real prune script and asserts the artifact-level invariant
 * this guard exists to produce.
 */
describe('staticPagesPlugin — no flat .html twin for bare locale roots', () => {
  it('guards the locale-variant flat write with isLocaleRootPath', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '..', 'build-plugins', 'staticPagesPlugin.ts'),
      'utf-8',
    );
    expect(src).toMatch(/from ['"]\.\/shared\/localeEmitFilter['"]/);
    // The flat twin is written ONLY inside an isLocaleRootPath negation. Pinned
    // as one contiguous shape so moving the write out of the guard fails here
    // instead of silently re-emitting dist/<locale>.html.
    expect(src).toMatch(
      /if \(!isLocaleRootPath\(locPath\)\) \{[\s\S]{0,200}?const flatLoc = np\.join\(distDir, locPath \+ '\.html'\);[\s\S]{0,200}?_qw\(flatLoc,/,
    );
    // And there is exactly one flat-twin write site for locale variants.
    expect(src.match(/const flatLoc = np\.join\(distDir, locPath \+ '\.html'\);/g)).toHaveLength(1);
  });
});
