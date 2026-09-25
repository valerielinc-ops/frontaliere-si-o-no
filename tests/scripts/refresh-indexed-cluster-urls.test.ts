import { describe, expect, it } from 'vitest';
import {
  normalizeRelatedSearchClusterPath,
  parseRelatedSearchClusterPathKey,
} from '../../scripts/lib/related-search-cluster-path.mjs';

const { assertIndexedClusterUrlsUnique } = await import(
  '../../scripts/refresh-indexed-cluster-urls.mjs'
);

describe('refresh-indexed-cluster-urls — keyed URL uniqueness', () => {
  it('accepts repeated observations under the same locale::slug key', () => {
    expect(() => assertIndexedClusterUrlsUnique(new Map([
      ['it::ricerca-cookie-bern', [
        '/cerca-lavoro-ticino/ricerca-cookie-bern',
        '/cerca-lavoro-ticino/ricerca-cookie-bern/',
      ]],
    ]))).not.toThrow();
  });

  it('rejects one normalised URL assigned to two keys before serialisation', () => {
    expect(() => assertIndexedClusterUrlsUnique(new Map([
      ['it::ricerca-cookie-bern', ['/cerca-lavoro-ticino/ricerca-cookie-bern']],
      ['en::search-cookie-bern', ['/CERCA-LAVORO-TICINO/RICERCA-COOKIE-BERN/']],
    ]))).toThrow(
      /duplicate URL assigned to multiple locale::slug keys(?=[\s\S]*it::ricerca-cookie-bern)(?=[\s\S]*en::search-cookie-bern)/,
    );
  });
});

describe('related-search-cluster-path — producer/consumer canonicalisation', () => {
  it('strips URL query/hash variants before deriving the stable path key', () => {
    const value = 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-cookie-bern/?utm=source#top';
    expect(normalizeRelatedSearchClusterPath(value)).toBe(
      '/cerca-lavoro-ticino/ricerca-cookie-bern/',
    );
    expect(parseRelatedSearchClusterPathKey(value)).toEqual({
      locale: 'it',
      slug: 'ricerca-cookie-bern',
    });
  });

  it('keeps aggregator canonicals out of the mirror index', () => {
    expect(normalizeRelatedSearchClusterPath(
      '/cerca-lavoro-svizzera/ricerca-infermiere-lugano/',
    )).toBeNull();
  });
});
