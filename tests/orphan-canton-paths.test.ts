import { describe, expect, it } from 'vitest';

import {
  buildOrphanLocalePaths,
  buildDefaultTiPaths,
  inferCantonFromPath,
  inferCantonFromSlug,
  buildCityCantonIndex,
} from '../scripts/lib/orphan-canton-paths.mjs';

describe('orphan-canton-paths — inferCantonFromPath', () => {
  it('reverse-resolves the EN graubunden segment', () => {
    expect(inferCantonFromPath('/en/find-jobs-graubunden/foo/')).toBe('GR');
  });

  it('reverse-resolves the DE tessin segment', () => {
    expect(inferCantonFromPath('/de/jobs-im-tessin/foo/')).toBe('TI');
  });

  it('reverse-resolves the IT grigioni segment (no locale prefix)', () => {
    expect(inferCantonFromPath('/cerca-lavoro-grigioni/foo/')).toBe('GR');
  });

  it('returns null when the path does not match the job-board shape', () => {
    expect(inferCantonFromPath('/blog/some-article/')).toBeNull();
    expect(inferCantonFromPath('')).toBeNull();
    expect(inferCantonFromPath(undefined as unknown as string)).toBeNull();
  });
});

describe('orphan-canton-paths — inferCantonFromSlug', () => {
  const cityIndex = buildCityCantonIndex();

  it('resolves Chur → GR via the trailing city token', () => {
    expect(inferCantonFromSlug('product-manager-80-100-ferrovia-retica-rhb-chur', cityIndex)).toBe('GR');
  });

  it('resolves Lugano → TI', () => {
    expect(inferCantonFromSlug('software-engineer-acme-lugano', cityIndex)).toBe('TI');
  });

  it('strips the 6-hex disambiguator tail before looking up the city', () => {
    expect(
      inferCantonFromSlug('product-manager-ferrovia-retica-rhb-chur-abc123', cityIndex),
    ).toBe('GR');
  });

  it('returns null when the trailing token is not a known city', () => {
    expect(inferCantonFromSlug('blah-blah-noplaceknown', cityIndex)).toBeNull();
  });
});

describe('orphan-canton-paths — buildOrphanLocalePaths', () => {
  // Regression: the RhB Chur 404 surfaced by the user lives here. The orphan
  // slug is `product-manager-80-100-ferrovia-retica-rhb-chur`; pre-fix all 4
  // localised fallbacks pointed at Ticino, while Google indexed the GR EN
  // URL. The new builder MUST emit the GR EN URL so the soft-landing covers
  // the path Google actually crawls.
  it('builds canton-aware paths for a Chur orphan (the user-reported 404)', () => {
    const paths = buildOrphanLocalePaths({
      slug: 'product-manager-80-100-ferrovia-retica-rhb-chur',
      path: '/en/find-jobs-graubunden/product-manager-80-100-ferrovia-retica-rhb-chur/',
    });
    expect(paths).toEqual({
      it: '/cerca-lavoro-grigioni/product-manager-80-100-ferrovia-retica-rhb-chur',
      en: '/en/find-jobs-graubunden/product-manager-80-100-ferrovia-retica-rhb-chur',
      de: '/de/jobs-im-graubunden/product-manager-80-100-ferrovia-retica-rhb-chur',
      fr: '/fr/trouver-emploi-grisons/product-manager-80-100-ferrovia-retica-rhb-chur',
    });
  });

  it('prefers the GSC-reported path over the slug heuristic when both exist', () => {
    // Slug suffix "chur" → GR; path says "/de/jobs-im-tessin/..." → TI.
    // The GSC-reported path wins because it's what Google actually crawled.
    const paths = buildOrphanLocalePaths({
      slug: 'fake-chur',
      path: '/de/jobs-im-tessin/fake-chur/',
    });
    expect(paths.en).toBe('/en/find-jobs-ticino/fake-chur');
  });

  it('falls back to Ticino when neither path nor slug resolves a canton', () => {
    const paths = buildOrphanLocalePaths({ slug: 'random-noplace-xyz' });
    expect(paths).toEqual(buildDefaultTiPaths('random-noplace-xyz'));
  });

  it('honours pathHints to recover canton from an already-tracked entry', () => {
    const paths = buildOrphanLocalePaths(
      { slug: 'unknown-city-job' },
      {
        pathHints: {
          it: '/cerca-lavoro-grigioni/unknown-city-job',
          en: '/en/find-jobs-graubunden/unknown-city-job',
        },
      },
    );
    expect(paths.en).toBe('/en/find-jobs-graubunden/unknown-city-job');
  });

  it('returns null when no slug is supplied', () => {
    // Defensive: callers in sync-gsc-orphans.mjs guard on this.
    expect(buildOrphanLocalePaths({ slug: '' })).toBeNull();
  });
});
