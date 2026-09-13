import { describe, expect, it } from 'vitest';

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

  it('rejects one normalized URL assigned to two keys before serialization', () => {
    expect(() => assertIndexedClusterUrlsUnique(new Map([
      ['it::ricerca-cookie-bern', ['/cerca-lavoro-ticino/ricerca-cookie-bern']],
      ['en::search-cookie-bern', ['/CERCA-LAVORO-TICINO/RICERCA-COOKIE-BERN/']],
    ]))).toThrow(
      /duplicate URL assigned to multiple locale::slug keys[\s\S]*(?=.*it::ricerca-cookie-bern)(?=.*en::search-cookie-bern)/,
    );
  });
});
