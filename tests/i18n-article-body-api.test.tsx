import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bodyApi = vi.hoisted(() => ({ loadArticleBodyApi: vi.fn() }));
const legacyBodyLoader = vi.hoisted(() => ({ loadBlogBodyChunk: vi.fn() }));
vi.mock('@/services/articleBodyApi', () => bodyApi);
vi.mock('@/services/blogBodyLoader', () => legacyBodyLoader);

import {
  getLoadedArticleBody,
  loadArticleBody,
  mergeArticleMetaOverlay,
  setLocale,
  t,
} from '@/services/i18n';
import { collectArticleBodySegments } from '@/services/articleBodySegments';

function staleTranslations(id: string) {
  const prefix = `blog.article.${id}.`;
  return {
    [`${prefix}title`]: 'Titolo compilato obsoleto',
    [`${prefix}excerpt`]: 'Estratto compilato obsoleto',
    [`${prefix}imageAlt`]: 'Alt compilato obsoleto',
    [`${prefix}body1`]: 'Corpo compilato obsoleto uno.',
    [`${prefix}body2`]: 'Corpo compilato obsoleto due.',
    [`${prefix}body3`]: 'Corpo compilato obsoleto tre.',
    [`${prefix}body4`]: 'Corpo compilato obsoleto quattro.',
    [`${prefix}faq`]: '[{"question":"Vecchia?","answer":"Vecchia risposta."}]',
  };
}

