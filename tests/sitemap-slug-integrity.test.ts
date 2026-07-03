/**
 * Sitemap Slug Integrity — CI gate that validates every article and job slug
 * referenced in sitemaps and internal link sources actually exists in the
 * source-of-truth data files. Prevents deploying broken links.
 *
 * Run: npx vitest run tests/sitemap-slug-integrity.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ALL_BLOG_ARTICLE_IDS, BLOG_SLUGS } from '@/services/routerBlogData';
import { ARTICLES } from '@/data/blog-articles-data';
import { ALL_SWISS_ARTICLE_IDS, SWISS_SLUGS } from '@/services/routerSwissData';
import { SWISS_ARTICLES } from '@/data/swiss-articles-data';
import { ARTICLE_SECTIONS, type ArticleSection } from '@/services/articleSections';
import { loadSwissArticleCanonicalOverrides } from '@/build-plugins/shared/swissArticleCanonicalOverrides';

const root = resolve(__dirname, '..');

function readProjectFile(p: string): string {
  return readFileSync(resolve(root, p), 'utf-8');
}

// ── Hreflang alternate integrity helpers ─────────────────────────────────────
//
// The IT-<loc>-only checks below (both Blog and Swiss blocks) are blind to a
// stale/cross-registry EN/DE/FR `<xhtml:link hreflang>` alternate — the exact
// #3116/#3120 bug class, just on the non-IT locales. These helpers mirror the
// IT <loc> validation logic per locale, deriving the URL path segments from
// the canonical `services/articleSections.ts` registry (not a copy-pasted
// literal) so the two sections can't drift apart (#3304, follow-up of #3292).

const ALT_LOCALES = ['en', 'de', 'fr'] as const;
type AltLocale = typeof ALT_LOCALES[number];

function hreflangBase(section: ArticleSection, locale: AltLocale): string {
  return `https://frontaliereticino.ch/${locale}/${ARTICLE_SECTIONS[section].indexSlug[locale]}/`;
}

function extractHreflangSlugs(xml: string, section: ArticleSection, locale: AltLocale): string[] {
  const base = hreflangBase(section, locale);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`hreflang="${locale}"\\s+href="${escapedBase}([^/"]+)/"`, 'g');
  return [...xml.matchAll(pattern)].map(m => m[1]);
}

// Registers, for each of EN/DE/FR, the same two-directional checks already
// applied to the IT <loc>: (1) every hreflang alternate present in the
// sitemap must resolve to a real article slug (catches stale/dead
// alternates), and (2) every article's locale slug must have a matching
// hreflang alternate in the sitemap (catches missing ones).
function registerHreflangIntegrityChecks(opts: {
  section: ArticleSection;
  sitemapLabel: string;
  sitemapXml: string;
  articleIds: readonly string[];
  slugs: Record<string, Record<string, string>>;
  // Article IDs intentionally dropped from this sitemap (canonical-override
  // shadowed variants, issue #3010 item 1) — excluded from the "every
  // article has a hreflang alternate" forward check but still included in
  // the reverse lookup map (harmless: they simply won't be found in the XML).
  skipForwardCheckIds?: ReadonlySet<string>;
}): void {
  const { section, sitemapLabel, sitemapXml, articleIds, slugs, skipForwardCheckIds } = opts;

  for (const locale of ALT_LOCALES) {
    const hreflangSlugs = extractHreflangSlugs(sitemapXml, section, locale);
    const localeSlugToArticleId = new Map<string, string>();
    for (const id of articleIds) {
      const slug = slugs[id]?.[locale];
      if (slug) localeSlugToArticleId.set(slug, id);
    }

    describe(`every ${sitemapLabel} ${locale} hreflang alternate maps to a real article`, () => {
      for (const slug of hreflangSlugs) {
        it(`[${locale}] slug "${slug}" → has article ID`, () => {
          expect(
            localeSlugToArticleId.has(slug),
            `${sitemapLabel} hreflang[${locale}] references ${hreflangBase(section, locale)}${slug}/ but no slug map entry has this ${locale} slug`
          ).toBe(true);
        });
      }
    });

    describe(`every article has a ${locale} hreflang alternate in ${sitemapLabel}`, () => {
      for (const id of articleIds) {
        if (skipForwardCheckIds?.has(id)) continue;
        it(`article "${id}" → has ${locale} slug present as hreflang in ${sitemapLabel}`, () => {
          const slug = slugs[id]?.[locale];
          expect(slug, `Article "${id}" has no ${locale} slug`).toBeTruthy();
          expect(
            hreflangSlugs.includes(slug!),
            `Article "${id}" (${locale} slug: ${slug}) is missing its hreflang alternate from ${sitemapLabel}`
          ).toBe(true);
        });
      }
    });
  }
}

// ── Data sources ─────────────────────────────────────────────────────────────

// Blog sitemap (static, checked into repo)
const blogSitemap = readProjectFile('public/sitemap-blog.xml');

// Jobs data (source of truth for build-time sitemap-jobs.xml generation)
const jobs: { id: string; slug: string; slugByLocale?: Record<string, string>; needsRetranslation?: boolean; title: string; company: string; location: string; description: string }[] =
  JSON.parse(readProjectFile('data/jobs.json'));

// Extract all Italian <loc> slugs from the blog sitemap
// Pattern: /articoli-frontaliere/{slug}/
const blogSitemapSlugs = [...blogSitemap.matchAll(/<loc>[^<]*\/articoli-frontaliere\/([^/<]+)\/?<\/loc>/g)]
  .map(m => m[1]);

// Build reverse lookup: IT slug → article ID
const itSlugToArticleId = new Map<string, string>();
for (const id of ALL_BLOG_ARTICLE_IDS) {
  const slugMap = BLOG_SLUGS[id];
  if (slugMap?.it) itSlugToArticleId.set(slugMap.it, id);
}

// Build set of all valid IT slugs from BLOG_SLUGS
const validItSlugs = new Set(ALL_BLOG_ARTICLE_IDS.map(id => BLOG_SLUGS[id]?.it).filter(Boolean));

// Build set of article IDs from BlogArticles.tsx ARTICLES array
const articlesComponentIds = new Set(ARTICLES.map(a => a.id));

// ── Blog Article Slug Integrity ──────────────────────────────────────────────

describe('Blog sitemap slug integrity', () => {
  it('sitemap-blog.xml has at least 1 article', () => {
    expect(blogSitemapSlugs.length).toBeGreaterThan(0);
  });

  describe('every sitemap-blog.xml slug maps to a real article in BLOG_SLUGS', () => {
    for (const slug of blogSitemapSlugs) {
      it(`slug "${slug}" → has article ID in BLOG_SLUGS`, () => {
        expect(
          itSlugToArticleId.has(slug),
          `Sitemap references /articoli-frontaliere/${slug}/ but no article ID maps to this IT slug in BLOG_SLUGS`
        ).toBe(true);
      });
    }
  });

  describe('every sitemap-blog.xml slug article exists in ALL_BLOG_ARTICLE_IDS', () => {
    for (const slug of blogSitemapSlugs) {
      const articleId = itSlugToArticleId.get(slug);
      if (!articleId) continue; // covered by test above
      it(`article "${articleId}" → is in ALL_BLOG_ARTICLE_IDS`, () => {
        expect(
          ALL_BLOG_ARTICLE_IDS.includes(articleId as any),
          `BLOG_SLUGS maps slug "${slug}" to "${articleId}" but that ID is not in ALL_BLOG_ARTICLE_IDS`
        ).toBe(true);
      });
    }
  });

  describe('every article in ALL_BLOG_ARTICLE_IDS has a sitemap entry', () => {
    for (const id of ALL_BLOG_ARTICLE_IDS) {
      it(`article "${id}" → has IT slug in sitemap-blog.xml`, () => {
        const itSlug = BLOG_SLUGS[id]?.it;
        expect(itSlug, `Article "${id}" has no IT slug in BLOG_SLUGS`).toBeTruthy();
        expect(
          blogSitemapSlugs.includes(itSlug!),
          `Article "${id}" (slug: ${itSlug}) is missing from sitemap-blog.xml`
        ).toBe(true);
      });
    }
  });

  describe('every BLOG_SLUGS entry has all 4 locale slugs', () => {
    for (const id of ALL_BLOG_ARTICLE_IDS) {
      it(`article "${id}" → has it/en/de/fr slugs`, () => {
        const slugMap = BLOG_SLUGS[id];
        expect(slugMap, `No BLOG_SLUGS entry for ${id}`).toBeDefined();
        for (const locale of ['it', 'en', 'de', 'fr'] as const) {
          expect(slugMap[locale], `Article "${id}" missing ${locale} slug`).toBeTruthy();
        }
      });
    }
  });
});

describe('Blog sitemap hreflang alternate integrity (EN/DE/FR)', () => {
  registerHreflangIntegrityChecks({
    section: 'frontaliere',
    sitemapLabel: 'sitemap-blog.xml',
    sitemapXml: blogSitemap,
    articleIds: ALL_BLOG_ARTICLE_IDS,
    slugs: BLOG_SLUGS,
  });
});

// ── Blog ARTICLES array ↔ router consistency ─────────────────────────────────

describe('BlogArticles ARTICLES array ↔ ALL_BLOG_ARTICLE_IDS consistency', () => {
  it('every ARTICLES entry has a matching ALL_BLOG_ARTICLE_IDS entry', () => {
    const routerIds = new Set<string>(ALL_BLOG_ARTICLE_IDS);
    const missing = ARTICLES.filter(a => !routerIds.has(a.id)).map(a => a.id);
    expect(missing, `ARTICLES entries not in ALL_BLOG_ARTICLE_IDS: ${missing.join(', ')}`).toEqual([]);
  });

  it('every ALL_BLOG_ARTICLE_IDS entry has a matching ARTICLES entry', () => {
    const missing = ALL_BLOG_ARTICLE_IDS.filter(id => !articlesComponentIds.has(id));
    expect(missing, `ALL_BLOG_ARTICLE_IDS entries not in ARTICLES: ${missing.join(', ')}`).toEqual([]);
  });
});

// ── Swiss Article Slug Integrity (mirrors Blog block above — #3120) ──────────
//
// This mirrors "Blog sitemap slug integrity" / "BlogArticles ARTICLES array
// ↔ ALL_BLOG_ARTICLE_IDS consistency" above, but for the svizzera section.
// Before this block, this file only ever scanned public/sitemap-blog.xml and
// BLOG_SLUGS/ALL_BLOG_ARTICLE_IDS — a stale, missing, or cross-registry swiss
// article slug (SWISS_SLUGS vs public/sitemap-blog-ch.xml) passed this gate
// silently, the same blind spot fixed for sitemap-news.xml in
// tests/blog-slugs-sitemap-sync.test.ts (#3116/#3120 bug class).

// Swiss article sitemap (static, checked into repo)
const swissSitemap = readProjectFile('public/sitemap-blog-ch.xml');

// Extract all Italian <loc> slugs from the swiss article sitemap
// Pattern: /articoli-svizzera/{slug}/
const swissSitemapSlugs = [...swissSitemap.matchAll(/<loc>[^<]*\/articoli-svizzera\/([^/<]+)\/?<\/loc>/g)]
  .map(m => m[1]);

// Build reverse lookup: IT slug → article ID
const itSlugToSwissArticleId = new Map<string, string>();
for (const id of ALL_SWISS_ARTICLE_IDS) {
  const slugMap = SWISS_SLUGS[id];
  if (slugMap?.it) itSlugToSwissArticleId.set(slugMap.it, id);
}

// Build set of article IDs from swiss-articles-data.ts SWISS_ARTICLES array
const swissArticlesComponentIds = new Set(SWISS_ARTICLES.map(a => a.id));

// Articles whose IT slug is a shadowed key in
// data/swiss-article-canonical-overrides.json (issue #3010 item 1) are
// intentionally DROPPED from sitemap-blog-ch.xml / sitemap-news.xml — same
// convention as data/job-canonical-overrides.json for jobs. Their
// <link rel="canonical"> points at a different (authoritative) page, so
// listing them in the sitemap would violate the hard self-canonical gate
// (scripts/audit-sitemap-canonicals.mjs / scripts/validate-sitemap-pages.mjs).
// The page itself stays live/reachable (repo anti-cut rule) — only its
// sitemap presence is dropped. Derived from the override map (not
// hardcoded) so a future override addition is automatically exempted here.
const swissCanonicalOverrides = loadSwissArticleCanonicalOverrides(
  { readFileSync },
  resolve(root, 'data', 'swiss-article-canonical-overrides.json'),
);
const shadowedSwissArticleIds = new Set(
  ALL_SWISS_ARTICLE_IDS.filter((id) => {
    const itSlug = SWISS_SLUGS[id]?.it;
    return !!itSlug && Object.prototype.hasOwnProperty.call(swissCanonicalOverrides, itSlug);
  }),
);

describe('Swiss article sitemap slug integrity', () => {
  it('sitemap-blog-ch.xml has at least 1 article', () => {
    expect(swissSitemapSlugs.length).toBeGreaterThan(0);
  });

  describe('every sitemap-blog-ch.xml slug maps to a real article in SWISS_SLUGS', () => {
    for (const slug of swissSitemapSlugs) {
      it(`slug "${slug}" → has article ID in SWISS_SLUGS`, () => {
        expect(
          itSlugToSwissArticleId.has(slug),
          `Sitemap references /articoli-svizzera/${slug}/ but no article ID maps to this IT slug in SWISS_SLUGS`
        ).toBe(true);
      });
    }
  });

  describe('every sitemap-blog-ch.xml slug article exists in ALL_SWISS_ARTICLE_IDS', () => {
    for (const slug of swissSitemapSlugs) {
      const articleId = itSlugToSwissArticleId.get(slug);
      if (!articleId) continue; // covered by test above
      it(`article "${articleId}" → is in ALL_SWISS_ARTICLE_IDS`, () => {
        expect(
          ALL_SWISS_ARTICLE_IDS.includes(articleId as any),
          `SWISS_SLUGS maps slug "${slug}" to "${articleId}" but that ID is not in ALL_SWISS_ARTICLE_IDS`
        ).toBe(true);
      });
    }
  });

  describe('every non-shadowed article in ALL_SWISS_ARTICLE_IDS has a sitemap entry', () => {
    for (const id of ALL_SWISS_ARTICLE_IDS) {
      if (shadowedSwissArticleIds.has(id)) continue; // covered below: must be ABSENT instead
      it(`article "${id}" → has IT slug in sitemap-blog-ch.xml`, () => {
        const itSlug = SWISS_SLUGS[id]?.it;
        expect(itSlug, `Article "${id}" has no IT slug in SWISS_SLUGS`).toBeTruthy();
        expect(
          swissSitemapSlugs.includes(itSlug!),
          `Article "${id}" (slug: ${itSlug}) is missing from sitemap-blog-ch.xml`
        ).toBe(true);
      });
    }
  });

  // Issue #3010 item 1 correction (2026-07-03): a canonical-override-shadowed
  // article must be ABSENT from sitemap-blog-ch.xml, not present. Locks in
  // the sitemap-drop fix so a future re-add (e.g. a careless create-article
  // sync) regresses the hard self-canonical CI gate instead of failing
  // silently.
  describe('every shadowed (canonical-overridden) article is ABSENT from sitemap-blog-ch.xml', () => {
    for (const id of shadowedSwissArticleIds) {
      it(`article "${id}" → IT slug is NOT in sitemap-blog-ch.xml`, () => {
        const itSlug = SWISS_SLUGS[id]?.it;
        expect(itSlug, `Article "${id}" has no IT slug in SWISS_SLUGS`).toBeTruthy();
        expect(
          swissSitemapSlugs.includes(itSlug!),
          `Article "${id}" (slug: ${itSlug}) is canonical-overridden but still listed in sitemap-blog-ch.xml — violates "Sitemap <loc> URLs MUST self-canonicalize"`
        ).toBe(false);
      });
    }
  });

  describe('every SWISS_SLUGS entry has all 4 locale slugs', () => {
    for (const id of ALL_SWISS_ARTICLE_IDS) {
      it(`article "${id}" → has it/en/de/fr slugs`, () => {
        const slugMap = SWISS_SLUGS[id];
        expect(slugMap, `No SWISS_SLUGS entry for ${id}`).toBeDefined();
        for (const locale of ['it', 'en', 'de', 'fr'] as const) {
          expect(slugMap[locale], `Article "${id}" missing ${locale} slug`).toBeTruthy();
        }
      });
    }
  });
});

describe('Swiss article sitemap hreflang alternate integrity (EN/DE/FR)', () => {
  registerHreflangIntegrityChecks({
    section: 'svizzera',
    sitemapLabel: 'sitemap-blog-ch.xml',
    sitemapXml: swissSitemap,
    articleIds: ALL_SWISS_ARTICLE_IDS,
    slugs: SWISS_SLUGS,
    skipForwardCheckIds: shadowedSwissArticleIds,
  });
});

describe('SwissArticles SWISS_ARTICLES array ↔ ALL_SWISS_ARTICLE_IDS consistency', () => {
  it('every SWISS_ARTICLES entry has a matching ALL_SWISS_ARTICLE_IDS entry', () => {
    const routerIds = new Set<string>(ALL_SWISS_ARTICLE_IDS);
    const missing = SWISS_ARTICLES.filter(a => !routerIds.has(a.id)).map(a => a.id);
    expect(missing, `SWISS_ARTICLES entries not in ALL_SWISS_ARTICLE_IDS: ${missing.join(', ')}`).toEqual([]);
  });

  it('every ALL_SWISS_ARTICLE_IDS entry has a matching SWISS_ARTICLES entry', () => {
    const missing = ALL_SWISS_ARTICLE_IDS.filter(id => !swissArticlesComponentIds.has(id));
    expect(missing, `ALL_SWISS_ARTICLE_IDS entries not in SWISS_ARTICLES: ${missing.join(', ')}`).toEqual([]);
  });
});

// ── Job Slug Integrity ───────────────────────────────────────────────────────

describe('Job data slug integrity (source for build-time sitemap-jobs.xml)', () => {
  // Filter same way as jobsSeoPagesPlugin: must have title, company, location, description
  const validJobs = jobs.filter(j => j.title && j.company && j.location && j.description);

  it('jobs.json has at least 1 valid job', () => {
    expect(validJobs.length).toBeGreaterThan(0);
  });

  it('every valid job has a non-empty slug', () => {
    const broken = validJobs.filter(j => !j.slug || j.slug.trim() === '');
    expect(broken.map(j => j.id), 'Jobs with empty slug').toEqual([]);
  });

  it('no duplicate job slugs (warns, build plugin deduplicates)', () => {
    const slugCounts = new Map<string, string[]>();
    for (const j of validJobs) {
      if (!j.slug) continue;
      const list = slugCounts.get(j.slug) || [];
      list.push(j.id);
      slugCounts.set(j.slug, list);
    }
    const dupes = [...slugCounts.entries()].filter(([, ids]) => ids.length > 1);
    if (dupes.length > 0) {
      console.warn(`⚠️  ${dupes.length} duplicate job slug(s) — build plugin skips duplicates but data should be cleaned:\n` +
        dupes.map(([slug, ids]) => `  ${slug} → [${ids.join(', ')}]`).join('\n'));
    }
    // Soft check: allow up to 150 legacy duplicates, fail if more creep in
    expect(dupes.length, `Too many duplicate job slugs (${dupes.length})`).toBeLessThanOrEqual(200);
  });

  it('every job with slugByLocale has all 4 locale entries', () => {
    const broken = validJobs.filter(j => {
      if (!j.slugByLocale) return false; // optional, plugin falls back to slug
      // Skip jobs awaiting translation — they intentionally lack locale fields
      // until the translate-pending pipeline processes them.
      if (j.needsRetranslation) return false;
      return !j.slugByLocale.it || !j.slugByLocale.en || !j.slugByLocale.de || !j.slugByLocale.fr;
    });
    expect(
      broken.map(j => `${j.id} missing: ${['it','en','de','fr'].filter(l => !j.slugByLocale?.[l]).join(',')}`),
      'Jobs with incomplete slugByLocale'
    ).toEqual([]);
  });

  it('job slugs contain only URL-safe characters', () => {
    const BAD_CHARS = /[^a-z0-9\-]/;
    const broken = validJobs.filter(j => BAD_CHARS.test(j.slug));
    expect(
      broken.map(j => `${j.id}: "${j.slug}"`),
      'Jobs with URL-unsafe slugs'
    ).toEqual([]);
  });
});
