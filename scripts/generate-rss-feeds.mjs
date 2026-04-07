#!/usr/bin/env node
/**
 * Generate RSS 2.0 feeds for Google Publisher Center sections.
 *
 * Reads article metadata from seo-blog.ts + seo-blog-2.ts and slug mappings
 * from routerBlogData.ts to produce per-locale RSS feeds.
 *
 * Output files (in public/):
 *   rss.xml     — Main feed (Italian, last 50 articles)
 *   rss-it.xml  — Italian feed
 *   rss-en.xml  — English feed
 *   rss-de.xml  — German feed
 *   rss-fr.xml  — French feed
 *
 * Usage:
 *   node scripts/generate-rss-feeds.mjs          # Generate all feeds
 *   node scripts/generate-rss-feeds.mjs --check   # Verify feeds exist and are valid
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BASE_URL = 'https://frontaliereticino.ch';

const LOCALES = ['it', 'en', 'de', 'fr'];
const MAX_ITEMS = 50;

const LOCALE_META = {
  it: { title: 'Frontaliere Ticino', description: 'Notizie e guide per frontalieri italiani in Ticino', language: 'it', articlePrefix: '/articoli-frontaliere/' },
  en: { title: 'Frontaliere Ticino — English', description: 'News and guides for cross-border workers in Ticino', language: 'en', articlePrefix: '/en/articoli-frontaliere/' },
  de: { title: 'Frontaliere Ticino — Deutsch', description: 'Nachrichten und Leitfaden für Grenzgänger im Tessin', language: 'de', articlePrefix: '/de/articoli-frontaliere/' },
  fr: { title: 'Frontaliere Ticino — Français', description: 'Actualités et guides pour les frontaliers au Tessin', language: 'fr', articlePrefix: '/fr/articoli-frontaliere/' },
};

// ── Parse seo-blog.ts files for article metadata ──────────────────────

function parseSeoBlogs() {
  const articles = new Map(); // key: articleId → metadata

  for (const file of ['seo-blog.ts', 'seo-blog-2.ts']) {
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

// ── Parse routerBlogData.ts for slug mappings ─────────────────────────

function parseBlogSlugs() {
  const filePath = path.join(ROOT, 'services', 'routerBlogData.ts');
  if (!fs.existsSync(filePath)) return new Map();
  const src = fs.readFileSync(filePath, 'utf-8');

  const slugs = new Map(); // articleId → { it, en, de, fr }
  const entryRe = /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
  let match;
  while ((match = entryRe.exec(src)) !== null) {
    slugs.set(match[1], { it: match[2], en: match[3], de: match[4], fr: match[5] });
  }
  return slugs;
}

// ── Parse blog-meta-{locale}.ts for localized titles ──────────────────

function parseLocalizedTitles(locale) {
  const filePath = path.join(ROOT, 'services', 'locales', `blog-meta-${locale}.ts`);
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

function parseLocalizedExcerpts(locale) {
  const filePath = path.join(ROOT, 'services', 'locales', `blog-meta-${locale}.ts`);
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

function resolveImageUrl(imageFile, articleId) {
  // Check common image locations
  for (const dir of ['images/blog', 'images/places']) {
    for (const ext of ['.jpg', '.png', '.webp']) {
      const candidate = path.join(PUBLIC_DIR, dir, `${imageFile}${ext}`);
      if (fs.existsSync(candidate)) {
        return `${BASE_URL}/${dir}/${imageFile}${ext}`;
      }
    }
  }
  // Fallback: try matching in public/images/blog/ by articleId
  const blogDir = path.join(PUBLIC_DIR, 'images', 'blog');
  if (fs.existsSync(blogDir)) {
    const files = fs.readdirSync(blogDir);
    const match = files.find(f => f.startsWith(articleId) || f.startsWith(imageFile));
    if (match) return `${BASE_URL}/images/blog/${match}`;
  }
  return `${BASE_URL}/icons/icon-512x512.png`;
}

// ── Blog body parsing ─────────────────────────────────────────────────

/**
 * Parse full article bodies from blog-body/{locale}/*.ts files.
 * Returns Map<articleId, fullBodyHtml>.
 */
function parseBlogBodies(locale) {
  const bodies = new Map();
  const bodyDir = path.join(ROOT, 'services', 'locales', 'blog-body', locale);
  if (!fs.existsSync(bodyDir)) return bodies;

  const files = fs.readdirSync(bodyDir).filter(f => f.endsWith('.ts'));
  // Match: 'blog.article.{id}.bodyN': `...` or '...'
  const rx = /['"]blog\.article\.([^'"]+)\.(body\d+)['"]\s*:\s*[`']((?:[^`'\\]|\\.)*)(?:[`'])/g;

  for (const file of files) {
    const src = fs.readFileSync(path.join(bodyDir, file), 'utf-8');
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

function generateRssFeed(locale, articles, slugs, localizedTitles, localizedExcerpts, localizedBodies) {
  const meta = LOCALE_META[locale];
  const feedUrl = locale === 'it' ? `${BASE_URL}/rss.xml` : `${BASE_URL}/rss-${locale}.xml`;

  // Build items from articles, sorted by datePublished descending
  const items = [];
  for (const [articleId, article] of articles) {
    const locSlugs = slugs.get(articleId);
    const slug = locSlugs?.[locale] || locSlugs?.it || articleId;
    const title = localizedTitles.get(articleId) || article.headline;
    const excerpt = localizedExcerpts.get(articleId) || article.excerpt || article.description;
    const imageUrl = resolveImageUrl(article.imageFile, articleId);

    items.push({
      title,
      slug,
      excerpt: excerpt.slice(0, 500),
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

function main() {
  const checkMode = process.argv.includes('--check');

  console.log('📡 Generating RSS feeds...');

  // Parse data sources
  const articles = parseSeoBlogs();
  const slugs = parseBlogSlugs();

  if (articles.size === 0) {
    console.warn('⚠️  No articles found in seo-blog.ts — skipping RSS generation.');
    process.exit(checkMode ? 1 : 0);
  }
  console.log(`   Found ${articles.size} articles, ${slugs.size} slug mappings`);

  // Generate per-locale feeds
  for (const locale of LOCALES) {
    const titles = parseLocalizedTitles(locale);
    const excerpts = parseLocalizedExcerpts(locale);
    const bodies = parseBlogBodies(locale);
    const feed = generateRssFeed(locale, articles, slugs, titles, excerpts, bodies);

    if (!feed) {
      console.warn(`   ⚠️  No items for ${locale} feed — skipping`);
      continue;
    }

    const filename = `rss-${locale}.xml`;
    const outputPath = path.join(PUBLIC_DIR, filename);
    fs.writeFileSync(outputPath, feed, 'utf-8');
    console.log(`   ✅ ${filename} written (${feed.length} bytes)`);

    // Main rss.xml is a copy of the Italian feed
    if (locale === 'it') {
      const mainPath = path.join(PUBLIC_DIR, 'rss.xml');
      // Update self-referencing atom:link to point to rss.xml
      const mainFeed = feed.replace(
        `href="${BASE_URL}/rss-it.xml"`,
        `href="${BASE_URL}/rss.xml"`
      );
      fs.writeFileSync(mainPath, mainFeed, 'utf-8');
      console.log(`   ✅ rss.xml written (copy of IT feed)`);
    }
  }

  console.log('📡 RSS feeds generated successfully.');
}

main();
