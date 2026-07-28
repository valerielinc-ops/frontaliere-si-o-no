#!/usr/bin/env node
/**
 * Generate RSS 2.0 feeds for Google Publisher Center sections.
 *
 * Two article sections, each with its own data sources and per-locale feeds:
 *   • frontaliere — cross-border (Ticino) articles
 *       seo:   services/seo/seo-blog.ts + seo-blog-2.ts
 *       slugs: services/routerBlogData.ts
 *       meta:  services/locales/blog-meta-{locale}.ts
 *       body:  services/locales/blog-body/{locale}/*.ts
 *       out:   rss.xml, rss-{locale}.xml
 *   • svizzera — national (Switzerland-wide) articles
 *       seo:   services/seo/seo-blog-ch.ts
 *       slugs: services/routerSwissData.ts (SWISS_SLUGS)
 *       meta:  services/locales/blog-meta-ch-{locale}.ts
 *       body:  services/locales/blog-body-ch/{locale}/*.ts
 *       out:   rss-svizzera.xml, rss-svizzera-{locale}.xml
 *
 * The svizzera section mirrors the frontaliere pipeline so the actively-fed
 * national articles (`create-article.mjs --section=svizzera`) are syndicated to
 * RSS readers / aggregators instead of being silently excluded (Refs #1226).
 *
 * The generated feeds are committed seeds maintained by the article-gen
 * workflow: `create-article.mjs` runs this script after every successful
 * generation and `generate-article.yml` commits the result. The svizzera feeds
 * are NOT seeded in the introducing PR (they are derived artifacts, ~1.5MB);
 * the first scheduled article-gen run after merge materializes + commits them.
 *
 * Usage:
 *   node scripts/generate-rss-feeds.mjs          # Generate all feeds
 *   node scripts/generate-rss-feeds.mjs --check   # Verify feeds exist and are valid
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLE_SECTION_CORE } from '../build-plugins/shared/articleSectionCore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BASE_URL = 'https://frontaliereticino.ch';

const LOCALES = ['it', 'en', 'de', 'fr'];
const MAX_ITEMS = 50;

// ── Section configs ───────────────────────────────────────────────────
// Each section declares its data sources + per-locale channel metadata. The
// parse/emit logic below is section-agnostic and driven entirely by this table,
// so the frontaliere output stays byte-identical to the pre-#1226 single-section
// version while svizzera is added purely additively.
//
// slugFile/bodyDir/metaFile-prefix/articlePrefix are sourced from
// ARTICLE_SECTION_CORE (issue #4881 Fase 6, AGENTS.md #6) — the same
// canonical tuple services/articleSections.ts re-exports as ARTICLE_SECTIONS.
// `seoFiles` here is DELIBERATELY narrower than the full seo-blog chunk list
// other consumers use (RSS only needs the freshest ~2 chunks worth of items,
// capped at MAX_ITEMS below) — not part of the duplicated tuple, stays local.
export const SECTIONS = [
  {
    id: 'frontaliere',
    seoFiles: ['seo-blog.ts', 'seo-blog-2.ts'],
    slugFile: ARTICLE_SECTION_CORE.frontaliere.slugDataFile,
    metaFile: (locale) => `${ARTICLE_SECTION_CORE.frontaliere.metaPrefix}-${locale}.ts`,
    bodyDir: ARTICLE_SECTION_CORE.frontaliere.bodyDir,
    // Localized slug fallback: missing locale → IT slug → articleId.
    slugFallback: 'it',
    mainFeed: 'rss.xml',
    feedFile: (locale) => `rss-${locale}.xml`,
    localeMeta: {
      it: { title: 'Frontaliere Ticino', description: 'Notizie e guide per frontalieri italiani in Ticino', language: 'it', articlePrefix: `/${ARTICLE_SECTION_CORE.frontaliere.indexSlug.it}/` },
      en: { title: 'Frontaliere Ticino — English', description: 'News and guides for cross-border workers in Ticino', language: 'en', articlePrefix: `/en/${ARTICLE_SECTION_CORE.frontaliere.indexSlug.en}/` },
      de: { title: 'Frontaliere Ticino — Deutsch', description: 'Nachrichten und Leitfaden für Grenzgänger im Tessin', language: 'de', articlePrefix: `/de/${ARTICLE_SECTION_CORE.frontaliere.indexSlug.de}/` },
      fr: { title: 'Frontaliere Ticino — Français', description: 'Actualités et guides pour les frontaliers au Tessin', language: 'fr', articlePrefix: `/fr/${ARTICLE_SECTION_CORE.frontaliere.indexSlug.fr}/` },
    },
  },
  {
    id: 'svizzera',
    seoFiles: ['seo-blog-ch.ts'],
    slugFile: ARTICLE_SECTION_CORE.svizzera.slugDataFile,
    metaFile: (locale) => `${ARTICLE_SECTION_CORE.svizzera.metaPrefix}-${locale}.ts`,
    bodyDir: ARTICLE_SECTION_CORE.svizzera.bodyDir,
    // National slugs default to the article id per-locale (matches the
    // indexing-api URL resolution in generate-article.yml: SWISS_SLUGS[id][loc]
    // with an id fallback, NOT an IT-slug fallback).
    slugFallback: 'id',
    mainFeed: 'rss-svizzera.xml',
    feedFile: (locale) => `rss-svizzera-${locale}.xml`,
    localeMeta: {
      it: { title: 'Frontaliere Ticino — Svizzera', description: 'Notizie e guide sulla Svizzera: economia, lavoro, fisco e vita quotidiana', language: 'it', articlePrefix: `/${ARTICLE_SECTION_CORE.svizzera.indexSlug.it}/` },
      en: { title: 'Frontaliere Ticino — Switzerland', description: 'News and guides about Switzerland: economy, work, taxes and daily life', language: 'en', articlePrefix: `/en/${ARTICLE_SECTION_CORE.svizzera.indexSlug.en}/` },
      de: { title: 'Frontaliere Ticino — Schweiz', description: 'Nachrichten und Leitfäden zur Schweiz: Wirtschaft, Arbeit, Steuern und Alltag', language: 'de', articlePrefix: `/de/${ARTICLE_SECTION_CORE.svizzera.indexSlug.de}/` },
      fr: { title: 'Frontaliere Ticino — Suisse', description: 'Actualités et guides sur la Suisse : économie, travail, fiscalité et vie quotidienne', language: 'fr', articlePrefix: `/fr/${ARTICLE_SECTION_CORE.svizzera.indexSlug.fr}/` },
    },
  },
];

// ── Parse seo-blog*.ts files for article metadata ─────────────────────

function parseSeoBlogs(seoFiles) {
  const articles = new Map(); // key: articleId → metadata

  for (const file of seoFiles) {
    const filePath = path.join(ROOT, 'services', 'seo', file);
    if (!fs.existsSync(filePath)) continue;
    const src = fs.readFileSync(filePath, 'utf-8');

    // Split into per-entry blocks: each starts with 'blog-{id}': {
    const entryRe = /'blog-([^']+)':\s*\{/g;
    let match;
    const entryPositions = [];
    while ((match = entryRe.exec(src)) !== null) {
      entryPositions.push({ articleId: match[1], start: match.index });
    }

    for (let i = 0; i < entryPositions.length; i++) {
      const { articleId, start } = entryPositions[i];
      const end = i + 1 < entryPositions.length ? entryPositions[i + 1].start : start + 4000;
      const block = src.slice(start, Math.min(end, start + 4000));

      // Extract individual fields with robust per-field regexes
      const headline = block.match(/"headline":\s*"([^"]+)"/)?.[1];
      const description = block.match(/"description":\s*"([^"]+)"/)?.[1];
      const datePublished = block.match(/"datePublished":\s*"([^"]+)"/)?.[1];
      const dateModified = block.match(/"dateModified":\s*"([^"]+)"/)?.[1];
      const articleSection = block.match(/"articleSection":\s*"([^"]+)"/)?.[1];
      const ogDescription = block.match(/ogDescription:\s*'([^']+)'/)?.[1];

      // Image: extract filename from template literal or string URL
      const imageMatch = block.match(/"url":\s*`[^`]*?\/([^/`]+?\.(jpg|png|webp))`/)
        || block.match(/"url":\s*"[^"]*?\/([^/"]+?\.(jpg|png|webp))"/);
      const imageFile = imageMatch?.[1]?.replace(/\.(jpg|png|webp)$/, '') || '';

      if (!headline || !datePublished) continue;

      articles.set(articleId, {
        headline,
        description: description || ogDescription || headline,
        imageFile,
        datePublished,
        dateModified: dateModified || datePublished,
        articleSection: articleSection || 'Notizie',
        excerpt: ogDescription || description || headline,
      });
    }
  }

  return articles;
}

// ── Parse slug mappings (routerBlogData.ts / routerSwissData.ts) ──────

function parseBlogSlugs(slugFile) {
  const filePath = path.join(ROOT, slugFile);
  if (!fs.existsSync(filePath)) return new Map();
  const src = fs.readFileSync(filePath, 'utf-8');

  const slugs = new Map(); // articleId → { it, en, de, fr }
  const entryRe = /["']([^"']+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
  let match;
  while ((match = entryRe.exec(src)) !== null) {
    slugs.set(match[1], { it: match[2], en: match[3], de: match[4], fr: match[5] });
  }
  return slugs;
}

// ── Parse blog-meta-{locale}.ts for localized titles ──────────────────

function parseLocalizedTitles(metaFileName) {
  const filePath = path.join(ROOT, 'services', 'locales', metaFileName);
  if (!fs.existsSync(filePath)) return new Map();
  const src = fs.readFileSync(filePath, 'utf-8');

  const titles = new Map(); // articleId → title
  // Handle escaped single quotes (e.g. dell\'Italia) by matching \\' as part of the value
  const re = /'blog\.article\.([^']+)\.title':\s*'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    // Unescape \\' → ' so titles render correctly in RSS XML
    titles.set(match[1], match[2].replace(/\\'/g, "'"));
  }
  return titles;
}

function parseLocalizedExcerpts(metaFileName) {
  const filePath = path.join(ROOT, 'services', 'locales', metaFileName);
  if (!fs.existsSync(filePath)) return new Map();
  const src = fs.readFileSync(filePath, 'utf-8');

  const excerpts = new Map();
  // Handle escaped single quotes (e.g. l\'accordo) by matching \\' as part of the value
  const re = /'blog\.article\.([^']+)\.excerpt':\s*'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    // Unescape \\' → ' so excerpts render correctly in RSS XML
    excerpts.set(match[1], match[2].replace(/\\'/g, "'"));
  }
  return excerpts;
}

// ── XML helpers ───────────────────────────────────────────────────────

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRfc822(isoDate) {
  try {
    return new Date(isoDate).toUTCString();
  } catch {
    return new Date().toUTCString();
  }
}

// ── Image URL resolution ──────────────────────────────────────────────

// Blog hero images were offloaded to the CDN (#1705/#1354) — the origin
// `/images/blog` path now 404s, and RSS readers have no JS fallback, so the
// enclosure thumbnail breaks. `/images/places` and `/icons` stay same-origin
// (not offloaded). Canonical CDN host (mirrors blogImageCdn CDN_BLOG_BASE).
const IMAGE_CDN_BASE = 'https://cdn.frontaliereticino.ch';

function resolveImageUrl(imageFile, articleId) {
  // Check common image locations
  for (const dir of ['images/blog', 'images/places']) {
    for (const ext of ['.jpg', '.png', '.webp']) {
      const candidate = path.join(PUBLIC_DIR, dir, `${imageFile}${ext}`);
      if (fs.existsSync(candidate)) {
        const host = dir === 'images/blog' ? IMAGE_CDN_BASE : BASE_URL;
        return `${host}/${dir}/${imageFile}${ext}`;
      }
    }
  }
  // Fallback: try matching in public/images/blog/ by articleId
  const blogDir = path.join(PUBLIC_DIR, 'images', 'blog');
  if (fs.existsSync(blogDir)) {
    const files = fs.readdirSync(blogDir);
    const match = files.find(f => f.startsWith(articleId) || f.startsWith(imageFile));
    if (match) return `${IMAGE_CDN_BASE}/images/blog/${match}`;
  }
  return `${BASE_URL}/icons/icon-512x512.png`;
}

// ── Blog body parsing ─────────────────────────────────────────────────

/**
 * Parse full article bodies from {bodyDir}/{locale}/*.ts files.
 * Returns Map<articleId, fullBodyHtml>.
 */
