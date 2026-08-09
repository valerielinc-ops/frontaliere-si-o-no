/**
 * Canonical-override consolidation for the FRONTALIERE section.
 *
 * The mechanism (issue #3010 item 1) already existed for the svizzera section:
 * the shadowed member of a near-duplicate pair points `<link rel="canonical">`
 * and `og:url` at the authoritative winner, both pages stay live, and the
 * shadowed URL is not advertised in a sitemap. It was hardwired to
 * `SECTION.name === 'svizzera'` in `packages/articles/engine/ogPagesPlugin.ts`,
 * so the larger section had no way to use it — which is why the three
 * `piastrellista` guides the generator published on 2026-08-09 (11:30, 15:44
 * and 16:08 UTC, before the corpus-side "argomento gia' coperto" gate landed)
 * were left cannibalising each other in SERP.
 *
 * These tests fail without the extension. Removing `canonicalOverrides` from
 * the frontaliere entry of `ARTICLE_SECTION_DESCRIPTORS` — the whole of the
 * wiring — turns the first three describe blocks red (measured), because the
 * plugin's own loader call is reproduced here verbatim rather than restated.
 *
 * ANTI-CUT RULE. Nothing here may pass by removing or noindexing a page. The
 * last block asserts the opposite: all three articles stay in the registry,
 * the router and every locale slug map, and the winner keeps its sitemap
 * entry. A shadowed page answering 404 would be a worse outcome than the
 * duplication it fixes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  loadSwissArticleCanonicalOverrides,
  resolveSwissArticleCanonicalUrl,
  resolveShadowedArticleWinnerSlug,
} from '@/build-plugins/shared/swissArticleCanonicalOverrides';
import { ARTICLE_SECTION_DESCRIPTORS } from '@/build-plugins/shared/articleSectionDescriptors';
import { CANONICAL_OVERRIDE_FILES } from '@/packages/articles/engine/shared/canonicalOverrideFiles.mjs';
import {
  dropShadowedSitemapUrlBlocks,
  loadSectionCanonicalOverrides,
  shadowedArticleIds,
} from '@/scripts/lib/article-canonical-overrides.mjs';
import { ALL_BLOG_ARTICLE_IDS, BLOG_SLUGS } from '@/services/routerBlogData';
import { ARTICLES } from '@/data/blog-articles-data';

const root = resolve(__dirname, '..');

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Locale = (typeof LOCALES)[number];

/** Locale -> `/…/<slug>/` URL prefix for the frontaliere section. */
const URL_BASE: Record<Locale, string> = {
  it: 'https://frontaliereticino.ch/articoli-frontaliere/',
  en: 'https://frontaliereticino.ch/en/cross-border-articles/',
  de: 'https://frontaliereticino.ch/de/grenzgaenger-artikel/',
  fr: 'https://frontaliereticino.ch/fr/articles-frontalier/',
};

/**
 * The `piastrellista` group. Winner decided by the owner:
 * `frontaliere-piastrellista-ticino-stipendio-requisiti` (2026-08-09 15:44Z,
 * the most complete of the three — stipendio + requisiti + riconoscimento del
 * titolo). The other two stay live and canonicalise onto it.
 */
const WINNER_ID = 'frontaliere-piastrellista-ticino-stipendio-requisiti';
const SHADOWED_IDS = [
  'lavoro-piastrellista-ticino-frontaliere', // 2026-08-09 16:08Z
  'piastrellista-frontaliere-ticino-guadagno', // added to the corpus 2026-08-09 11:30Z
] as const;

const slugOf = (id: string, locale: Locale): string => {
  const slug = (BLOG_SLUGS as Record<string, Record<string, string>>)[id]?.[locale];
  if (!slug) throw new Error(`BLOG_SLUGS has no ${locale} slug for ${id} — the article left the registry`);
  return slug;
};
const urlOf = (id: string, locale: Locale): string => `${URL_BASE[locale]}${slugOf(id, locale)}/`;

// The plugin's own call, reproduced: `ogPagesPlugin.ts` loads
// `SECTION.canonicalOverrides` through this loader, resolving each candidate
// against rootDir. Reading it the same way here is what makes the descriptor
// wiring — not a second copy of the paths — the thing under test.
const frontaliereSection = ARTICLE_SECTION_DESCRIPTORS.find((s) => s.name === 'frontaliere')!;
const overrides = loadSwissArticleCanonicalOverrides(
  { readFileSync },
  (frontaliereSection.canonicalOverrides ?? []).map((p) => resolve(root, p)),
);

