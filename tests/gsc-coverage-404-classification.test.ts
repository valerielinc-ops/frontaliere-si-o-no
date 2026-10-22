import { describe, expect, it } from 'vitest';

import { classifyUnresolvedCoveragePath } from '../scripts/ingest-gsc-coverage-404s';

describe('GSC Coverage non-200 classification', () => {
  it('accepts an explicit source-backed redirect', () => {
    expect(classifyUnresolvedCoveragePath('/fisco-frontaliere/dichiarazione-redditi')).toMatchObject({
      kind: 'redirect',
      path: '/fisco-frontaliere/dichiarazione-redditi',
      canonicalPath: '/tasse-e-pensione/',
    });
  });

  it('accepts a verified self-mapped compatibility path', () => {
    expect(classifyUnresolvedCoveragePath('/contattaci')).toMatchObject({
      kind: 'compat',
      path: '/contattaci',
      canonicalPath: '/contattaci/',
    });
  });

  it('keeps a route-shaped but editorially ambiguous path unknown', () => {
    expect(classifyUnresolvedCoveragePath('/articoli-frontaliere/unknown-editorial-slug')).toEqual({
      kind: 'unknown',
      path: '/articoli-frontaliere/unknown-editorial-slug',
      reason: 'ambiguous-routing',
    });
  });

  it('keeps a path with no demonstrated destination unknown', () => {
    expect(classifyUnresolvedCoveragePath('/not-a-published-route')).toEqual({
      kind: 'unknown',
      path: '/not-a-published-route',
      reason: 'no-demonstrated-destination',
    });
  });

  it('rejects URLs outside the verified GSC property before resolving them', () => {
    expect(
      classifyUnresolvedCoveragePath('https://example.test/fisco-frontaliere/dichiarazione-redditi'),
    ).toEqual({
      kind: 'unknown',
      path: null,
      reason: 'outside-gsc-property',
    });
  });

  it('accepts a job redirect only when a canonical identity is supplied', () => {
    const slugIndex = {
      get(slug: string) {
        return slug === 'known-job'
          ? { it: '/cerca-lavoro-berna/known-job' }
          : undefined;
      },
    };

    expect(
      classifyUnresolvedCoveragePath('/cerca-lavoro-ticino/known-job', slugIndex),
    ).toMatchObject({
      kind: 'redirect',
      path: '/cerca-lavoro-ticino/known-job',
      canonicalPath: '/cerca-lavoro-berna/known-job/',
    });
  });
});
