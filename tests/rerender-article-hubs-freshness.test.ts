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

describe('hub freshness quantity limits come before any history lookup', () => {
  // Review of the PR that moved the hubs onto corpus main: a commit date is a
  // history lookup in the blobless corpus clone, and an oversized handoff ran
  // one per drift id before being refused on its size alone.
  function stubPublished(ids: string[]) {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) {
        return { ok: true, json: async () => ({ counts: { articles: ids.length } }) };
      }
      if (url.endsWith('/slugs.json')) {
        return { ok: true, json: async () => ({ blog: Object.fromEntries(ids.map((id) => [id, { it: id }])) }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  function countingLookup() {
    const lookedUp: string[] = [];
    const lookup = (_checkoutDir: string, _section: string, id: string) => {
      lookedUp.push(id);
      return freshTimestamp();
    };
    return { lookedUp, lookup };
  }

  const overLimit = MAX_ARTICLES_BEHIND + 1;

  afterEach(() => {
    __resetCorpusFreshnessCache();
    vi.unstubAllGlobals();
  });

  it('refuses a published corpus over the limit ahead, drift ids included, without a lookup', async () => {
    const publishedOnly = Array.from({ length: overLimit }, (_, index) => `published-only-${index}`);
    stubPublished(['stable-article', ...publishedOnly]);
    const { lookedUp, lookup } = countingLookup();

    const verdict = await checkCorpusFreshness('frontaliere', 1, {
      localRegistry: registryFor(['stable-article']),
      corpusCheckoutDir: 'corpus-checkout-never-read',
      articleChangeTimestamp: lookup,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.deferred).not.toBe(true);
    expect(verdict.note).toContain(`${overLimit} behind, tolerance ${MAX_ARTICLES_BEHIND}`);
    expect(verdict.note).toContain(publishedOnly[0]);
    expect(lookedUp).toEqual([]);
  });

  it('refuses a drift over the limit at an equal article count without a lookup', async () => {
    const half = overLimit / 2;
    const publishedOnly = Array.from({ length: half }, (_, index) => `published-only-${index}`);
    const localOnly = Array.from({ length: half }, (_, index) => `local-only-${index}`);
    stubPublished(['stable-article', ...publishedOnly]);
    const { lookedUp, lookup } = countingLookup();

    const verdict = await checkCorpusFreshness('frontaliere', 1 + half, {
      localRegistry: registryFor(['stable-article', ...localOnly]),
      corpusCheckoutDir: 'corpus-checkout-never-read',
      articleChangeTimestamp: lookup,
    });

    expect(Number.isInteger(half)).toBe(true);
    expect(verdict.ok).toBe(false);
    expect(verdict.deferred).not.toBe(true);
    expect(verdict.note).toContain(`drift contains ${overLimit} id(s), limit ${MAX_ARTICLES_BEHIND}`);
    // No date was looked up, so none may be reported as missing.
    expect(verdict.note).not.toContain('no valid corpus commit timestamp');
    expect(lookedUp).toEqual([]);
  });

  it('looks each date up once when the drift is within the limit, then defers', async () => {
    stubPublished(['stable-article', 'published-only']);
    const { lookedUp, lookup } = countingLookup();

    const verdict = await checkCorpusFreshness('frontaliere', 2, {
      localRegistry: registryFor(['stable-article', 'local-only']),
      corpusCheckoutDir: 'corpus-checkout-never-read',
      articleChangeTimestamp: lookup,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.deferred).toBe(true);
    expect([...lookedUp].sort()).toEqual(['local-only', 'published-only']);
  });
});
