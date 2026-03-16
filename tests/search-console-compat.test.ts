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
    for (const value of compatPaths.paths) {
      expect(resolveSearchConsoleCompatTarget(value), value).not.toBeNull();
    }
  });

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