function apiDocument(locale: 'it' | 'en', id: string, translations?: Record<string, string>) {
  return {
    locale,
    id,
    status: 'available',
    payload: {
      schemaVersion: 1,
      section: 'frontaliere',
      locale,
      id,
      revision: 'a'.repeat(64),
      meta: {
        title: locale === 'it' ? 'Titolo API italiano' : 'Verified API title',
        excerpt: locale === 'it' ? 'Estratto API italiano' : 'Verified API excerpt',
        imageAlt: locale === 'it' ? 'Alt API italiano' : 'Verified API alt',
      },
      translations: translations ?? {
        body1: locale === 'it' ? 'Corpo API italiano uno.' : 'Verified API body one.',
        body2: locale === 'it' ? 'Corpo API italiano due.' : 'Verified API body two.',
        body3: locale === 'it' ? 'Corpo API italiano tre.' : 'Verified API body three.',
      },
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  bodyApi.loadArticleBodyApi.mockReset();
  legacyBodyLoader.loadBlogBodyChunk.mockReset();
  setLocale('it');
});

afterEach(() => {
  setLocale('it');
});

describe('i18n published article body precedence', () => {
  it('uses the compiled chunk path only after a valid legacy manifest is reported', async () => {
    const id = 'api-legacy-i18n-fixture';
    bodyApi.loadArticleBodyApi.mockResolvedValue({ status: 'legacy' });
    legacyBodyLoader.loadBlogBodyChunk.mockResolvedValue({
      [`blog.article.${id}.body1`]: 'Testo legacy dal chunk.',
    });

    await expect(loadArticleBody(id, 'frontaliere')).resolves.toEqual({ status: 'legacy' });
    expect(legacyBodyLoader.loadBlogBodyChunk).toHaveBeenCalledWith('it', id, 'frontaliere');
    expect(t(`blog.article.${id}.body1`)).toBe('Testo legacy dal chunk.');
  });

  it('replaces compiled text with the exact available-locale namespace, including sparse body fields', async () => {
    const id = 'api-authoritative-i18n-fixture';
    mergeArticleMetaOverlay('it', staleTranslations(id));
    mergeArticleMetaOverlay('en', staleTranslations(id));
    bodyApi.loadArticleBodyApi.mockResolvedValue({
      status: 'loaded',
      documents: [
        apiDocument('it', id, {
          body1: 'Corpo API italiano uno.',
          body2: 'Corpo API italiano due.',
          body3: 'Corpo API italiano tre.',
          body4: 'Corpo API italiano quattro.',
          faq: '[{"question":"FAQ italiana?","answer":"Risposta italiana."}]',
        }),
        apiDocument('en', id, {
          body1: 'Verified API body one.',
          body2: 'Verified API body two.',
          body3: 'Verified API body three.',
          body5: 'Verified API body five.',
        }),
      ],
    });
    setLocale('en');

    await expect(loadArticleBody(id, 'frontaliere')).resolves.toEqual({ status: 'loaded' });

    expect(t(`blog.article.${id}.title`)).toBe('Verified API title');
    expect(t(`blog.article.${id}.excerpt`)).toBe('Verified API excerpt');
    expect(t(`blog.article.${id}.imageAlt`)).toBe('Verified API alt');
    expect(t(`blog.article.${id}.body1`)).toBe('Verified API body one.');
    expect(t(`blog.article.${id}.faq`)).toBe(`blog.article.${id}.faq`);
    expect(t(`blog.article.${id}.body4`)).toBe(`blog.article.${id}.body4`);
    expect(t(`blog.article.${id}.body5`)).toBe('Verified API body five.');
    expect(getLoadedArticleBody(id)).toEqual({
      body1: 'Verified API body one.',
      body2: 'Verified API body two.',
      body3: 'Verified API body three.',
      body5: 'Verified API body five.',
    });
    expect(collectArticleBodySegments(id, t)).toEqual([
      'Verified API body one.',
      'Verified API body two.',
      'Verified API body three.',
      'Verified API body five.',
    ]);
  });

  it('falls back to Italian only when the requested locale document is explicitly missing', async () => {
    const id = 'api-document-level-fallback';
    bodyApi.loadArticleBodyApi.mockResolvedValue({
      status: 'loaded',
      documents: [apiDocument('it', id), { locale: 'en', id, status: 'missing' }],
    });
    setLocale('en');

    await expect(loadArticleBody(id, 'frontaliere')).resolves.toEqual({ status: 'loaded' });

    expect(t(`blog.article.${id}.title`)).toBe('Titolo API italiano');
    expect(t(`blog.article.${id}.body1`)).toBe('Corpo API italiano uno.');
    expect(getLoadedArticleBody(id)).toEqual({
      body1: 'Corpo API italiano uno.',
      body2: 'Corpo API italiano due.',
      body3: 'Corpo API italiano tre.',
    });
  });

  it('suppresses stale compiled copy after an active API fails to load', async () => {
    const id = 'api-authoritative-i18n-error';
    mergeArticleMetaOverlay('it', staleTranslations(id));
    mergeArticleMetaOverlay('en', staleTranslations(id));
    bodyApi.loadArticleBodyApi.mockResolvedValue({
      status: 'error',
      reason: 'network',
      authoritative: true,
      locales: ['it', 'en'],
    });
    setLocale('en');

    await expect(loadArticleBody(id, 'frontaliere')).resolves.toEqual({
      status: 'error', reason: 'network', authoritative: true,
    });

    expect(t(`blog.article.${id}.title`)).toBe(`blog.article.${id}.title`);
    expect(t(`blog.article.${id}.body1`)).toBe(`blog.article.${id}.body1`);
    expect(t(`blog.article.${id}.faq`)).toBe(`blog.article.${id}.faq`);
  });

  it.each(['error', 'loaded'] as const)(
    'does not let an older English request %s overwrite a newer Italian document',
    async (olderResult) => {
      const id = `api-locale-race-${olderResult}`;
      let resolveOlder!: (value: unknown) => void;
      bodyApi.loadArticleBodyApi.mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }));
      setLocale('en');
      const olderEnglishRequest = loadArticleBody(id, 'frontaliere');
      await vi.waitFor(() => expect(bodyApi.loadArticleBodyApi).toHaveBeenCalledTimes(1));

      setLocale('it');
      bodyApi.loadArticleBodyApi.mockResolvedValueOnce({
        status: 'loaded',
        documents: [apiDocument('it', id, {
          body1: 'Nuovo corpo italiano uno.',
          body2: 'Nuovo corpo italiano due.',
          body3: 'Nuovo corpo italiano tre.',
        })],
      });
      await loadArticleBody(id, 'frontaliere');
      expect(t(`blog.article.${id}.title`)).toBe('Titolo API italiano');
      expect(t(`blog.article.${id}.body1`)).toBe('Nuovo corpo italiano uno.');

      if (olderResult === 'error') {
        resolveOlder({
          status: 'error', reason: 'network', authoritative: true, locales: ['it', 'en'],
        });
      } else {
        resolveOlder({
          status: 'loaded',
          documents: [
            apiDocument('it', id, {
              body1: 'Vecchio corpo italiano uno.',
              body2: 'Vecchio corpo italiano due.',
              body3: 'Vecchio corpo italiano tre.',
            }),
            apiDocument('en', id),
          ],
        });
      }
      await olderEnglishRequest;

      expect(t(`blog.article.${id}.title`)).toBe('Titolo API italiano');
      expect(t(`blog.article.${id}.body1`)).toBe('Nuovo corpo italiano uno.');
    },
  );

  it('keeps a first-visit manifest outage as an error and does not enter the compiled fallback path', async () => {
    const id = 'api-first-visit-outage';
    bodyApi.loadArticleBodyApi.mockResolvedValue({
      status: 'error', reason: 'network', authoritative: false, locales: ['it'],
    });

    await expect(loadArticleBody(id, 'frontaliere')).resolves.toEqual({
      status: 'error', reason: 'network', authoritative: false,
    });
    expect(legacyBodyLoader.loadBlogBodyChunk).not.toHaveBeenCalled();
    expect(t(`blog.article.${id}.body1`)).toBe(`blog.article.${id}.body1`);
  });
});
