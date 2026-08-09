/**
 * WHAT A RED HERE MEANS, SINCE #5298
 * ──────────────────────────────────
 * It used to mean one of two very different things with no way to tell them
 * apart from the failure: either the registry and the sitemaps had genuinely
 * parted (#3012 / #3120, the bugs this file exists for), or
 * `sync-articles-sitemaps.yml` had committed a pair caught mid-publish. The
 * second was common enough to poison the first — it held eight ready PRs for a
 * night, and every measurement taken during it pointed at a different cause,
 * because each was a snapshot of a different instant. Its signature was that the
 * SIGN inverted between runs, which a stable defect cannot do.
 *
 * The second meaning is now gone at the SOURCE: the sync checks the corpus out at
 * the exact commit the published API says it was built from, and skips the run
 * entirely when it cannot, so the two artifacts inside one commit describe one
 * upstream state by construction. Mechanism and coverage:
 * scripts/lib/articles-sync-pin.mjs, tests/articles-sync-pin.test.ts.
 *
 * The in-transit tolerance below therefore no longer has a condition to excuse.
 * It is kept as a backstop for pairs committed BEFORE the pin existed, and for
 * any writer of these files that is not the sync workflow; it is deliberately not
 * removed in the same change that closes the window, because deleting a
 * suppression and its cause together leaves nothing to observe. Delete it once
 * pinned syncs have run for a while — the criterion is that
 * `scripts/ci/check-blog-slugs-sitemap-sync.mjs`, which has no tolerance at all
 * and runs on every sync, has stayed green across a stretch of them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  IN_TRANSIT_WINDOW_MS,
  MAX_PRODUCER_SKEW_MS,
  frontierOf,
  hours,
  parseSitemapEntries,
  partitionMissingSlugs,
  partitionStaleUrls,
  skewMs,
  type SitemapEntry,
} from './helpers/sitemapTransitWindow';
import {
  loadSectionCanonicalOverrides,
  shadowedArticleIds,
} from '../scripts/lib/article-canonical-overrides.mjs';

// Canonical blog article URL bases per locale (matches sitemap-blog.xml entries).
const BLOG_URL_BASE: Record<string, string> = {
  it: 'https://frontaliereticino.ch/articoli-frontaliere/',
  en: 'https://frontaliereticino.ch/en/cross-border-articles/',
  de: 'https://frontaliereticino.ch/de/grenzgaenger-artikel/',
  fr: 'https://frontaliereticino.ch/fr/articles-frontalier/',
};

const BLOG_LOC_PATTERNS: Record<string, RegExp> = {
  it: /^https:\/\/frontaliereticino\.ch\/articoli-frontaliere\/([^/]+)\/$/,
  en: /^https:\/\/frontaliereticino\.ch\/en\/cross-border-articles\/([^/]+)\/$/,
  de: /^https:\/\/frontaliereticino\.ch\/de\/grenzgaenger-artikel\/([^/]+)\/$/,
  fr: /^https:\/\/frontaliereticino\.ch\/fr\/articles-frontalier\/([^/]+)\/$/,
};

// Canonical swiss-article URL bases per locale (matches sitemap-blog-ch.xml /
// sitemap-news.xml entries — hub slugs from scripts/create-article.mjs
// ARTICLE_SECTION_CONFIGS.svizzera.hubSlug).
const SWISS_URL_BASE: Record<string, string> = {
  it: 'https://frontaliereticino.ch/articoli-svizzera/',
  en: 'https://frontaliereticino.ch/en/swiss-articles/',
  de: 'https://frontaliereticino.ch/de/schweiz-artikel/',
  fr: 'https://frontaliereticino.ch/fr/articles-suisse/',
};

const SWISS_LOC_PATTERNS: Record<string, RegExp> = {
  it: /^https:\/\/frontaliereticino\.ch\/articoli-svizzera\/([^/]+)\/$/,
  en: /^https:\/\/frontaliereticino\.ch\/en\/swiss-articles\/([^/]+)\/$/,
  de: /^https:\/\/frontaliereticino\.ch\/de\/schweiz-artikel\/([^/]+)\/$/,
  fr: /^https:\/\/frontaliereticino\.ch\/fr\/articles-suisse\/([^/]+)\/$/,
};

// ─── The race this gate has to survive (issue #5298) ─────────────────────────
//
// Registry and sitemaps are written to main by two producers that are not in
// phase: `feat(article):` commits add an article to the registry without ever
// touching the section sitemaps, and `🗺️ Sync` commits mirror nanako's corpus
// over the registry while pulling the published sitemaps over HTTP — two
// sources read at two instants, so one commit can be inconsistent in EITHER
// direction. That is why the sign of this gate's failure inverted over a day
// at constant code, and why it was red on branches that had changed nothing.
//
// Every check below excuses exactly one thing: an item that sits at or beyond
// the OPPOSING producer's frontier. Everything behind that frontier — the
// whole body of the corpus, which is what #3012/#3120 are about — is asserted
// exactly as before. tests/sitemap-transit-window.test.ts pins both halves:
// that a real in-transit state passes, and that a real desync still fails.
// See tests/helpers/sitemapTransitWindow.ts for the measurements behind the
// two constants.

function readSitemap(name: string): string {
  return readFileSync(path.resolve(__dirname, '..', 'public', name), 'utf-8');
}

// sitemap-blog.xml structure: <loc> has the IT canonical URL only.
// EN/DE/FR slugs appear as `hreflang="LOCALE" href="URL"` in <xhtml:link> elements.
// Extract all locale→URL pairs from both <loc> (IT) and xhtml:link hreflang hrefs.
function extractSitemapUrls(xml: string): {
  locUrls: Set<string>;
  hreflangUrls: Map<string, Set<string>>;
} {
  const locUrls = new Set(
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim()),
  );
  const hreflangUrls = new Map<string, Set<string>>([
    ['it', new Set()], ['en', new Set()], ['de', new Set()], ['fr', new Set()],
  ]);
  for (const m of xml.matchAll(/hreflang="(it|en|de|fr)"\s+href="([^"]+)"/g)) {
    hreflangUrls.get(m[1])?.add(m[2].trim());
  }
  return { locUrls, hreflangUrls };
}

function buildValidSlugSets(
  slugs: Record<string, Record<string, string>>,
): Record<string, Set<string>> {
  const sets: Record<string, Set<string>> = { it: new Set(), en: new Set(), de: new Set(), fr: new Set() };
  for (const slugMap of Object.values(slugs)) {
    for (const [locale, slug] of Object.entries(slugMap)) {
      sets[locale]?.add(slug);
    }
  }
  return sets;
}

/** id → publication date, from the section's *-articles-data.ts registry. */
function datesById(articles: ReadonlyArray<{ id: string; date: string }>): Map<string, string> {
  return new Map(articles.map(a => [a.id, a.date]));
}

