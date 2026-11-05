import { describe, expect, it } from 'vitest';

import {
  SOCIAL_SOURCE_FORMATS_BY_KIND,
  buildSocialJobSourceCatalog,
  prioritizeSocialSourceCandidates,
  socialSourceIdForArticle,
  socialSourceCatalogId,
  validateSocialSourceCatalog,
} from '../scripts/lib/social-source-catalog.mjs';

describe('social source recommendations', () => {
  it('excludes event-triggered Reddit articles from source selection slots', () => {
    expect(SOCIAL_SOURCE_FORMATS_BY_KIND.article).not.toContain('reddit.article');
  });

  it('builds a small fresh job catalog without URLs, employers, or numeric listing claims', () => {
    const catalog = buildSocialJobSourceCatalog([
      {
        url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/contabile-123456/',
        slug: 'contabile-123456',
        title: 'Contabile amministrativo 2026',
        category: 'fiscale',
        crawledAt: '2026-11-03T10:00:00.000Z',
      },
      {
        url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/old-role-123456/',
        title: 'Ruolo non più fresco',
        crawledAt: '2026-10-20T10:00:00.000Z',
      },
      {
        url: 'http://frontaliereticino.ch/cerca-lavoro-ticino/insecure-123456/',
        title: 'URL non HTTPS',
        crawledAt: '2026-11-03T10:00:00.000Z',
      },
    ], { asOf: '2026-11-04T12:00:00.000Z' });

    expect(catalog.sources).toHaveLength(1);
    expect(catalog.sources[0]).toMatchObject({
      contentKind: 'job',
      topic: 'fiscale',
      freshnessDays: 1,
      selectionHint: 'Contabile amministrativo',
    });
    expect(JSON.stringify(catalog)).not.toContain('frontaliereticino.ch');
    expect(validateSocialSourceCatalog(catalog, { now: '2026-11-04T12:00:00.000Z' }).catalogId).toBe(catalog.catalogId);
  });

  it('prioritizes an exact recommendation only within the current candidate list', () => {
    const recommended = socialSourceIdForArticle('articolo-consigliato');
    const candidates = [
      { slug: 'articolo-primo-in-classifica' },
      { slug: 'articolo-consigliato' },
      { slug: 'articolo-di-riserva' },
    ];

    const ordered = prioritizeSocialSourceCandidates(candidates, {
      pack: { sourceAssignments: [{ channel: 'instagram', format: 'article', sourceId: recommended }] },
      channel: 'instagram',
      format: 'article',
      sourceIdForCandidate: (candidate) => socialSourceIdForArticle(candidate.slug),
    });

    expect(ordered.map((candidate) => candidate.slug)).toEqual([
      'articolo-consigliato', 'articolo-primo-in-classifica', 'articolo-di-riserva',
    ]);
  });

  it('keeps publisher order when recommendations are stale or for another format', () => {
    const candidates = [{ slug: 'articolo-primo' }, { slug: 'articolo-secondo' }];
    const sourceId = socialSourceIdForArticle('articolo-secondo');
    const sourceIdForCandidate = (candidate: { slug: string }) => socialSourceIdForArticle(candidate.slug);

    expect(prioritizeSocialSourceCandidates(candidates, {
      pack: { sourceAssignments: [{ channel: 'instagram', format: 'article', sourceId: 'article-ffffffffffffffffffff' }] },
      channel: 'instagram', format: 'article', sourceIdForCandidate,
    })).toEqual(candidates);
    expect(prioritizeSocialSourceCandidates(candidates, {
      pack: { sourceAssignments: [{ channel: 'facebook', format: 'article', sourceId }] },
      channel: 'instagram', format: 'article', sourceIdForCandidate,
    })).toEqual(candidates);
  });

  it('uses per-kind source freshness while keeping catalog snapshot freshness separate', () => {
    const sources = [
      {
        sourceId: socialSourceIdForArticle('articolo-recente'),
        contentKind: 'article',
        topic: 'lavoro',
        freshnessDays: 30,
        eligibleFormats: ['instagram.article'],
      },
      {
        sourceId: 'job-aaaaaaaaaaaaaaaaaaaa',
        contentKind: 'job',
        topic: 'lavoro',
        freshnessDays: 7,
        eligibleFormats: ['linkedin.job'],
      },
      {
        sourceId: 'event-bbbbbbbbbbbbbbbbbbbb',
        contentKind: 'event',
        topic: 'generic',
        freshnessDays: 7,
        eligibleFormats: ['facebook.event'],
      },
    ];
    const catalog = {
      schemaVersion: 1,
      snapshotDate: '2026-11-04',
      sources,
      catalogId: socialSourceCatalogId(sources),
    };

    expect(validateSocialSourceCatalog(catalog, { now: '2026-11-04T12:00:00.000Z' }).sources).toHaveLength(3);
    const staleArticle = { ...sources[0], freshnessDays: 31 };
    expect(() => validateSocialSourceCatalog({
      ...catalog,
      sources: [staleArticle],
      catalogId: socialSourceCatalogId([staleArticle]),
    }, { now: '2026-11-04T12:00:00.000Z' })).toThrow(/invalid or duplicate source/u);
    expect(() => validateSocialSourceCatalog({
      ...catalog,
      snapshotDate: '2026-11-01',
    }, { now: '2026-11-04T12:00:00.000Z' })).toThrow(/stale/u);
  });
});
