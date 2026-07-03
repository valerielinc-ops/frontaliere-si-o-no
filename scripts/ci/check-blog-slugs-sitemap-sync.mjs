#!/usr/bin/env node
// Zero-Claude check: validates BLOG_SLUGS ↔ sitemap-blog.xml / sitemap-news.xml
// AND SWISS_SLUGS ↔ sitemap-blog-ch.xml / sitemap-news.xml sync.
// Usage: node scripts/ci/check-blog-slugs-sitemap-sync.mjs
// Exit 0 = in sync. Exit 1 = divergence detected.
//
// sitemap-blog.xml / sitemap-blog-ch.xml structure:
//   <loc> = Italian canonical URL only (one per article)
//   <xhtml:link hreflang="en|de|fr" href="..."> = other locale URLs
// Both are checked bidirectionally against the section's slug registry.
//
// sitemap-news.xml is SHARED across both sections — checked backward only
// (sitemap → registry), once per registry. This is the gate that catches a
// swiss article whose hreflang alternates were resolved from the wrong
// registry (routerBlogData instead of routerSwissData), the class of bug
// fixed manually in PR #3116 (#3120 follow-up hardening).
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

const SWISS_URL_BASE = {
  it: 'https://frontaliereticino.ch/articoli-svizzera/',
  en: 'https://frontaliereticino.ch/en/swiss-articles/',
  de: 'https://frontaliereticino.ch/de/schweiz-artikel/',
  fr: 'https://frontaliereticino.ch/fr/articles-suisse/',
};

const SWISS_LOC_PATTERNS = {
  it: /^https:\/\/frontaliereticino\.ch\/articoli-svizzera\/([^/]+)\/$/,
  en: /^https:\/\/frontaliereticino\.ch\/en\/swiss-articles\/([^/]+)\/$/,
  de: /^https:\/\/frontaliereticino\.ch\/de\/schweiz-artikel\/([^/]+)\/$/,
  fr: /^https:\/\/frontaliereticino\.ch\/fr\/articles-suisse\/([^/]+)\/$/,
};