/**
 * The sitemap's own frontier FOR ONE SECTION: the newest `<url>` block whose
 * `<loc>` belongs to that section's hub. Section-scoped on purpose — the blog
 * and swiss pipelines publish at independent cadences, so the newest blog
 * entry says nothing about how far the swiss half has got.
 */
function sitemapFrontier(entries: readonly SitemapEntry[], itPattern: RegExp): string | undefined {
  return frontierOf(
    entries.filter(e => e.loc && itPattern.test(e.loc)).map(e => e.timestamp),
  );
}

/**
 * Frontaliere-section article ids whose IT slug is a canonical-override key.
 * Read through the shared node-side helper so this test cannot disagree with
 * `scripts/ci/check-blog-slugs-sitemap-sync.mjs`, `scripts/pull-articles-api.mjs`
 * or the renderer about which pages are shadowed.
 */
function blogShadowedIds(slugs: Record<string, Record<string, string>>): Set<string> {
  const root = path.resolve(__dirname, '..');
  return shadowedArticleIds(loadSectionCanonicalOverrides(root, 'frontaliere'), slugs);
}

function announce(what: string, frontierLabel: string, frontier: string | undefined, rows: string[]): void {
  if (!rows.length) return;
  console.info(
    `ℹ️ ${rows.length} ${what} beyond the ${frontierLabel} frontier (${frontier}) — in transit, not asserted:\n${rows.join('\n')}`,
  );
}

