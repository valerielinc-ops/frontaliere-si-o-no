// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadArticleBodyApi,
  resetArticleBodyApiForTests,
  type ArticleBodyApiLocale,
} from '@/services/articleBodyApi';

const ARTICLE_ID = 'educatore-ticino-requisiti-api-test';
const META = { title: 'Titolo verificato', excerpt: 'Estratto verificato', imageAlt: 'Alt verificato' };
const TRANSLATIONS = { body1: 'Uno.', body2: 'Due.', body3: 'Tre.', faq: '[{"question":"D?","answer":"R."}]' };
const BASE = 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';

async function revision(locale: ArticleBodyApiLocale, translations: Record<string, string> = TRANSLATIONS): Promise<string> {
  const canonicalTranslations: Record<string, string> = {};
  for (let index = 1; index <= 20; index += 1) {
    const key = `body${index}`;
    if (Object.prototype.hasOwnProperty.call(translations, key)) canonicalTranslations[key] = translations[key];
  }
  if (Object.prototype.hasOwnProperty.call(translations, 'faq')) canonicalTranslations.faq = translations.faq;
  const canonical = {
    schemaVersion: 1,
    section: 'frontaliere',
    locale,
    id: ARTICLE_ID,
    meta: META,
    translations: canonicalTranslations,
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function manifest(availableCount = 1, missingCount = 0) {
  const locales = Object.fromEntries(['it', 'en', 'de', 'fr'].map((code) => [code, {
    index: `bodies/frontaliere/${code}/index.json`,
    expected: availableCount + missingCount,
    available: availableCount,
    missing: missingCount,
  }]));
  return {
    commit: 'abc1234',
    capabilities: {
      articleBodies: {
        schemaVersion: 1,
        revisionAlgorithm: 'sha256-json-v1',
        revisionCanonicalFields: [
          'schemaVersion', 'section', 'locale', 'id',
          'meta.title', 'meta.excerpt', 'meta.imageAlt',
          'translations.body1..body20 (present keys, numeric order)',
          'translations.faq (if present, last)',
        ],
        revisionTextEncoding: 'UTF-8',
        revisionUnicodeNormalization: 'none',
        indexPattern: 'bodies/{section}/{locale}/index.json',
        payloadPattern: 'bodies/{section}/{locale}/{id}.json',
        sections: {
          frontaliere: { status: 'public', locales },
        },
      },
    },
  };
}

function index(locale: ArticleBodyApiLocale, hash: string) {
  return {
    schemaVersion: 1,
    section: 'frontaliere',
    locale,
    status: 'public',
    expectedCount: 1,
    availableCount: 1,
    missingCount: 0,
    entries: {
      [ARTICLE_ID]: {
        status: 'available',
        path: `bodies/frontaliere/${locale}/${ARTICLE_ID}.json`,
        expectedHash: hash,
      },
    },
  };
}

function payload(locale: ArticleBodyApiLocale, hash: string, translations = TRANSLATIONS) {
  return {
    schemaVersion: 1,
    section: 'frontaliere',
    locale,
    id: ARTICLE_ID,
    revision: hash,
    meta: META,
    translations,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch(handler: (url: URL, init?: RequestInit) => Promise<Response> | Response) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(input)), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  resetArticleBodyApiForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('published article body API', () => {
  it('checks the identity and canonical SHA-256 revision before returning metadata, body and FAQ', async () => {
    const hash = await revision('it');
    const calls: string[] = [];
    const fetchMock = installFetch((url) => {
      calls.push(url.toString());
      if (url.pathname.endsWith('/manifest.json')) return response(manifest());
      if (url.pathname.endsWith('/index.json')) return response(index('it', hash));
      expect(url.searchParams.get('revision')).toBe(hash);
      return response(payload('it', hash));
    });

    const result = await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it']);

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') throw new Error('expected verified document');
    expect(result.documents[0]).toMatchObject({
      status: 'available',
      id: ARTICLE_ID,
      payload: { meta: META, translations: TRANSLATIONS, revision: hash },
    });
    expect(calls.some((url) => url.includes(`?revision=${hash}`))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects the reserved index identity in requests and published indexes', async () => {
    const invalidIdFetch = installFetch(() => { throw new Error('reserved id must not reach fetch'); });
    const invalidIdResult = await loadArticleBodyApi('frontaliere', 'index', ['it']);
    expect(invalidIdResult).toMatchObject({ status: 'error', reason: 'invalid' });
    expect(invalidIdFetch).not.toHaveBeenCalled();

    resetArticleBodyApiForTests();
    const hash = await revision('it');
    const calls: string[] = [];
    installFetch((url) => {
      calls.push(url.toString());
      if (url.pathname.endsWith('/manifest.json')) return response(manifest(1, 1));
      if (url.pathname.endsWith('/index.json')) {
        const valid = index('it', hash);
        return response({
          ...valid,
          expectedCount: 2,
          missingCount: 1,
          entries: { ...valid.entries, index: { status: 'missing' } },
        });
      }
      throw new Error('invalid index entry must not reach payload fetch');
    });
    const indexResult = await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it']);
    expect(indexResult).toMatchObject({ status: 'error', reason: 'invalid', authoritative: true });
    expect(calls.filter((url) => new URL(url).pathname.endsWith('/index.json'))).toHaveLength(2);
    expect(calls.some((url) => new URL(url).searchParams.has('revision'))).toBe(false);
  });

  it('does not permanently cache a legitimate missing row', async () => {
    const hash = await revision('it');
    let missing = true;
    installFetch((url) => {
      if (url.pathname.endsWith('/manifest.json')) return response(manifest(missing ? 0 : 1, missing ? 1 : 0));
      if (url.pathname.endsWith('/index.json')) {
        return response(missing ? {
          ...index('it', hash),
          availableCount: 0,
          missingCount: 1,
          entries: { [ARTICLE_ID]: { status: 'missing' } },
        } : index('it', hash));
      }
      return response(payload('it', hash));
    });

    expect((await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it'])).status).toBe('missing');
    missing = false;
    expect((await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it'])).status).toBe('loaded');
  });

  it('refreshes the index once when the expected revision changes during publication', async () => {
    const oldHash = await revision('it', TRANSLATIONS);
    const changedTranslations = { ...TRANSLATIONS, body1: 'Testo nuovo.' };
    const newHash = await revision('it', changedTranslations);
    let manifests = 0;
    let indexes = 0;
    const payloadCacheModes: RequestCache[] = [];
    installFetch((url, init) => {
      if (url.pathname.endsWith('/manifest.json')) {
        manifests += 1;
        return response(manifest());
      }
      if (url.pathname.endsWith('/index.json')) {
        indexes += 1;
        return response(index('it', indexes === 1 ? oldHash : newHash));
      }
      payloadCacheModes.push(init?.cache as RequestCache);
      return response(url.searchParams.get('revision') === oldHash
        ? payload('it', newHash, changedTranslations)
        : payload('it', newHash, changedTranslations));
    });

    const result = await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it']);

    expect(result.status).toBe('loaded');
    expect(manifests).toBe(2);
    expect(indexes).toBe(2);
    expect(payloadCacheModes).toEqual(['default', 'reload']);
    if (result.status === 'loaded') {
      expect(result.documents[0]).toMatchObject({ status: 'available', payload: { revision: newHash } });
    }
  });

  it('accepts sparse optional body keys and preserves them after revision validation', async () => {
    const translations = { body1: 'Uno.', body2: 'Due.', body3: 'Tre.', body5: 'Cinque.' };
    const hash = await revision('it', translations);
    installFetch((url) => {
      if (url.pathname.endsWith('/manifest.json')) return response(manifest());
      if (url.pathname.endsWith('/index.json')) return response(index('it', hash));
      return response(payload('it', hash, translations));
    });

    const result = await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it']);

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') throw new Error('expected verified document');
    expect(result.documents[0]).toMatchObject({ status: 'available', payload: { translations } });
  });

  it('bounds network retries and does not cache the failure', async () => {
    const hash = await revision('it');
    let manifestFailures = 2;
    const fetchMock = installFetch((url) => {
      if (url.pathname.endsWith('/manifest.json') && manifestFailures > 0) {
        manifestFailures -= 1;
        return response({}, 503);
      }
      if (url.pathname.endsWith('/manifest.json')) return response(manifest());
      if (url.pathname.endsWith('/index.json')) return response(index('it', hash));
      return response(payload('it', hash));
    });

    const result = await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it']);

    expect(result).toMatchObject({ status: 'error', reason: 'network', authoritative: false, locales: ['it'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it'])).status).toBe('loaded');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('uses the compiled compatibility path only when a valid manifest lacks the capability', async () => {
    installFetch((url) => response(url.pathname.endsWith('/manifest.json') ? { commit: 'old' } : {}));
    expect(await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it'])).toEqual({ status: 'legacy' });
  });

  it('rejects payload identity or metadata changes even if the endpoint returns JSON', async () => {
    const hash = await revision('it');
    installFetch((url) => {
      if (url.pathname.endsWith('/manifest.json')) return response(manifest());
      if (url.pathname.endsWith('/index.json')) return response(index('it', hash));
      return response({ ...payload('it', hash), id: 'another-article' });
    });
    expect(await loadArticleBodyApi('frontaliere', ARTICLE_ID, ['it'])).toMatchObject({
      status: 'error', reason: 'invalid', authoritative: true, locales: ['it'],
    });
  });
});
