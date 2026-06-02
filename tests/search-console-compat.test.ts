import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';

describe('Search Console 404 compatibility resolver', () => {
  it('maps malformed search URLs back to the localized job-board root', () => {
    expect(resolveSearchConsoleCompatTarget('/en/find-jobs-ticino/search-their')).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'search',
      locale: 'en',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/trouver-emploi-tessin/recherche-votre')).toEqual({
      canonicalPath: '/fr/trouver-emploi-tessin/',
      kind: 'search',
      locale: 'fr',
    });
  });

  it('fixes non-Italian company URLs with the wrong azienda prefix', () => {
    expect(resolveSearchConsoleCompatTarget('/de/jobs-im-tessin/azienda-medacta-international-sa')).toEqual({
      canonicalPath: '/de/jobs-im-tessin/unternehmen-medacta-international-sa/',
      kind: 'company',
      locale: 'de',
    });
  });

  it('routes expired job-detail style URLs back to the localized listing', () => {
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-ticino/cuochi/')).toEqual({
      canonicalPath: '/cerca-lavoro-ticino/',
      kind: 'expired-job',
      locale: 'it',
    });
  });

  it('covers the committed live 404 export paths', () => {
    const compatPaths = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', 'data', 'seo-404-compat-paths.json'), 'utf-8')
    );
    expect(Array.isArray(compatPaths.paths)).toBe(true);
    expect(compatPaths.paths.length).toBeGreaterThanOrEqual(603);
    // Guard against the dataset doubling via a merge/concat artifact (seen
    // 2026-06-02: 306k → 605k exact duplicates). Dup bloat silently doubles
    // the resolve loop below and trips the 15s timeout — fail fast & cheap on
    // duplicates instead of timing out.
    const unique = new Set<string>(compatPaths.paths);
    expect(
      unique.size,
      `seo-404-compat-paths.json has ${compatPaths.paths.length - unique.size} duplicate entries`,
    ).toBe(compatPaths.paths.length);
    // Resolve every committed path (full coverage) but collect misses and
    // assert once. A per-path expect() over 300k+ entries cost ~90µs each
    // (~30s+) — that per-assertion overhead, not the resolver, is what blew
    // the timeout. Single assert keeps identical coverage at a fraction of
    // the cost.
    const unresolved: string[] = [];
    for (const value of compatPaths.paths) {
      if (resolveSearchConsoleCompatTarget(value) === null) unresolved.push(value);
    }
    expect(
      unresolved,
      `${unresolved.length} committed 404 paths did not resolve (e.g. ${unresolved.slice(0, 5).join(', ')})`,
    ).toEqual([]);
    // 60s ceiling (vs default 15s): this resolves the full committed dataset
    // (300k+ paths and growing as GSC accumulates 404s) — legitimate O(N)
    // work that needs headroom on loaded CI runners. Coverage/assertions stay
    // strict; only the runtime ceiling is raised.
  }, 60_000);

  it('resolves non-job section 404s to their landing pages', () => {
    expect(resolveSearchConsoleCompatTarget('/vivere-in-ticino/vivere-in-svizzera')).toEqual({
      canonicalPath: '/vivere-in-ticino/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/articoli-frontaliere/some-old-article')).toEqual({
      canonicalPath: '/articoli-frontaliere/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/en/cross-border-articles/some-old-article')).toEqual({
      canonicalPath: '/en/cross-border-articles/',
      kind: 'legacy',
      locale: 'en',
    });
    expect(resolveSearchConsoleCompatTarget('/de/grenzgaenger-artikel/some-old-article')).toEqual({
      canonicalPath: '/de/grenzgaenger-artikel/',
      kind: 'legacy',
      locale: 'de',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/articles-frontalier/some-old-article')).toEqual({
      canonicalPath: '/fr/articles-frontalier/',
      kind: 'legacy',
      locale: 'fr',
    });
    expect(resolveSearchConsoleCompatTarget('/compara-servizi/something')).toEqual({
      canonicalPath: '/compara-servizi/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/fisco-frontaliere/something')).toEqual({
      canonicalPath: '/tasse-e-pensione/',
      kind: 'legacy',
      locale: 'it',
    });
  });

  it('still returns null for truly unknown paths', () => {
    expect(resolveSearchConsoleCompatTarget('/totally-unknown-path')).toBeNull();
    expect(resolveSearchConsoleCompatTarget('/en/unknown-section/something')).toBeNull();
  });
});
