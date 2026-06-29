#!/usr/bin/env node
// Zero-Claude check: validates BLOG_SLUGS ↔ sitemap-blog.xml / sitemap-news.xml sync.
// Usage: node scripts/ci/check-blog-slugs-sitemap-sync.mjs
// Exit 0 = in sync. Exit 1 = divergence detected.
//
// sitemap-blog.xml structure:
//   <loc> = Italian canonical URL only (one per article)
//   <xhtml:link hreflang="en|de|fr" href="..."> = other locale URLs
// Both are checked bidirectionally against BLOG_SLUGS.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

const BLOG_URL_BASE = {
  it: 'https://frontaliereticino.ch/articoli-frontaliere/',
  en: 'https://frontaliereticino.ch/en/cross-border-articles/',
  de: 'https://frontaliereticino.ch/de/grenzgaenger-artikel/',
  fr: 'https://frontaliereticino.ch/fr/articles-frontalier/',
};

const BLOG_LOC_PATTERNS = {
  it: /^https:\/\/frontaliereticino\.ch\/articoli-frontaliere\/([^/]+)\/$/,
  en: /^https:\/\/frontaliereticino\.ch\/en\/cross-border-articles\/([^/]+)\/$/,
  de: /^https:\/\/frontaliereticino\.ch\/de\/grenzgaenger-artikel\/([^/]+)\/$/,
  fr: /^https:\/\/frontaliereticino\.ch\/fr\/articles-frontalier\/([^/]+)\/$/,
};

// Uses the same regex as ogPagesPlugin.ts (single source of truth for parsing).
function parseBlogSlugs() {
  const src = readFileSync(resolve(root, 'services/routerBlogData.ts'), 'utf-8');
  const block = src.match(/const BLOG_SLUGS[\s\S]*?\n\};/m)?.[0] ?? '';
  const rx = /["']([^"']+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
  const slugs = {};
  let m;
  while ((m = rx.exec(block)) !== null) {
    slugs[m[1]] = { it: m[2], en: m[3], de: m[4], fr: m[5] };
  }
  return slugs;
}

function extractSitemapUrls(xml) {
  const locUrls = new Set(
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim()),
  );
  const hreflangUrls = new Map([
    ['it', new Set()], ['en', new Set()], ['de', new Set()], ['fr', new Set()],
  ]);
  for (const m of xml.matchAll(/hreflang="(it|en|de|fr)"\s+href="([^"]+)"/g)) {
    hreflangUrls.get(m[1])?.add(m[2].trim());
  }
  return { locUrls, hreflangUrls };
}

function buildValidSlugSets(slugs) {
  const sets = { it: new Set(), en: new Set(), de: new Set(), fr: new Set() };
  for (const slugMap of Object.values(slugs)) {
    for (const [locale, slug] of Object.entries(slugMap)) {
      sets[locale]?.add(slug);
    }
  }
  return sets;
}

function checkSitemap(label, xml, blogSlugs) {
  const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
  const validSlugs = buildValidSlugSets(blogSlugs);
  let ok = true;

  // Forward: every BLOG_SLUG must be in the sitemap
  const missing = [];
  for (const [articleId, slugMap] of Object.entries(blogSlugs)) {
    for (const [locale, slug] of Object.entries(slugMap)) {
      const base = BLOG_URL_BASE[locale];
      if (!base) continue;
      const url = `${base}${slug}/`;
      const present = locale === 'it' ? locUrls.has(url) : hreflangUrls.get(locale)?.has(url);
      if (!present) missing.push(`  ${articleId} [${locale}]: ${url}`);
    }
  }
  if (missing.length) {
    console.error(`\n❌ ${label}: BLOG_SLUGS entries missing (${missing.length}):`);
    missing.forEach(l => console.error(l));
    ok = false;
  } else {
    console.log(`✅ ${label}: all BLOG_SLUGS present`);
  }

  // Backward: every blog URL in sitemap must correspond to a current BLOG_SLUG
  const stale = [];
  for (const url of locUrls) {
    const match = url.match(BLOG_LOC_PATTERNS.it);
    if (match && !validSlugs.it.has(match[1])) stale.push(`  [it] <loc>: ${url}`);
  }
  for (const [locale, urls] of hreflangUrls) {
    const pattern = BLOG_LOC_PATTERNS[locale];
    if (!pattern) continue;
    for (const url of urls) {
      const match = url.match(pattern);
      if (match && !validSlugs[locale]?.has(match[1])) {
        stale.push(`  [${locale}] hreflang href: ${url}`);
      }
    }
  }
  if (stale.length) {
    console.error(`\n❌ ${label}: stale URLs not in BLOG_SLUGS (${stale.length}):`);
    stale.forEach(l => console.error(l));
    ok = false;
  } else {
    console.log(`✅ ${label}: no stale URLs`);
  }

  return ok;
}

const blogSlugs = parseBlogSlugs();
console.log(`Parsed ${Object.keys(blogSlugs).length} articles from services/routerBlogData.ts`);

let exitCode = 0;

const blogXml = readFileSync(resolve(root, 'public/sitemap-blog.xml'), 'utf-8');
if (!checkSitemap('sitemap-blog.xml', blogXml, blogSlugs)) exitCode = 1;

const newsXml = readFileSync(resolve(root, 'public/sitemap-news.xml'), 'utf-8');
// News sitemap is a subset: only check backward (sitemap → BLOG_SLUGS)
const { locUrls: newsLoc, hreflangUrls: newsHref } = extractSitemapUrls(newsXml);
const validSlugs = buildValidSlugSets(blogSlugs);
const newsStale = [];
for (const url of newsLoc) {
  const match = url.match(BLOG_LOC_PATTERNS.it);
  if (match && !validSlugs.it.has(match[1])) newsStale.push(`  [it] <loc>: ${url}`);
}
for (const [locale, urls] of newsHref) {
  const pattern = BLOG_LOC_PATTERNS[locale];
  if (!pattern) continue;
  for (const url of urls) {
    const match = url.match(pattern);
    if (match && !validSlugs[locale]?.has(match[1])) {
      newsStale.push(`  [${locale}] hreflang href: ${url}`);
    }
  }
}
if (newsStale.length) {
  console.error(`\n❌ sitemap-news.xml: stale URLs not in BLOG_SLUGS (${newsStale.length}):`);
  newsStale.forEach(l => console.error(l));
  exitCode = 1;
} else {
  console.log(`✅ sitemap-news.xml: no stale URLs`);
}

if (exitCode === 0) {
  console.log('\n✅ BLOG_SLUGS ↔ sitemap sync OK');
} else {
  console.error('\n❌ BLOG_SLUGS ↔ sitemap DIVERGENCE — fix routerBlogData.ts or regenerate sitemaps');
}
process.exit(exitCode);