// Guard: every BLOG_SLUG locale URL must be present in sitemap-blog.xml.
// IT slugs → <loc>. EN/DE/FR slugs → <xhtml:link hreflang> href.
// Catches: slug renamed in routerBlogData.ts but sitemap not regenerated (#3012 class).
describe('BLOG_SLUGS ↔ sitemap-blog.xml sync (gate: prevents #3012 class bug)', () => {
  it('every non-shadowed BLOG_SLUG must appear in sitemap-blog.xml (IT: <loc>, others: hreflang href)', async () => {
    const { BLOG_SLUGS } = await import('../services/routerBlogData');
    const { ARTICLES } = await import('../data/blog-articles-data');
    const xml = readSitemap('sitemap-blog.xml');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
    const frontier = sitemapFrontier(parseSitemapEntries(xml), BLOG_LOC_PATTERNS.it);

    // Issue #3010 item 1, extended to the frontaliere section: a
    // canonical-overridden article's <url> block is intentionally DROPPED from
    // sitemap-blog.xml, because its own page canonicalises onto the winner of
    // its near-duplicate group. The page stays live — this only removes the
    // sitemap's crawl signal. Excluded here, asserted ABSENT in the dedicated
    // test below, exactly like the SWISS_SLUGS block further down.
    const shadowedIds = blogShadowedIds(BLOG_SLUGS as Record<string, Record<string, string>>);

    const { reported, inTransit } = partitionMissingSlugs({
      slugs: BLOG_SLUGS as Record<string, Record<string, string>>,
      dates: datesById(ARTICLES),
      urlBase: BLOG_URL_BASE,
      locUrls,
      hreflangUrls,
      sitemapFrontier: frontier,
      skipIds: shadowedIds,
    });
    announce('BLOG_SLUGS', 'sitemap-blog.xml', frontier, inTransit);

    expect(
      reported,
      `BLOG_SLUGS entries missing from sitemap-blog.xml (${reported.length}) — each is OLDER than the sitemap's own frontier (${frontier}), so the sitemap was regenerated past it and still lacks it:\n${reported.join('\n')}`,
    ).toHaveLength(0);
  });

  it('every shadowed (canonical-overridden) BLOG_SLUG is ABSENT from sitemap-blog.xml (IT: <loc>, others: hreflang href)', async () => {
    const { BLOG_SLUGS } = await import('../services/routerBlogData');
    const xml = readSitemap('sitemap-blog.xml');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
    const shadowedIds = blogShadowedIds(BLOG_SLUGS as Record<string, Record<string, string>>);

    // No transit window here, on purpose (same reasoning as the swiss twin):
    // this asserts ABSENCE, and a producer running late can only make a URL
    // missing, never make a shadowed one appear — so every hit is a real
    // self-canonical violation. scripts/pull-articles-api.mjs is what keeps
    // this true across the twice-daily refetch from the corpus publisher.
    const stillPresent: string[] = [];
    for (const articleId of shadowedIds) {
      const slugMap = (BLOG_SLUGS as Record<string, Record<string, string>>)[articleId];
      for (const [locale, slug] of Object.entries(slugMap ?? {})) {
        const base = BLOG_URL_BASE[locale];
        if (!base) continue;
        const url = `${base}${slug}/`;
        const present = locale === 'it' ? locUrls.has(url) : hreflangUrls.get(locale)?.has(url);
        if (present) stillPresent.push(`${articleId} [${locale}]: ${url}`);
      }
    }

    expect(
      stillPresent,
      `Canonical-overridden BLOG_SLUGS still listed in sitemap-blog.xml — violates the self-canonical gate (${stillPresent.length}):\n${stillPresent.join('\n')}`,
    ).toHaveLength(0);
  });

  // Guard: every blog URL in sitemap-blog.xml must correspond to a current BLOG_SLUG.
  // Catches: old/pre-collision slug still in sitemap after rename in routerBlogData.ts.
  it('every blog URL in sitemap-blog.xml must correspond to a BLOG_SLUG', async () => {
    const { BLOG_SLUGS } = await import('../services/routerBlogData');
    const { ARTICLES } = await import('../data/blog-articles-data');
    const xml = readSitemap('sitemap-blog.xml');
    const registryFrontier = frontierOf(ARTICLES.map(a => a.date));

    const { reported, inTransit } = partitionStaleUrls({
      entries: parseSitemapEntries(xml),
      validSlugs: buildValidSlugSets(BLOG_SLUGS as Record<string, Record<string, string>>),
      patterns: BLOG_LOC_PATTERNS,
      registryFrontier,
    });
    announce('sitemap-blog.xml URLs', 'blog registry', registryFrontier, inTransit);

    expect(
      reported,
      `sitemap-blog.xml URLs not in BLOG_SLUGS — stale after de-collision? (${reported.length}). Each is OLDER than the registry's own frontier (${registryFrontier}), so the registry has moved past it and still does not carry it:\n${reported.join('\n')}`,
    ).toHaveLength(0);
  });

  // Guard: every blog URL in sitemap-news.xml must correspond to a current BLOG_SLUG.
  // sitemap-news.xml is a subset — not all articles are there, but every entry must be valid.
  it('every blog URL in sitemap-news.xml must correspond to a BLOG_SLUG', async () => {
    const { BLOG_SLUGS } = await import('../services/routerBlogData');
    const { ARTICLES } = await import('../data/blog-articles-data');
    const xml = readSitemap('sitemap-news.xml');
    const registryFrontier = frontierOf(ARTICLES.map(a => a.date));

    const { reported, inTransit } = partitionStaleUrls({
      entries: parseSitemapEntries(xml),
      validSlugs: buildValidSlugSets(BLOG_SLUGS as Record<string, Record<string, string>>),
      patterns: BLOG_LOC_PATTERNS,
      registryFrontier,
    });
    announce('sitemap-news.xml blog URLs', 'blog registry', registryFrontier, inTransit);

    expect(
      reported,
      `sitemap-news.xml URLs not in BLOG_SLUGS — stale after de-collision? (${reported.length}). Each is OLDER than the registry's own frontier (${registryFrontier}):\n${reported.join('\n')}`,
    ).toHaveLength(0);
  });
});

