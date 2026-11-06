import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRuntimeArticleSections,
  isCantonArticleSection,
  isLiveCantonArticleSectionCached,
  loadLiveCantonArticleSections,
  localizeCantonArticleSections,
} from '@/services/runtimeArticleSections';

describe('runtime canton article section registry', () => {
  beforeEach(() => {
    __resetRuntimeArticleSections();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advertises only generated sections whose edge status is live', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        schema: 1,
        sections: {
          'canton-zh': { status: 'live' },
          'canton-ti': { status: 'draft' },
          'canton-lu': { status: 'live' },
          'canton-not-generated': { status: 'live' },
        },
      }),
    })));

    const sections = await loadLiveCantonArticleSections();

    expect(sections.map((entry) => entry.section)).toEqual(['canton-lu', 'canton-zh']);
    expect(isLiveCantonArticleSectionCached('canton-zh')).toBe(true);
    expect(isLiveCantonArticleSectionCached('canton-ti')).toBe(false);
    expect(isCantonArticleSection('canton-not-generated')).toBe(false);
  });

  it('fails closed when the registry is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

    await expect(loadLiveCantonArticleSections()).resolves.toEqual([]);
    expect(isLiveCantonArticleSectionCached('canton-zh')).toBe(false);
  });

  it('localizes labels without changing the runtime section identity', () => {
    const sections = [{
      section: 'canton-zh' as const,
      canton: 'ZH',
      indexSlug: { it: 'articoli-zurigo', en: 'zurich-articles', de: 'zuerich-artikel', fr: 'articles-zurich' },
      label: 'Articoli Zurigo',
      displayName: 'Zurigo',
    }];

    const localized = localizeCantonArticleSections(sections, 'de');
    expect(localized[0].section).toBe('canton-zh');
    expect(localized[0].label).toBe('Zürich-Artikel');
    expect(localized[0].displayName).toBe('Zürich');
  });
});
