/**
 * SPA routing of the canton article sections (piano «sezioni articoli per
 * cantone», S2): `services/cantonArticlePaths.ts` + the `parsePath` branch.
 *
 * The pages are corpus HTML on R2 with no React view, so the router must keep
 * them on screen (`staticOverlay`) — but ONLY on a document the corpus served.
 * A canton URL that is not live yet answers 404 and its SPA fallback restores
 * the path on the homepage document: there the result must stay what it was
 * before the canton sections existed (notFoundPath).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePath } from '../services/router';
import { documentOwnedByCorpus, isCantonArticlePath } from '../services/cantonArticlePaths';
import { CANTON_ARTICLE_SECTION_CORE } from '../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs';
import {
  CORPUS_ROUTE_OWNER_META_TAG,
  ROUTE_OWNER_CORPUS,
  ROUTE_OWNER_META_NAME,
} from '../packages/articles/engine/shared/corpusRouteOwner.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

const prefixes = Object.values(CANTON_ARTICLE_SECTION_CORE).flatMap((e) =>
  LOCALES.map((loc) => (loc === 'it' ? `/${e.indexSlug.it}` : `/${loc}/${e.indexSlug[loc]}`)),
);

function fakeDocument(content: string | null) {
  return {
    querySelector: (selector: string) =>
      selector === `meta[name="${ROUTE_OWNER_META_NAME}"]` && content !== null
        ? { getAttribute: (name: string) => (name === 'content' ? content : null) }
        : null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isCantonArticlePath', () => {
  it('covers the 96 prefixes of the generated core: root, flat .html, deep paths', () => {
    expect(prefixes).toHaveLength(96);
    for (const prefix of prefixes) {
      expect(isCantonArticlePath(`${prefix}/`), prefix).toBe(true);
      expect(isCantonArticlePath(prefix), prefix).toBe(true);
      expect(isCantonArticlePath(`${prefix}.html`), prefix).toBe(true);
      expect(isCantonArticlePath(`${prefix}/qualche-articolo/`), prefix).toBe(true);
    }
  });

  it('is case-insensitive like parsePath and prefix-exact', () => {
    expect(isCantonArticlePath('/Articoli-Ticino/')).toBe(true);
    expect(isCantonArticlePath('/articoli-ticino-altro/')).toBe(false);
    expect(isCantonArticlePath('/articoli-frontaliere/')).toBe(false);
    expect(isCantonArticlePath('/articoli-svizzera/x/')).toBe(false);
    expect(isCantonArticlePath('/cerca-lavoro-ticino/')).toBe(false);
    expect(isCantonArticlePath('/en/swiss-articles/')).toBe(false);
  });
});

describe('documentOwnedByCorpus', () => {
  it('reads the route-owner meta the corpus renderer emits', () => {
    expect(CORPUS_ROUTE_OWNER_META_TAG).toBe(`<meta name="${ROUTE_OWNER_META_NAME}" content="${ROUTE_OWNER_CORPUS}">`);
    expect(documentOwnedByCorpus(fakeDocument('corpus'))).toBe(true);
    expect(documentOwnedByCorpus(fakeDocument('site'))).toBe(false);
    expect(documentOwnedByCorpus(fakeDocument(null))).toBe(false);
    expect(documentOwnedByCorpus(undefined)).toBe(false);
  });
});

describe('parsePath on canton article sections', () => {
  const samples = ['/articoli-ticino/', '/en/ticino-articles/fuel/', '/de/tessin-artikel/ein-artikel/', '/fr/articles-bale/'];

  it('WITHOUT the corpus meta (not live / 404 fallback on the homepage) → notFoundPath, as before', () => {
    vi.stubGlobal('document', fakeDocument(null));
    for (const p of samples) {
      const r = parsePath(p);
      expect(r.notFoundPath, p).toBe(p);
      expect(r.route.staticOverlay, p).toBeFalsy();
    }
  });

  it('on a corpus-served document → blog tab in staticOverlay, locale from the path', () => {
    vi.stubGlobal('document', fakeDocument('corpus'));
    const expected = { '/articoli-ticino/': 'it', '/en/ticino-articles/fuel/': 'en', '/de/tessin-artikel/ein-artikel/': 'de', '/fr/articles-bale/': 'fr' } as const;
    for (const p of samples) {
      const r = parsePath(p);
      expect(r.route, p).toEqual({ activeTab: 'blog', staticOverlay: true });
      expect(r.notFoundPath, p).toBeUndefined();
      expect(r.locale, p).toBe(expected[p as keyof typeof expected]);
    }
  });

  it('never changes the historical article sections or the job sections, meta or not', () => {
    for (const content of [null, 'corpus']) {
      vi.stubGlobal('document', fakeDocument(content));
      expect(parsePath('/articoli-frontaliere/').route.activeTab).toBe('blog');
      expect(parsePath('/articoli-frontaliere/').route.staticOverlay).toBeFalsy();
      expect(parsePath('/en/swiss-articles/').route.activeTab).toBe('blog');
      expect(parsePath('/cerca-lavoro-ticino/').route.activeTab).toBe('job-board');
    }
  });
});