// Guard: every SWISS_SLUG locale URL must be present/valid in sitemap-blog-ch.xml
// AND sitemap-news.xml (shared across sections). Mirrors the BLOG_SLUGS gate
// above — it was previously blind to swiss-article URLs entirely, because
// BLOG_LOC_PATTERNS never matches an `/articoli-svizzera/`-shaped URL, so a
// stale/cross-registry swiss hreflang slipped through undetected (#3116: 3
// dead URLs). #3120 is the follow-up hardening: without this block, a future
// swiss slug rename can silently desync sitemap-news.xml again.
describe('SWISS_SLUGS ↔ sitemap-blog-ch.xml / sitemap-news.xml sync (gate: prevents #3120 recidivism)', () => {
  it('every non-shadowed SWISS_SLUG must appear in sitemap-blog-ch.xml (IT: <loc>, others: hreflang href)', async () => {
    const { SWISS_SLUGS } = await import('../services/routerSwissData');
    const { SWISS_ARTICLES } = await import('../data/swiss-articles-data');
    const { loadSwissArticleCanonicalOverrides } = await import('../build-plugins/shared/swissArticleCanonicalOverrides');
    const xml = readSitemap('sitemap-blog-ch.xml');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
    const frontier = sitemapFrontier(parseSitemapEntries(xml), SWISS_LOC_PATTERNS.it);

    // Issue #3010 item 1 correction (2026-07-03): a canonical-overridden
    // article's <url> block is intentionally DROPPED from sitemap-blog-ch.xml
    // (same convention as data/job-canonical-overrides.json for jobs) — its
    // own IT slug is a key in the override map. Excluded here, asserted
    // ABSENT in the dedicated test below instead.
    const overrides = loadSwissArticleCanonicalOverrides({ readFileSync }, path.resolve(__dirname, '..', 'data', 'swiss-article-canonical-overrides.json'));
    const shadowedIds = new Set(
      Object.entries(SWISS_SLUGS as Record<string, Record<string, string>>)
        .filter(([, slugMap]) => slugMap.it && Object.prototype.hasOwnProperty.call(overrides, slugMap.it))
        .map(([id]) => id),
    );

    const { reported, inTransit } = partitionMissingSlugs({
      slugs: SWISS_SLUGS as Record<string, Record<string, string>>,
      dates: datesById(SWISS_ARTICLES),
      urlBase: SWISS_URL_BASE,
      locUrls,
      hreflangUrls,
      sitemapFrontier: frontier,
      skipIds: shadowedIds,
    });
    announce('SWISS_SLUGS', 'sitemap-blog-ch.xml', frontier, inTransit);

    expect(
      reported,
      `SWISS_SLUGS entries missing from sitemap-blog-ch.xml (${reported.length}) — each is OLDER than the sitemap's own frontier (${frontier}):\n${reported.join('\n')}`,
    ).toHaveLength(0);
  });

  it('every shadowed (canonical-overridden) SWISS_SLUG is ABSENT from sitemap-blog-ch.xml (IT: <loc>, others: hreflang href)', async () => {
    const { SWISS_SLUGS } = await import('../services/routerSwissData');
    const { loadSwissArticleCanonicalOverrides } = await import('../build-plugins/shared/swissArticleCanonicalOverrides');
    const xml = readSitemap('sitemap-blog-ch.xml');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
    const overrides = loadSwissArticleCanonicalOverrides({ readFileSync }, path.resolve(__dirname, '..', 'data', 'swiss-article-canonical-overrides.json'));

    // No transit window here, on purpose: this asserts ABSENCE. A producer
    // running late can only make a URL missing, never make a shadowed one
    // appear — so every hit is a real self-canonical violation.
    const stillPresent: string[] = [];
    for (const [articleId, slugMap] of Object.entries(SWISS_SLUGS as Record<string, Record<string, string>>)) {
      const itSlug = (slugMap as Record<string, string>).it;
      if (!itSlug || !Object.prototype.hasOwnProperty.call(overrides, itSlug)) continue;
      for (const [locale, slug] of Object.entries(slugMap)) {
        const base = SWISS_URL_BASE[locale];
        if (!base) continue;
        const url = `${base}${slug}/`;
        const present = locale === 'it' ? locUrls.has(url) : hreflangUrls.get(locale)?.has(url);
        if (present) stillPresent.push(`${articleId} [${locale}]: ${url}`);
      }
    }

    expect(
      stillPresent,
      `Canonical-overridden SWISS_SLUGS still listed in sitemap-blog-ch.xml — violates self-canonical gate (${stillPresent.length}):\n${stillPresent.join('\n')}`,
    ).toHaveLength(0);
  });

  // Guard: every swiss URL in sitemap-blog-ch.xml must correspond to a current SWISS_SLUG.
  it('every swiss URL in sitemap-blog-ch.xml must correspond to a SWISS_SLUG', async () => {
    const { SWISS_SLUGS } = await import('../services/routerSwissData');
    const { SWISS_ARTICLES } = await import('../data/swiss-articles-data');
    const xml = readSitemap('sitemap-blog-ch.xml');
    const registryFrontier = frontierOf(SWISS_ARTICLES.map(a => a.date));

    const { reported, inTransit } = partitionStaleUrls({
      entries: parseSitemapEntries(xml),
      validSlugs: buildValidSlugSets(SWISS_SLUGS as Record<string, Record<string, string>>),
      patterns: SWISS_LOC_PATTERNS,
      registryFrontier,
    });
    announce('sitemap-blog-ch.xml URLs', 'swiss registry', registryFrontier, inTransit);

    expect(
      reported,
      `sitemap-blog-ch.xml URLs not in SWISS_SLUGS — stale after de-collision? (${reported.length}). Each is OLDER than the registry's own frontier (${registryFrontier}):\n${reported.join('\n')}`,
    ).toHaveLength(0);
  });

  // The exact gate that would have caught #3116: sitemap-news.xml is SHARED
  // across the frontaliere and svizzera sections. A swiss <url> block whose
  // hreflang alternates were built from a stale or wrong-registry slug (e.g.
  // read from routerBlogData instead of routerSwissData) shows up here as a
  // URL under the swiss hub shape that no current SWISS_SLUG resolves to.
  //
  // This is also the assertion that reported #5298: on 10c8c817 the sync
  // commit removed `rimborsi-730-sostituti-imposta` from routerSwissData.ts
  // (+1 −2) in the very same commit that added its <url> block here.
  it('every swiss URL in sitemap-news.xml must correspond to a current SWISS_SLUG', async () => {
    const { SWISS_SLUGS } = await import('../services/routerSwissData');
    const { SWISS_ARTICLES } = await import('../data/swiss-articles-data');
    const xml = readSitemap('sitemap-news.xml');
    const registryFrontier = frontierOf(SWISS_ARTICLES.map(a => a.date));

    const { reported, inTransit } = partitionStaleUrls({
      entries: parseSitemapEntries(xml),
      validSlugs: buildValidSlugSets(SWISS_SLUGS as Record<string, Record<string, string>>),
      patterns: SWISS_LOC_PATTERNS,
      registryFrontier,
    });
    announce('sitemap-news.xml swiss URLs', 'swiss registry', registryFrontier, inTransit);

    expect(
      reported,
      `sitemap-news.xml URLs not in SWISS_SLUGS — stale after de-collision? (${reported.length}). Each is OLDER than the registry's own frontier (${registryFrontier}):\n${reported.join('\n')}`,
    ).toHaveLength(0);
  });

  // Synthetic cross-registry collision (issue #3120 verification): a swiss
  // article and a blog article sharing the SAME article id but DIFFERENT
  // localized slugs. The swiss article's <url> block must validate only
  // against SWISS_SLUGS — never pass by accidentally matching the blog
  // article's slug (the exact failure mode that produced 3 dead URLs in
  // sitemap-news.xml under PR #3116).
  it('a swiss article never resolves against a blog article sharing the same id (cross-registry guard)', () => {
    const sharedId = 'ristorni-fiscali-frontaliere';
    const fakeBlogSlugs: Record<string, Record<string, string>> = {
      [sharedId]: { it: 'ristorni-fiscali-frontaliere', en: 'tax-rebates-border-workers', de: 'steuer-rueckzahlungen-grenzgaenger', fr: 'ristournes-fiscales-frontaliers' },
    };
    const fakeSwissSlugs: Record<string, Record<string, string>> = {
      [sharedId]: { it: 'ristorni-fiscali-frontaliere', en: 'fiscal-reimbursements-for-frontier-workers-how-they-work', de: 'steuer-ruckerstattungen-fur-grenzpendler-wie-sie-funktionieren', fr: 'remboursements-fiscaux-pour-travailleurs-frontaliers-comment-ils-fonctionnent' },
    };

    const blogValidSlugs = buildValidSlugSets(fakeBlogSlugs);
    const swissValidSlugs = buildValidSlugSets(fakeSwissSlugs);

    // Simulate the generator emitting the swiss article's <url> block with
    // its OWN (correct) slug.
    const correctSwissUrl = `${SWISS_URL_BASE.en}${fakeSwissSlugs[sharedId].en}/`;
    const match = correctSwissUrl.match(SWISS_LOC_PATTERNS.en);
    expect(match).not.toBeNull();

    // Must validate against SWISS_SLUGS...
    expect(swissValidSlugs.en.has(match![1])).toBe(true);
    // ...and must NOT be satisfiable via the blog registry (proves the two
    // registries stay isolated — the #3120-class bug would have the swiss
    // <url> block emit `fakeBlogSlugs[sharedId].en` instead).
    expect(blogValidSlugs.en.has(match![1])).toBe(false);
    expect(fakeSwissSlugs[sharedId].en).not.toEqual(fakeBlogSlugs[sharedId].en);
  });
});