function parseBlogBodies(bodyDir, locale) {
  const bodies = new Map();
  const dir = path.join(ROOT, 'services', 'locales', bodyDir, locale);
  if (!fs.existsSync(dir)) return bodies;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
  // Match: 'blog.article.{id}.bodyN': `...` or '...'
  const rx = /['"]blog\.article\.([^'"]+)\.(body\d+)['"]\s*:\s*[`']((?:[^`'\\]|\\.)*)(?:[`'])/g;

  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf-8');
    const articleParts = new Map(); // articleId → { body1: '...', body2: '...' }
    let m;
    rx.lastIndex = 0;
    while ((m = rx.exec(src)) !== null) {
      const [, id, part, text] = m;
      if (!articleParts.has(id)) articleParts.set(id, new Map());
      articleParts.get(id).set(part, text);
    }

    for (const [id, parts] of articleParts) {
      // Sort body1, body2, body3... and concatenate
      const sorted = [...parts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, v]) => v)
        .join('\n');
      if (sorted.length > 50) {
        bodies.set(id, sorted);
      }
    }
  }

  return bodies;
}

// ── RSS feed generation ───────────────────────────────────────────────

function generateRssFeed(section, locale, articles, slugs, localizedTitles, localizedExcerpts, localizedBodies) {
  const meta = section.localeMeta[locale];
  // The IT per-locale feed's self-link points at the section's main feed
  // (rss.xml / rss-svizzera.xml), since the main feed is a byte copy of the IT
  // one. Preserves the exact pre-#1226 frontaliere output.
  const feedUrl = locale === 'it'
    ? `${BASE_URL}/${section.mainFeed}`
    : `${BASE_URL}/${section.feedFile(locale)}`;

  // Build items from articles, sorted by datePublished descending
  const items = [];
  for (const [articleId, article] of articles) {
    const locSlugs = slugs.get(articleId);
    // Section-aware slug fallback: frontaliere → IT-slug then id; svizzera → id.
    const slug = locSlugs?.[locale]
      || (section.slugFallback === 'it' ? locSlugs?.it : undefined)
      || articleId;
    const title = localizedTitles.get(articleId) || article.headline;
    const excerpt = localizedExcerpts.get(articleId) || article.excerpt || article.description;
    const imageUrl = resolveImageUrl(article.imageFile, articleId);
    const fullBody = localizedBodies.get(articleId) || '';

    items.push({
      title,
      slug,
      excerpt: excerpt.slice(0, 500),
      fullBody,
      pubDate: article.datePublished,
      category: article.articleSection,
      imageUrl,
      articleId,
    });
  }

  // Sort by date descending and take top N
  items.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  const topItems = items.slice(0, MAX_ITEMS);

  if (topItems.length === 0) return null;

  const lastBuildDate = toRfc822(topItems[0].pubDate);

  const itemsXml = topItems.map(item => {
    const body = localizedBodies?.get(item.articleId);
    const contentEncoded = body
      ? `\n      <content:encoded><![CDATA[${body}]]></content:encoded>`
      : '';
    return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${BASE_URL}${meta.articlePrefix}${item.slug}/</link>
      <description><![CDATA[${item.excerpt}]]></description>${contentEncoded}
      <pubDate>${toRfc822(item.pubDate)}</pubDate>
      <guid isPermaLink="true">${BASE_URL}${meta.articlePrefix}${item.slug}/</guid>
      <category>${escapeXml(item.category)}</category>
      <media:content url="${escapeXml(item.imageUrl)}" medium="image"/>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:media="http://search.yahoo.com/mrss/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(meta.title)}</title>
    <link>${BASE_URL}</link>
    <description>${escapeXml(meta.description)}</description>
    <language>${meta.language}</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <image>
      <url>${BASE_URL}/icons/icon-512x512.png</url>
      <title>${escapeXml(meta.title)}</title>
      <link>${BASE_URL}</link>
    </image>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <atom:link rel="hub" href="https://pubsubhubbub.appspot.com/"/>
${itemsXml}
  </channel>
</rss>
`;
}

// ── Main ──────────────────────────────────────────────────────────────

function generateSection(section) {
  const articles = parseSeoBlogs(section.seoFiles);
  const slugs = parseBlogSlugs(section.slugFile);

  if (articles.size === 0) {
    console.warn(`⚠️  No articles found for section '${section.id}' — skipping.`);
    return { emitted: 0, hadArticles: false };
  }
  console.log(`   [${section.id}] Found ${articles.size} articles, ${slugs.size} slug mappings`);

  let emitted = 0;
  for (const locale of LOCALES) {
    const titles = parseLocalizedTitles(section.metaFile(locale));
    const excerpts = parseLocalizedExcerpts(section.metaFile(locale));
    const bodies = parseBlogBodies(section.bodyDir, locale);
    const feed = generateRssFeed(section, locale, articles, slugs, titles, excerpts, bodies);

    if (!feed) {
      console.warn(`   ⚠️  No items for ${section.id}/${locale} feed — skipping`);
      continue;
    }

    const filename = section.feedFile(locale);
    const outputPath = path.join(PUBLIC_DIR, filename);
    fs.writeFileSync(outputPath, feed, 'utf-8');
    emitted++;
    console.log(`   ✅ ${filename} written (${feed.length} bytes)`);

    // Main feed is a copy of the Italian feed with a self-referencing atom:link
    // pointing at the main filename instead of the per-locale one.
    if (locale === 'it') {
      const mainPath = path.join(PUBLIC_DIR, section.mainFeed);
      const mainFeed = feed.replace(
        `href="${BASE_URL}/${section.feedFile('it')}"`,
        `href="${BASE_URL}/${section.mainFeed}"`
      );
      fs.writeFileSync(mainPath, mainFeed, 'utf-8');
      emitted++;
      console.log(`   ✅ ${section.mainFeed} written (copy of ${section.id} IT feed)`);
    }
  }

  return { emitted, hadArticles: true };
}

function main() {
  const checkMode = process.argv.includes('--check');

  console.log('📡 Generating RSS feeds...');

  let totalEmitted = 0;
  let anyArticles = false;
  for (const section of SECTIONS) {
    const { emitted, hadArticles } = generateSection(section);
    totalEmitted += emitted;
    anyArticles = anyArticles || hadArticles;
  }

  if (!anyArticles) {
    console.warn('⚠️  No articles found in any section — skipping RSS generation.');
    process.exit(checkMode ? 1 : 0);
  }

  console.log(`📡 RSS feeds generated successfully (${totalEmitted} files).`);
}

main();
