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
 *
 * ── GROUP-DRIVEN SINCE #5510 ─────────────────────────────────────────────
 *
 * This file used to hardcode the one `piastrellista` family it was written
 * for: a `WINNER_ID` constant and a two-element `SHADOWED_IDS`. That shape is
 * a guard that only guards what its author happened to type — adding the
 * `educatore` family would have left it green while asserting nothing about
 * it, and the count assertions would have had to be edited to a new magic
 * number to stay green, which is the tell.
 *
 * So the cases are now BUILT from the `_groups` map inside the data file.
 * Adding a family to the JSON adds its cases here on the next run, and adding
 * one without its `4 x N` override rows fails on the count assertion instead
 * of shipping half-wired. The data file is the input, not a second copy of it.
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

/** The data file, read once — it is both the subject and the case source. */
const RAW = JSON.parse(
  readFileSync(resolve(root, 'packages/articles/engine/shared/frontaliere-article-canonical-overrides.json'), 'utf-8'),
) as {
  _groups: Record<string, { winner: string; shadowed: string[] }>;
  overrides: Record<string, string>;
};

/**
 * Every near-duplicate family the map consolidates, in declaration order.
 *
 *  - `piastrellista` — winner decided by the owner:
 *    `frontaliere-piastrellista-ticino-stipendio-requisiti` (2026-08-09
 *    15:44Z, the most complete of the three: stipendio + requisiti +
 *    riconoscimento del titolo).
 *  - `educatore` (#5510) — winner `frontaliere-educatore-ticino-stipendio-requisiti`
 *    (2026-07-23): the newest of the six, and the only one carrying the
 *    `frontaliere-<mestiere>-ticino-stipendio-requisiti` shape the owner had
 *    already chosen for piastrellista. The three educatore guides in the
 *    SVIZZERA section stay out on purpose — `data/swiss-article-canonical-overrides.json`
 *    owns them and already made `lavorare-educatore-infanzia-ticino` a winner
 *    there; pulling them across sections would move a settled canonical.
 *
 * In every family the losers stay live and canonicalise onto the winner.
 */
const GROUPS = Object.entries(RAW._groups).map(([name, g]) => ({
  name,
  winnerId: g.winner,
  shadowedIds: g.shadowed,
}));

