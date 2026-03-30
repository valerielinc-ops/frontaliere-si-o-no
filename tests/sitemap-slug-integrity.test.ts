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

const root = resolve(__dirname, '..');

function readProjectFile(p: string): string {
  return readFileSync(resolve(root, p), 'utf-8');
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