describe('the frontaliere section is wired to a canonical-override map', () => {
  it('ARTICLE_SECTION_DESCRIPTORS gives frontaliere at least one candidate path', () => {
    expect(frontaliereSection.canonicalOverrides).toBeDefined();
    expect(frontaliereSection.canonicalOverrides.length).toBeGreaterThan(0);
  });

  it('the map loads through the same loader the renderer uses (8 entries: 2 shadowed x 4 locales)', () => {
    expect(Object.keys(overrides)).toHaveLength(SHADOWED_IDS.length * LOCALES.length);
  });

  it('ships inside packages/articles/engine/, the only site path that reaches the renderer', () => {
    // mirror-articles-engine.yml carries `packages/articles/engine/**` and
    // nothing else; scripts/pull-articles-corpus.mjs mirrors the corpus's
    // content/ back over packages/articles/content/ WITH deletions, so a data
    // file placed there would be deleted on the next pull. If this assertion
    // ever has to change, the override will stop reaching the repo that
    // renders article pages — silently, because a missing file loads as `{}`.
    expect(CANONICAL_OVERRIDE_FILES.frontaliere[0]).toBe(
      'packages/articles/engine/shared/frontaliere-article-canonical-overrides.json',
    );
    expect(CANONICAL_OVERRIDE_FILES.frontaliere).toContain(
      'engine/shared/frontaliere-article-canonical-overrides.json',
    );
  });

  it('leaves the svizzera map alone (12 entries, no frontaliere key)', () => {
    const swiss = loadSectionCanonicalOverrides(root, 'svizzera');
    expect(Object.keys(swiss)).toHaveLength(12);
    for (const key of Object.keys(overrides)) expect(swiss[key]).toBeUndefined();
  });
});

describe('a shadowed piastrellista page canonicalises onto the winner, in every locale', () => {
  for (const shadowedId of SHADOWED_IDS) {
    for (const locale of LOCALES) {
      it(`${shadowedId} [${locale}] -> ${WINNER_ID}`, () => {
        const own = urlOf(shadowedId, locale);
        const winner = urlOf(WINNER_ID, locale);
        // This is the value ogPagesPlugin writes into <link rel="canonical">
        // AND <meta property="og:url"> — one resolver, both tags.
        expect(resolveSwissArticleCanonicalUrl(slugOf(shadowedId, locale), overrides, own)).toBe(winner);
      });
    }
  }

  it('the winner stays canonical of itself in every locale (it has no entry in the map)', () => {
    for (const locale of LOCALES) {
      const own = urlOf(WINNER_ID, locale);
      expect(overrides[slugOf(WINNER_ID, locale)]).toBeUndefined();
      expect(resolveSwissArticleCanonicalUrl(slugOf(WINNER_ID, locale), overrides, own)).toBe(own);
    }
  });

  it('the JSON-LD dateModified fallback resolves the winner slug for a shadowed page', () => {
    // Issue #3368 item 1: the shadowed page is out of the sitemap, so its own
    // <lastmod> lookup misses; the winner's is the freshness proxy.
    for (const shadowedId of SHADOWED_IDS) {
      expect(resolveShadowedArticleWinnerSlug(slugOf(shadowedId, 'it'), overrides)).toBe(slugOf(WINNER_ID, 'it'));
    }
    expect(resolveShadowedArticleWinnerSlug(slugOf(WINNER_ID, 'it'), overrides)).toBeUndefined();
  });
});