const ALL_SHADOWED_IDS = GROUPS.flatMap((g) => g.shadowedIds);
const ALL_WINNER_IDS = GROUPS.map((g) => g.winnerId);

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

  it('the map loads through the same loader the renderer uses (one row per shadowed id x locale)', () => {
    // Derived, not a magic number: a family declared in `_groups` without its
    // four locale rows — or four rows for a family nobody declared — fails
    // here. Those are the two ways this file has to go half-wired.
    expect(GROUPS.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(overrides)).toHaveLength(ALL_SHADOWED_IDS.length * LOCALES.length);
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

describe.each(GROUPS)('$name: a shadowed page canonicalises onto the winner, in every locale', ({ winnerId, shadowedIds }) => {
  for (const shadowedId of shadowedIds) {
    for (const locale of LOCALES) {
      it(`${shadowedId} [${locale}] -> ${winnerId}`, () => {
        const own = urlOf(shadowedId, locale);
        const winner = urlOf(winnerId, locale);
        // This is the value ogPagesPlugin writes into <link rel="canonical">
        // AND <meta property="og:url"> — one resolver, both tags.
        expect(resolveSwissArticleCanonicalUrl(slugOf(shadowedId, locale), overrides, own)).toBe(winner);
      });
    }
  }

  it('the winner stays canonical of itself in every locale (it has no entry in the map)', () => {
    for (const locale of LOCALES) {
      const own = urlOf(winnerId, locale);
      expect(overrides[slugOf(winnerId, locale)]).toBeUndefined();
      expect(resolveSwissArticleCanonicalUrl(slugOf(winnerId, locale), overrides, own)).toBe(own);
    }
  });

  it('the JSON-LD dateModified fallback resolves the winner slug for a shadowed page', () => {
    // Issue #3368 item 1: the shadowed page is out of the sitemap, so its own
    // <lastmod> lookup misses; the winner's is the freshness proxy.
    for (const shadowedId of shadowedIds) {
      expect(resolveShadowedArticleWinnerSlug(slugOf(shadowedId, 'it'), overrides)).toBe(slugOf(winnerId, 'it'));
    }
    expect(resolveShadowedArticleWinnerSlug(slugOf(winnerId, 'it'), overrides)).toBeUndefined();
  });

  it('no winner is itself shadowed by another family (no canonical chain)', () => {
    // A -> B -> C would make Google follow a chain it is entitled to ignore,
    // and the second hop is invisible in any single-family assertion.
    for (const locale of LOCALES) {
      expect(overrides[slugOf(winnerId, locale)], `${winnerId} [${locale}] is a winner AND a shadowed key`).toBeUndefined();
    }
  });
});

describe('the shadowed pages are out of the sitemap, the winner is in it', () => {
  const sitemapBlog = readFileSync(resolve(root, 'public', 'sitemap-blog.xml'), 'utf-8');
  const sitemapNews = readFileSync(resolve(root, 'public', 'sitemap-news.xml'), 'utf-8');

  for (const shadowedId of ALL_SHADOWED_IDS) {
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

  for (const winnerId of ALL_WINNER_IDS) {
    it(`${winnerId} is PRESENT in sitemap-blog.xml (self-canonical winner)`, () => {
      expect(sitemapBlog).toContain(`/articoli-frontaliere/${slugOf(winnerId, 'it')}/</loc>`);
    });
  }

  it('the sitemap gate exempts exactly the shadowed ids, never a winner', () => {
    const ids = shadowedArticleIds(overrides, BLOG_SLUGS as Record<string, Record<string, string>>);
    for (const shadowedId of ALL_SHADOWED_IDS) expect(ids.has(shadowedId)).toBe(true);
    for (const winnerId of ALL_WINNER_IDS) expect(ids.has(winnerId)).toBe(false);
    // Exactly: an override row for an id nobody declared shadowed would
    // silently de-list a page from the sitemap.
    expect([...ids].sort()).toEqual([...ALL_SHADOWED_IDS].sort());
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
  const doc = `<urlset>\n${block('lavoro-piastrellista-ticino-frontaliere')}${block(slugOf(GROUPS[0].winnerId, 'it'))}</urlset>\n`;

  it('drops the shadowed block whole (alternates included) and keeps the winner', () => {
    const { xml, dropped } = dropShadowedSitemapUrlBlocks(doc, new Set(Object.keys(overrides)));
    expect(dropped).toHaveLength(1);
    expect(xml).not.toContain('lavoro-piastrellista-ticino-frontaliere');
    expect(xml).toContain(slugOf(GROUPS[0].winnerId, 'it'));
  });

  it('is idempotent and a no-op with an empty shadow set', () => {
    const once = dropShadowedSitemapUrlBlocks(doc, new Set(Object.keys(overrides))).xml;
    expect(dropShadowedSitemapUrlBlocks(once, new Set(Object.keys(overrides))).xml).toBe(once);
    expect(dropShadowedSitemapUrlBlocks(doc, new Set()).xml).toBe(doc);
  });
});

describe('anti-cut rule: nothing is removed, redirected or noindexed', () => {
  const registryIds = new Set(ARTICLES.map((a) => a.id));

  for (const id of [...ALL_WINNER_IDS, ...ALL_SHADOWED_IDS]) {
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
    expect(Object.keys(raw.overrides)).toHaveLength(ALL_SHADOWED_IDS.length * LOCALES.length);
  });

  it('every shadowed slug points at the winner URL of its OWN locale', () => {
    for (const { winnerId, shadowedIds } of GROUPS) {
      for (const shadowedId of shadowedIds) {
        for (const locale of LOCALES) {
          expect(overrides[slugOf(shadowedId, locale)]).toBe(urlOf(winnerId, locale));
        }
      }
    }
  });

  it('no id is declared in two families at once', () => {
    // Two families claiming the same page is how a "winner" quietly acquires
    // a canonical of its own without any single family's assertions noticing.
    const all = [...ALL_WINNER_IDS, ...ALL_SHADOWED_IDS];
    expect(new Set(all).size, `duplicate id across _groups: ${all.join(', ')}`).toBe(all.length);
  });
});
