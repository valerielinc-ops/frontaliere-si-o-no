/**
 * SPA routing of the canton article sections (piano «sezioni articoli per
 * cantone», S2): `services/cantonArticlePaths.ts` + the `parsePath` branch.
 *
 * The corpus still owns the initial HTML, but live landing/archive/article
 * paths are now handed to the same React blog view as the historical hubs.
 * Topic hubs hydrate through the same React shell after the corpus payload is validated.
 * A canton URL that is not live yet answers 404 and its SPA fallback restores
 * the path on the homepage document: there the result must stay what it was
 * before the canton sections existed (notFoundPath).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPath, parsePath } from '../services/router';
import { documentOwnedByCorpus, isCantonArticlePath, parseCantonArticlePath } from '../services/cantonArticlePaths';
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
  const samples = ['/articoli-ticino/', '/en/ticino-articles/mappa-affitti-ticino/', '/de/tessin-artikel/ein-artikel/', '/fr/articles-bale/'];

  it('WITHOUT the corpus meta (not live / 404 fallback on the homepage) → notFoundPath, as before', () => {
    vi.stubGlobal('document', fakeDocument(null));
    for (const p of samples) {
      const r = parsePath(p);
      expect(r.notFoundPath, p).toBe(p);
      expect(r.route.staticOverlay, p).toBeFalsy();
    }
  });

  it('on a corpus-served document → real blog route, locale and article slug from the path', () => {
    vi.stubGlobal('document', fakeDocument('corpus'));
    const expected = { '/articoli-ticino/': 'it', '/en/ticino-articles/mappa-affitti-ticino/': 'en', '/de/tessin-artikel/ein-artikel/': 'de', '/fr/articles-bale/': 'fr' } as const;
    for (const p of samples) {
      const r = parsePath(p);
      expect(r.route.activeTab, p).toBe('blog');
      expect(r.route.blogSection, p).toMatch(/^canton-/);
      expect(r.route.staticOverlay, p).toBeFalsy();
      expect(r.notFoundPath, p).toBeUndefined();
      expect(r.locale, p).toBe(expected[p as keyof typeof expected]);
      if (p.includes('/mappa-affitti-ticino/') || p.includes('/ein-artikel/')) {
        expect(r.route.cantonSlug, p).toBe(p.includes('/mappa-affitti-ticino/') ? 'mappa-affitti-ticino' : 'ein-artikel');
      }
    }
  });

  it('recognizes the localized archive root and paginated archive and resolves topic hubs', () => {
    vi.stubGlobal('document', fakeDocument('corpus'));
    expect(parsePath('/articoli-zurigo/tutti/').route).toMatchObject({
      activeTab: 'blog',
      blogSection: 'canton-zh',
      blogArchive: true,
    });
    expect(parsePath('/en/zurich-articles/all/page-3/').route).toMatchObject({
      activeTab: 'blog',
      blogSection: 'canton-zh',
      blogArchive: true,
      blogPage: 3,
    });
    expect(parsePath('/articoli-zurigo/carburanti/').route).toEqual({
      activeTab: 'blog',
      blogSection: 'canton-zh',
      cantonTopic: 'carburanti',
    });
  });

  it('routes every one of the 96 closed prefixes to a canton blog section on corpus HTML', () => {
    vi.stubGlobal('document', fakeDocument('corpus'));
    expect(prefixes).toHaveLength(96);
    for (const prefix of prefixes) {
      const r = parsePath(`${prefix}/`);
      expect(r.notFoundPath, prefix).toBeUndefined();
      expect(r.route.activeTab, prefix).toBe('blog');
      expect(r.route.blogSection, prefix).toMatch(/^canton-/);
      expect(r.route.staticOverlay, prefix).toBeFalsy();
    }
  });

  it('keeps the generated core and localized SPA builder in parity for all 24×4 landings', () => {
    for (const entry of Object.values(CANTON_ARTICLE_SECTION_CORE)) {
      for (const locale of LOCALES) {
        const section = entry.section as `canton-${string}`;
        const path = buildPath({ activeTab: 'blog', blogSection: section }, locale);
        const expected = locale === 'it' ? `/${entry.indexSlug.it}/` : `/${locale}/${entry.indexSlug[locale]}/`;
        expect(path, `${section}:${locale}`).toBe(expected);

        vi.stubGlobal('document', fakeDocument('corpus'));
        expect(parsePath(path).route.blogSection, `${section}:${locale}`).toBe(section);
      }
    }
  });

  it('builds localized canton archives and preserves pagination', () => {
    expect(buildPath({ activeTab: 'blog', blogSection: 'canton-zh', blogArchive: true }, 'it'))
      .toBe('/articoli-zurigo/tutti/');
    expect(buildPath({ activeTab: 'blog', blogSection: 'canton-zh', blogArchive: true, blogPage: 3 }, 'en'))
      .toBe('/en/zurich-articles/all/page-3/');
  });

  it('builds all localized canton topic hubs from their reserved topic ids', () => {
    const entry = CANTON_ARTICLE_SECTION_CORE['canton-zh'];
    for (const topic of Object.keys(entry.topicHubs ?? {})) {
      for (const locale of LOCALES) {
        const path = buildPath({ activeTab: 'blog', blogSection: 'canton-zh', cantonTopic: topic }, locale);
        expect(path, `${topic}:${locale}`).toBe(
          locale === 'it'
            ? `/${entry.indexSlug.it}/${entry.topicHubs?.[topic]?.[locale]}/`
            : `/${locale}/${entry.indexSlug[locale]}/${entry.topicHubs?.[topic]?.[locale]}/`,
        );
      }
    }
  });

  it('parses the path contract independently of document ownership', () => {
    const match = parseCantonArticlePath('/de/tessin-artikel/alle/page-2/');
    expect(match).toEqual({ section: 'canton-ti', locale: 'de', kind: 'archive', page: 2 });
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
