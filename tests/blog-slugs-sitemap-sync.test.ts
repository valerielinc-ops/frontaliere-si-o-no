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