describe('the shadowed pages are out of the sitemap, the winner is in it', () => {
  const sitemapBlog = readFileSync(resolve(root, 'public', 'sitemap-blog.xml'), 'utf-8');
  const sitemapNews = readFileSync(resolve(root, 'public', 'sitemap-news.xml'), 'utf-8');

  for (const shadowedId of SHADOWED_IDS) {
    it(`${shadowedId} is ABSENT from sitemap-blog.xml (its <loc> would not self-canonicalise)`, () => {
      expect(sitemapBlog).not.toContain(`/articoli-frontaliere/${slugOf(shadowedId, 'it')}/</loc>`);
    });

    it(`${shadowedId} has no hreflang alternate left behind either`, () => {
      for (const locale of LOCALES) {
        expect(sitemapBlog).not.toContain(`href="${urlOf(shadowedId, locale)}"`);
      }
    });

    it(`${shadowedId} is ABSENT from sitemap-news.xml`, () => {
      expect(sitemapNews).not.toContain(`/articoli-frontaliere/${slugOf(shadowedId, 'it')}/</loc>`);
    });
  }

  it(`${WINNER_ID} is PRESENT in sitemap-blog.xml (self-canonical winner)`, () => {
    expect(sitemapBlog).toContain(`/articoli-frontaliere/${slugOf(WINNER_ID, 'it')}/</loc>`);
  });

  it('the sitemap gate exempts exactly the shadowed ids, never the winner', () => {
    const ids = shadowedArticleIds(overrides, BLOG_SLUGS as Record<string, Record<string, string>>);
    for (const shadowedId of SHADOWED_IDS) expect(ids.has(shadowedId)).toBe(true);
    expect(ids.has(WINNER_ID)).toBe(false);
  });
});

describe('dropShadowedSitemapUrlBlocks (the ingest filter that keeps it true)', () => {
  // public/sitemap-*.xml are refetched from the corpus publisher by
  // sync-articles-sitemaps.yml (cron 5:23/17:23), so the de-listing has to
  // survive the pull, not just the commit.
  const block = (slug: string) =>
    `  <url>\n    <loc>https://frontaliereticino.ch/articoli-frontaliere/${slug}/</loc>\n` +
    `    <xhtml:link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/articoli-frontaliere/${slug}/" />\n` +
    `  </url>\n`;
  const doc = `<urlset>\n${block('lavoro-piastrellista-ticino-frontaliere')}${block(slugOf(WINNER_ID, 'it'))}</urlset>\n`;

  it('drops the shadowed block whole (alternates included) and keeps the winner', () => {
    const { xml, dropped } = dropShadowedSitemapUrlBlocks(doc, new Set(Object.keys(overrides)));
    expect(dropped).toHaveLength(1);
    expect(xml).not.toContain('lavoro-piastrellista-ticino-frontaliere');
    expect(xml).toContain(slugOf(WINNER_ID, 'it'));
  });

  it('is idempotent and a no-op with an empty shadow set', () => {
    const once = dropShadowedSitemapUrlBlocks(doc, new Set(Object.keys(overrides))).xml;
    expect(dropShadowedSitemapUrlBlocks(once, new Set(Object.keys(overrides))).xml).toBe(once);
    expect(dropShadowedSitemapUrlBlocks(doc, new Set()).xml).toBe(doc);
  });
});

describe('anti-cut rule: nothing is removed, redirected or noindexed', () => {
  const registryIds = new Set(ARTICLES.map((a) => a.id));

  for (const id of [WINNER_ID, ...SHADOWED_IDS]) {
    it(`${id} is still a live, routable article (registry + router + 4 locale slugs)`, () => {
      expect(registryIds.has(id), `${id} left data/blog-articles-data.ts`).toBe(true);
      expect(ALL_BLOG_ARTICLE_IDS).toContain(id);
      for (const locale of LOCALES) expect(slugOf(id, locale)).toBeTruthy();
    });
  }

  it('the override map only ever carries absolute winner URLs — no noindex/redirect verb', () => {
    // The map's entire vocabulary is "canonical target". There is no field a
    // future edit could use to hide a page, and this asserts it stays that way.
    const raw = JSON.parse(
      readFileSync(resolve(root, CANONICAL_OVERRIDE_FILES.frontaliere[0]), 'utf-8'),
    ) as { overrides: Record<string, string> };
    for (const [slug, target] of Object.entries(raw.overrides)) {
      expect(typeof slug).toBe('string');
      expect(target).toMatch(/^https:\/\/frontaliereticino\.ch\/.+\/$/);
    }
    expect(Object.keys(raw.overrides)).toHaveLength(8);
  });

  it('every shadowed slug points at the winner URL of its OWN locale', () => {
    for (const shadowedId of SHADOWED_IDS) {
      for (const locale of LOCALES) {
        expect(overrides[slugOf(shadowedId, locale)]).toBe(urlOf(WINNER_ID, locale));
      }
    }
  });
});