// Uses the same regex as ogPagesPlugin.ts (single source of truth for parsing).
function parseSlugsConst(file, constName) {
  const src = readFileSync(resolve(root, file), 'utf-8');
  const block = src.match(new RegExp(`const ${constName}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
  const rx = /["']([^"']+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
  const slugs = {};
  let m;
  while ((m = rx.exec(block)) !== null) {
    slugs[m[1]] = { it: m[2], en: m[3], de: m[4], fr: m[5] };
  }
  return slugs;
}

function parseBlogSlugs() {
  return parseSlugsConst('services/routerBlogData.ts', 'BLOG_SLUGS');
}

function parseSwissSlugs() {
  return parseSlugsConst('services/routerSwissData.ts', 'SWISS_SLUGS');
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

// registryLabel is used only in log/error messages (e.g. "BLOG_SLUGS" / "SWISS_SLUGS").
// shadowedArticleIds (optional Set): article IDs intentionally DROPPED from
// this sitemap because their IT slug is a canonical-override key (issue
// #3010 item 1, data/swiss-article-canonical-overrides.json) — same
// convention as data/job-canonical-overrides.json for jobs. A sitemap <loc>
// whose own page canonicalizes elsewhere is a hard CI gate failure
// (audit-sitemap-canonicals.mjs / validate-sitemap-pages.mjs), so these
// articles are excluded from the forward "must be present" check.
function checkSitemap(label, xml, slugs, urlBase, locPatterns, registryLabel, shadowedArticleIds = new Set()) {
  const { locUrls, hreflangUrls } = extractSitemapUrls(xml);
  const validSlugs = buildValidSlugSets(slugs);
  let ok = true;

  // Forward: every non-shadowed registry slug must be in the sitemap
  const missing = [];
  for (const [articleId, slugMap] of Object.entries(slugs)) {
    if (shadowedArticleIds.has(articleId)) continue;
    for (const [locale, slug] of Object.entries(slugMap)) {
      const base = urlBase[locale];
      if (!base) continue;
      const url = `${base}${slug}/`;
      const present = locale === 'it' ? locUrls.has(url) : hreflangUrls.get(locale)?.has(url);
      if (!present) missing.push(`  ${articleId} [${locale}]: ${url}`);
    }
  }
  if (missing.length) {
    console.error(`\n❌ ${label}: ${registryLabel} entries missing (${missing.length}):`);
    missing.forEach(l => console.error(l));
    ok = false;
  } else {
    console.log(`✅ ${label}: all ${registryLabel} present`);
  }

  // Backward: every URL of this registry's hub shape in the sitemap must
  // correspond to a current registry slug.
  const stale = checkNewsStale(locUrls, hreflangUrls, validSlugs, locPatterns);
  if (stale.length) {
    console.error(`\n❌ ${label}: stale URLs not in ${registryLabel} (${stale.length}):`);
    stale.forEach(l => console.error(l));
    ok = false;
  } else {
    console.log(`✅ ${label}: no stale URLs`);
  }

  return ok;
}

// Backward-only check (sitemap → registry). Shared by the per-section
// sitemap check above and the shared sitemap-news.xml check below — a swiss
// article whose hreflang alternates resolve to the WRONG registry (or a
// stale slug after rename) shows up here as an unmatched URL under that
// registry's hub shape (#3120: catches the class of bug behind PR #3116's
// 3 dead sitemap-news.xml URLs).
function checkNewsStale(locUrls, hreflangUrls, validSlugs, locPatterns) {
  const stale = [];
  for (const url of locUrls) {
    const match = url.match(locPatterns.it);
    if (match && !validSlugs.it.has(match[1])) stale.push(`  [it] <loc>: ${url}`);
  }
  for (const [locale, urls] of hreflangUrls) {
    const pattern = locPatterns[locale];
    if (!pattern) continue;
    for (const url of urls) {
      const match = url.match(pattern);
      if (match && !validSlugs[locale]?.has(match[1])) {
        stale.push(`  [${locale}] hreflang href: ${url}`);
      }
    }
  }
  return stale;
}

const blogSlugs = parseBlogSlugs();
console.log(`Parsed ${Object.keys(blogSlugs).length} articles from services/routerBlogData.ts`);
const swissSlugs = parseSwissSlugs();
console.log(`Parsed ${Object.keys(swissSlugs).length} articles from services/routerSwissData.ts`);

// Issue #3010 item 1 (data/swiss-article-canonical-overrides.json): shadowed
// article IDs whose IT slug is a canonical-override key are intentionally
// dropped from sitemap-blog-ch.xml (same convention as
// data/job-canonical-overrides.json for jobs) — excluded from the forward
// "must be present" check below.
let swissShadowedArticleIds = new Set();
try {
  const overridesRaw = JSON.parse(readFileSync(resolve(root, 'data/swiss-article-canonical-overrides.json'), 'utf-8'));
  const overrideMap = overridesRaw?.overrides && typeof overridesRaw.overrides === 'object' ? overridesRaw.overrides : {};
  for (const [articleId, slugMap] of Object.entries(swissSlugs)) {
    if (slugMap?.it && Object.prototype.hasOwnProperty.call(overrideMap, slugMap.it)) {
      swissShadowedArticleIds.add(articleId);
    }
  }
} catch {
  // Missing/malformed override file: safe default, no articles exempted.
}

let exitCode = 0;

const blogXml = readFileSync(resolve(root, 'public/sitemap-blog.xml'), 'utf-8');
if (!checkSitemap('sitemap-blog.xml', blogXml, blogSlugs, BLOG_URL_BASE, BLOG_LOC_PATTERNS, 'BLOG_SLUGS')) exitCode = 1;

const swissXml = readFileSync(resolve(root, 'public/sitemap-blog-ch.xml'), 'utf-8');
if (!checkSitemap('sitemap-blog-ch.xml', swissXml, swissSlugs, SWISS_URL_BASE, SWISS_LOC_PATTERNS, 'SWISS_SLUGS', swissShadowedArticleIds)) exitCode = 1;

// sitemap-news.xml is SHARED across both sections — checked backward only,
// once per registry, against that registry's own hub URL shape.
const newsXml = readFileSync(resolve(root, 'public/sitemap-news.xml'), 'utf-8');
const { locUrls: newsLoc, hreflangUrls: newsHref } = extractSitemapUrls(newsXml);

const blogNewsStale = checkNewsStale(newsLoc, newsHref, buildValidSlugSets(blogSlugs), BLOG_LOC_PATTERNS);
if (blogNewsStale.length) {
  console.error(`\n❌ sitemap-news.xml: stale URLs not in BLOG_SLUGS (${blogNewsStale.length}):`);
  blogNewsStale.forEach(l => console.error(l));
  exitCode = 1;
} else {
  console.log(`✅ sitemap-news.xml: no stale BLOG_SLUGS URLs`);
}

const swissNewsStale = checkNewsStale(newsLoc, newsHref, buildValidSlugSets(swissSlugs), SWISS_LOC_PATTERNS);
if (swissNewsStale.length) {
  console.error(`\n❌ sitemap-news.xml: stale URLs not in SWISS_SLUGS (${swissNewsStale.length}):`);
  swissNewsStale.forEach(l => console.error(l));
  exitCode = 1;
} else {
  console.log(`✅ sitemap-news.xml: no stale SWISS_SLUGS URLs`);
}

if (exitCode === 0) {
  console.log('\n✅ BLOG_SLUGS + SWISS_SLUGS ↔ sitemap sync OK');
} else {
  console.error('\n❌ registry ↔ sitemap DIVERGENCE — fix routerBlogData.ts/routerSwissData.ts or regenerate sitemaps');
}
process.exit(exitCode);