// ─── The backstop that keeps the transit window from going blind ─────────────
//
// The window excuses items beyond the opposing frontier. If a producer STOPS,
// its frontier freezes and every subsequent article sits beyond it — tolerated
// forever, gate blind, exactly the outcome #5298 says not to accept. This
// bounds the whole arrangement: the two producers may be minutes or hours
// apart, never days. Only the two COMPLETE sitemaps are checked;
// sitemap-news.xml is a rolling recency window whose frontier legitimately
// lags whenever nothing news-shaped has been published.
describe('registry ↔ sitemap producer skew stays inside the sync cadence (gate: keeps the #5298 window bounded)', () => {
  it.each([
    ['blog', 'sitemap-blog.xml'],
    ['swiss', 'sitemap-blog-ch.xml'],
  ] as const)('%s registry and %s frontiers stay within the sync cadence', async (section, sitemapName) => {
    const patterns = section === 'blog' ? BLOG_LOC_PATTERNS : SWISS_LOC_PATTERNS;
    const articles = section === 'blog'
      ? (await import('../data/blog-articles-data')).ARTICLES
      : (await import('../data/swiss-articles-data')).SWISS_ARTICLES;

    const registryFrontier = frontierOf(articles.map(a => a.date));
    const mapFrontier = sitemapFrontier(parseSitemapEntries(readSitemap(sitemapName)), patterns.it);

    expect(registryFrontier, `${section} registry carries no parseable publication date`).toBeTruthy();
    expect(mapFrontier, `${sitemapName} carries no parseable ${section} entry timestamp`).toBeTruthy();

    const lag = Math.abs(skewMs(registryFrontier, mapFrontier));
    expect(
      lag <= MAX_PRODUCER_SKEW_MS,
      `${section} registry frontier (${registryFrontier}) and ${sitemapName} frontier (${mapFrontier}) are ${hours(lag)} apart — beyond the ${hours(MAX_PRODUCER_SKEW_MS)} bound. One of the two producers has stopped: that is not the publish-to-sync window the transit tolerance (${hours(IN_TRANSIT_WINDOW_MS)}) exists for, and while it lasts the tolerance would hide real desyncs.`,
    ).toBe(true);
  });
});
