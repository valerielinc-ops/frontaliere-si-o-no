import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ARTICLES_BEHIND,
  MAX_CORPUS_DRIFT_AGE_SECONDS,
  __resetCorpusFreshnessCache,
  checkCorpusFreshness,
  decideCorpusRegistryDrift,
} from '../scripts/rerender-article-hubs.mjs';

const registryFor = (ids: string[]) => Object.fromEntries(
  ids.map((id) => [id, { it: id, en: id, de: id, fr: id }]),
);

const freshTimestamp = () => Math.floor(Date.now() / 1000) - MAX_CORPUS_DRIFT_AGE_SECONDS + 1;
const staleTimestamp = () => Math.floor(Date.now() / 1000) - MAX_CORPUS_DRIFT_AGE_SECONDS - 1;

describe('hub corpus-main registry drift decisions', () => {
  const cases = [
    {
      name: 'converged registries proceed',
      localIds: ['stable-article'],
      publishedIds: ['stable-article'],
      changeAtById: {},
      action: 'proceed',
    },
    {
      name: 'a published id retired on corpus main defers while fresh',
      localIds: ['stable-article'],
      publishedIds: ['stable-article', 'retired-article'],
      changeAtById: { 'retired-article': freshTimestamp() },
      action: 'defer',
    },
    {
      name: 'a corpus-main id not yet published defers while fresh',
      localIds: ['stable-article', 'new-article'],
      publishedIds: ['stable-article'],
      changeAtById: { 'new-article': freshTimestamp() },
      action: 'defer',
    },
    {
      name: 'a retired id older than the publication window fails',
      localIds: ['stable-article'],
      publishedIds: ['stable-article', 'retired-article'],
      changeAtById: { 'retired-article': staleTimestamp() },
      action: 'fail',
    },
    {
      name: 'a not-yet-published id older than the publication window fails',
      localIds: ['stable-article', 'new-article'],
      publishedIds: ['stable-article'],
      changeAtById: { 'new-article': staleTimestamp() },
      action: 'fail',
    },
    {
      name: 'an id without a readable corpus commit date fails closed',
      localIds: ['stable-article', 'new-article'],
      publishedIds: ['stable-article'],
      changeAtById: {},
      action: 'fail',
    },
  ] as const;

  for (const scenario of cases) {
    it(scenario.name, () => {
      const result = decideCorpusRegistryDrift({
        localRegistry: registryFor(scenario.localIds),
        publishedIds: scenario.publishedIds,
        changeAtById: scenario.changeAtById,
      });

      expect(result.action).toBe(scenario.action);
    });
  }

  it('fails when the bounded drift quantity is exceeded', () => {
    const retiredIds = Array.from(
      { length: MAX_ARTICLES_BEHIND + 1 },
      (_, index) => `retired-${index}`,
    );
    const result = decideCorpusRegistryDrift({
      localRegistry: registryFor(['stable-article']),
      publishedIds: ['stable-article', ...retiredIds],
      changeAtById: Object.fromEntries(retiredIds.map((id) => [id, freshTimestamp()])),
    });

    expect(result.action).toBe('fail');
    expect(result.note).toContain(retiredIds[0]);
  });

  it('defers both directions together and names the two decisions', () => {
    const result = decideCorpusRegistryDrift({
      localRegistry: registryFor(['stable-article', 'new-article']),
      publishedIds: ['stable-article', 'retired-article'],
      changeAtById: {
        'retired-article': freshTimestamp(),
        'new-article': freshTimestamp(),
      },
    });

    expect(result.action).toBe('defer');
    expect(result.note).toContain('retired-article');
    expect(result.note).toContain('new-article');
  });
});

describe('hub freshness regression from the stale site copy', () => {
  const publishedIds = ['stable-article', 'caduta-scala-locate-varesino'];
  const staleSiteIds = [
    'stable-article',
    'abort-topical-relevance-pre-saint-didier',
    'abort-saint-nicolas-non-frontaliero',
  ];

  function stubPublishedSurface() {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) {
        return { ok: true, json: async () => ({ counts: { articles: publishedIds.length } }) };
      }
      if (url.endsWith('/slugs.json')) {
        return {
          ok: true,
          json: async () => ({ blog: Object.fromEntries(publishedIds.map((id) => [id, { it: id }])) }),
        };
      }
      if (url === 'https://frontaliereticino.ch/articoli-frontaliere/') {
        const cards = publishedIds
          .map((id) => `<a class="ssg-art-card" href="/articoli-frontaliere/${id}/"></a>`)
          .join('');
        return { ok: true, text: async () => `<main class="ssg-article-grid">${cards}</main>` };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    __resetCorpusFreshnessCache();
    vi.unstubAllGlobals();
  });

  it('rejects the measured stale site copy with one published id and two abort ids', async () => {
    const fetchMock = stubPublishedSurface();
    const verdict = await checkCorpusFreshness(
      'frontaliere',
      staleSiteIds.length,
      { localRegistry: registryFor(staleSiteIds) },
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.deferred).not.toBe(true);
    expect(verdict.note).toContain('caduta-scala-locate-varesino');
    expect(verdict.note).toContain('abort-topical-relevance-pre-saint-didier');
    expect(verdict.note).toContain('abort-saint-nicolas-non-frontaliero');
    expect(verdict.note).toContain('refusing to publish a non-converged client registry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('proceeds when the same published surface is checked against corpus main', async () => {
    const fetchMock = stubPublishedSurface();
    const verdict = await checkCorpusFreshness(
      'frontaliere',
      publishedIds.length,
      { localRegistry: registryFor(publishedIds) },
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain('registry and live hub identities converge');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
