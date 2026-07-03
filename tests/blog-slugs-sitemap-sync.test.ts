import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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

// Guard: every BLOG_SLUG locale URL must be present in sitemap-blog.xml.
// IT slugs → <loc>. EN/DE/FR slugs → <xhtml:link hreflang> href.
// Catches: slug renamed in routerBlogData.ts but sitemap not regenerated (#3012 class).
describe('BLOG_SLUGS ↔ sitemap-blog.xml sync (gate: prevents #3012 class bug)', () => {
  it('every BLOG_SLUG must appear in sitemap-blog.xml (IT: <loc>, others: hreflang href)', async () => {
    const { BLOG_SLUGS } = await import('../services/routerBlogData');
    const xml = readFileSync(path.resolve(__dirname, '..', 'public', 'sitemap-blog.xml'), 'utf-8');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);

    const missing: string[] = [];
    for (const [articleId, slugMap] of Object.entries(BLOG_SLUGS)) {
      for (const [locale, slug] of Object.entries(slugMap)) {
        const base = BLOG_URL_BASE[locale];
        if (!base) continue;
        const url = `${base}${slug}/`;
        const present = locale === 'it' ? locUrls.has(url) : hreflangUrls.get(locale)?.has(url);
        if (!present) missing.push(`${articleId} [${locale}]: ${url}`);
      }
    }

    expect(
      missing,
      `BLOG_SLUGS entries missing from sitemap-blog.xml (${missing.length}):\n${missing.join('\n')}`,
    ).toHaveLength(0);
  });

  // Guard: every blog URL in sitemap-blog.xml must correspond to a current BLOG_SLUG.
  // Catches: old/pre-collision slug still in sitemap after rename in routerBlogData.ts.
  it('every blog URL in sitemap-blog.xml must correspond to a BLOG_SLUG', async () => {
    const { BLOG_SLUGS } = await import('../services/routerBlogData');
    const xml = readFileSync(path.resolve(__dirname, '..', 'public', 'sitemap-blog.xml'), 'utf-8');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
    const validSlugs = buildValidSlugSets(BLOG_SLUGS as Record<string, Record<string, string>>);

    const stale: string[] = [];

    for (const url of locUrls) {
      const match = url.match(BLOG_LOC_PATTERNS.it);
      if (match && !validSlugs.it.has(match[1])) stale.push(`[it] <loc>: ${url}`);
    }

    for (const [locale, urls] of hreflangUrls) {
      const pattern = BLOG_LOC_PATTERNS[locale];
      if (!pattern) continue;
      for (const url of urls) {
        const match = url.match(pattern);
        if (match && !validSlugs[locale]?.has(match[1])) {
          stale.push(`[${locale}] hreflang href: ${url}`);
        }
      }
    }

    expect(
      stale,
      `sitemap-blog.xml URLs not in BLOG_SLUGS — stale after de-collision? (${stale.length}):\n${stale.join('\n')}`,
    ).toHaveLength(0);
  });

  // Guard: every blog URL in sitemap-news.xml must correspond to a current BLOG_SLUG.
  // sitemap-news.xml is a subset — not all articles are there, but every entry must be valid.
  it('every blog URL in sitemap-news.xml must correspond to a BLOG_SLUG', async () => {
    const { BLOG_SLUGS } = await import('../services/routerBlogData');
    const xml = readFileSync(path.resolve(__dirname, '..', 'public', 'sitemap-news.xml'), 'utf-8');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
    const validSlugs = buildValidSlugSets(BLOG_SLUGS as Record<string, Record<string, string>>);

    const stale: string[] = [];

    for (const url of locUrls) {
      const match = url.match(BLOG_LOC_PATTERNS.it);
      if (match && !validSlugs.it.has(match[1])) stale.push(`[it] <loc>: ${url}`);
    }

    for (const [locale, urls] of hreflangUrls) {
      const pattern = BLOG_LOC_PATTERNS[locale];
      if (!pattern) continue;
      for (const url of urls) {
        const match = url.match(pattern);
        if (match && !validSlugs[locale]?.has(match[1])) {
          stale.push(`[${locale}] hreflang href: ${url}`);
        }
      }
    }

    expect(
      stale,
      `sitemap-news.xml URLs not in BLOG_SLUGS — stale after de-collision? (${stale.length}):\n${stale.join('\n')}`,
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
    const { loadSwissArticleCanonicalOverrides } = await import('../build-plugins/shared/swissArticleCanonicalOverrides');
    const xml = readFileSync(path.resolve(__dirname, '..', 'public', 'sitemap-blog-ch.xml'), 'utf-8');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);

    // Issue #3010 item 1 correction (2026-07-03): a canonical-overridden
    // article's <url> block is intentionally DROPPED from sitemap-blog-ch.xml
    // (same convention as data/job-canonical-overrides.json for jobs) — its
    // own IT slug is a key in the override map. Excluded here, asserted
    // ABSENT in the dedicated test below instead.
    const overrides = loadSwissArticleCanonicalOverrides({ readFileSync }, path.resolve(__dirname, '..', 'data', 'swiss-article-canonical-overrides.json'));

    const missing: string[] = [];
    for (const [articleId, slugMap] of Object.entries(SWISS_SLUGS as Record<string, Record<string, string>>)) {
      const itSlug = (slugMap as Record<string, string>).it;
      if (itSlug && Object.prototype.hasOwnProperty.call(overrides, itSlug)) continue; // shadowed, dropped on purpose
      for (const [locale, slug] of Object.entries(slugMap)) {
        const base = SWISS_URL_BASE[locale];
        if (!base) continue;
        const url = `${base}${slug}/`;
        const present = locale === 'it' ? locUrls.has(url) : hreflangUrls.get(locale)?.has(url);
        if (!present) missing.push(`${articleId} [${locale}]: ${url}`);
      }
    }

    expect(
      missing,
      `SWISS_SLUGS entries missing from sitemap-blog-ch.xml (${missing.length}):\n${missing.join('\n')}`,
    ).toHaveLength(0);
  });

  it('every shadowed (canonical-overridden) SWISS_SLUG is ABSENT from sitemap-blog-ch.xml', async () => {
    const { SWISS_SLUGS } = await import('../services/routerSwissData');
    const { loadSwissArticleCanonicalOverrides } = await import('../build-plugins/shared/swissArticleCanonicalOverrides');
    const xml = readFileSync(path.resolve(__dirname, '..', 'public', 'sitemap-blog-ch.xml'), 'utf-8');
    const { locUrls } = extractSitemapUrls(xml);
    const overrides = loadSwissArticleCanonicalOverrides({ readFileSync }, path.resolve(__dirname, '..', 'data', 'swiss-article-canonical-overrides.json'));

    const stillPresent: string[] = [];
    for (const [articleId, slugMap] of Object.entries(SWISS_SLUGS as Record<string, Record<string, string>>)) {
      const itSlug = (slugMap as Record<string, string>).it;
      if (!itSlug || !Object.prototype.hasOwnProperty.call(overrides, itSlug)) continue;
      const url = `${SWISS_URL_BASE.it}${itSlug}/`;
      if (locUrls.has(url)) stillPresent.push(`${articleId} [it]: ${url}`);
    }

    expect(
      stillPresent,
      `Canonical-overridden SWISS_SLUGS still listed in sitemap-blog-ch.xml — violates self-canonical gate (${stillPresent.length}):\n${stillPresent.join('\n')}`,
    ).toHaveLength(0);
  });

  // Guard: every swiss URL in sitemap-blog-ch.xml must correspond to a current SWISS_SLUG.
  it('every swiss URL in sitemap-blog-ch.xml must correspond to a SWISS_SLUG', async () => {
    const { SWISS_SLUGS } = await import('../services/routerSwissData');
    const xml = readFileSync(path.resolve(__dirname, '..', 'public', 'sitemap-blog-ch.xml'), 'utf-8');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
    const validSlugs = buildValidSlugSets(SWISS_SLUGS as Record<string, Record<string, string>>);

    const stale: string[] = [];

    for (const url of locUrls) {
      const match = url.match(SWISS_LOC_PATTERNS.it);
      if (match && !validSlugs.it.has(match[1])) stale.push(`[it] <loc>: ${url}`);
    }

    for (const [locale, urls] of hreflangUrls) {
      const pattern = SWISS_LOC_PATTERNS[locale];
      if (!pattern) continue;
      for (const url of urls) {
        const match = url.match(pattern);
        if (match && !validSlugs[locale]?.has(match[1])) {
          stale.push(`[${locale}] hreflang href: ${url}`);
        }
      }
    }

    expect(
      stale,
      `sitemap-blog-ch.xml URLs not in SWISS_SLUGS — stale after de-collision? (${stale.length}):\n${stale.join('\n')}`,
    ).toHaveLength(0);
  });

  // The exact gate that would have caught #3116: sitemap-news.xml is SHARED
  // across the frontaliere and svizzera sections. A swiss <url> block whose
  // hreflang alternates were built from a stale or wrong-registry slug (e.g.
  // read from routerBlogData instead of routerSwissData) shows up here as a
  // URL under the swiss hub shape that no current SWISS_SLUG resolves to.
  it('every swiss URL in sitemap-news.xml must correspond to a current SWISS_SLUG', async () => {
    const { SWISS_SLUGS } = await import('../services/routerSwissData');
    const xml = readFileSync(path.resolve(__dirname, '..', 'public', 'sitemap-news.xml'), 'utf-8');
    const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
    const validSlugs = buildValidSlugSets(SWISS_SLUGS as Record<string, Record<string, string>>);

    const stale: string[] = [];

    for (const url of locUrls) {
      const match = url.match(SWISS_LOC_PATTERNS.it);
      if (match && !validSlugs.it.has(match[1])) stale.push(`[it] <loc>: ${url}`);
    }

    for (const [locale, urls] of hreflangUrls) {
      const pattern = SWISS_LOC_PATTERNS[locale];
      if (!pattern) continue;
      for (const url of urls) {
        const match = url.match(pattern);
        if (match && !validSlugs[locale]?.has(match[1])) {
          stale.push(`[${locale}] hreflang href: ${url}`);
        }
      }
    }

    expect(
      stale,
      `sitemap-news.xml URLs not in SWISS_SLUGS — stale after de-collision? (${stale.length}):\n${stale.join('\n')}`,
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
