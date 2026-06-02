/**
 * Routing contract for the Switzerland-wide ("svizzera") article section —
 * the national mirror of the cross-border ("frontaliere") blog section.
 *
 * Verifies (independently of how many articles are seeded):
 * 1. The hub slug resolves in all 4 locales (parsePath + buildPath round-trip).
 * 2. An unknown article slug under the hub defers to `swissSlug` with
 *    `blogSection: 'svizzera'` (pre-load fallback, mirrors the frontaliere path).
 * 3. REVERSE_SWISS is derived consistently from SWISS_SLUGS.
 * 4. Any seeded article round-trips: buildPath(id) → localized slug, and
 *    parsePath of that URL resolves back to the id.
 */
import { describe, it, expect } from 'vitest';
import { buildPath, parsePath, preloadSwissData, resolveSwissSlug } from '@/services/router';
import { SWISS_SLUGS, REVERSE_SWISS, ALL_SWISS_ARTICLE_IDS } from '@/services/routerSwissData';

const HUB_SLUG = {
  it: 'articoli-svizzera',
  en: 'swiss-articles',
  de: 'schweiz-artikel',
  fr: 'articles-suisse',
} as const;

const LOCALE_PREFIX = { it: '', en: '/en', de: '/de', fr: '/fr' } as const;

await preloadSwissData();

describe('svizzera article section — routing', () => {
  it('hub buildPath emits the localized svizzera hub slug', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const path = buildPath({ activeTab: 'blog', blogSection: 'svizzera' }, locale);
      expect(path).toContain(`/${HUB_SLUG[locale]}`);
      // Must NOT collide with the frontaliere hub slug.
      expect(path).not.toContain('articoli-frontaliere');
    }
  });

  it('hub parsePath maps the svizzera hub to the blog tab with blogSection=svizzera', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const url = `${LOCALE_PREFIX[locale]}/${HUB_SLUG[locale]}/`;
      const { route, locale: parsedLocale } = parsePath(url);
      expect(route.activeTab).toBe('blog');
      expect(route.blogSection).toBe('svizzera');
      expect(parsedLocale).toBe(locale);
    }
  });

  it('an unknown article slug under the hub defers to swissSlug', () => {
    const { route } = parsePath('/articoli-svizzera/qualche-slug-non-esistente/');
    expect(route.activeTab).toBe('blog');
    expect(route.blogSection).toBe('svizzera');
    // Either resolved (if seeded) or deferred — but never silently dropped.
    expect(route.swissArticle ?? route.swissSlug).toBe(
      route.swissArticle ?? 'qualche-slug-non-esistente',
    );
  });

  it('REVERSE_SWISS is consistent with SWISS_SLUGS', () => {
    expect(ALL_SWISS_ARTICLE_IDS).toEqual(Object.keys(SWISS_SLUGS));
    for (const [id, slugs] of Object.entries(SWISS_SLUGS)) {
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(REVERSE_SWISS[locale][slugs[locale]]).toBe(id);
      }
    }
  });

  it('every seeded article round-trips through buildPath/parsePath', () => {
    for (const id of ALL_SWISS_ARTICLE_IDS) {
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const slug = SWISS_SLUGS[id][locale];
        const path = buildPath({ activeTab: 'blog', blogSection: 'svizzera', swissArticle: id }, locale);
        expect(path).toContain(`/${HUB_SLUG[locale]}/${slug}`);

        const { route } = parsePath(path);
        expect(route.blogSection).toBe('svizzera');
        expect(route.swissArticle).toBe(id);
        expect(resolveSwissSlug(slug, locale)).toBe(id);
      }
    }
  });
});
