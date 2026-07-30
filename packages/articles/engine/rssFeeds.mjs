/**
 * RSS 2.0 feed generation for the two article sections — the ONE implementation.
 *
 * This used to live entirely in `scripts/generate-rss-feeds.mjs` in the site
 * repository, which is where it stopped making sense: the feeds are derived
 * from the corpus (registry + per-locale meta + bodies + slug maps), and the
 * corpus has its own repository now. The articles repo republishes them next to
 * the sitemaps, and the site pulls both as static files (issue #4974 item 2).
 *
 * It is MOVED here rather than reimplemented there. A second copy of this
 * parse/emit logic would drift silently — a feed is not diffed by anyone once
 * it is served, so an emitter that quietly stopped matching would go unnoticed
 * until an aggregator dropped the channel. AGENTS.md #6: one module, two
 * callers, drift impossible by construction.
 *
 * The only site-shaped inputs are hoisted into `layout`:
 *   - `seoDir`     where `seo-blog*.ts` live               (site: services/seo)
 *   - `localesDir` where `blog-meta-*.ts` + body dirs live (site: services/locales)
 *   - `slugDir`    where `router{Blog,Swiss}Data.ts` live  (site: services/)
 * All three default to the site layout, so the in-repo caller is unchanged.
 *
 * ── Image URLs come from the registry, not the filesystem ──────────────
 * The previous implementation resolved each item's `media:content` by probing
 * `public/images/{blog,places}/` for three extensions and falling back to the
 * app icon. That probe is unavailable to a repo that holds only the corpus,
 * and it was redundant: `Article.image` is already the CDN URL (the registry
 * runs every path through `cdnBlogImage()` — see content/blogImageCdnMirror.ts).
 * Verified before the switch: for all 100 items across the two IT feeds, the
 * registry value equals the URL the filesystem probe produced, byte for byte.
 * Reading it from the registry also means an article whose hero image has not
 * been mirrored to the deploying checkout no longer silently degrades to the
 * app icon in the feed.
 */
import { ARTICLE_SECTION_CORE } from './shared/articleSectionCore.mjs';

export const BASE_URL = 'https://frontaliereticino.ch';
export const RSS_LOCALES = ['it', 'en', 'de', 'fr'];
export const RSS_MAX_ITEMS = 50;

/**
 * Section table. `slugFile`/`bodyDir`/`metaPrefix`/`indexSlug` come from
 * ARTICLE_SECTION_CORE (the canonical tuple); `seoFiles` is deliberately
 * NARROWER than the full seo-blog chunk list other consumers use — the feed
 * only needs the freshest chunks, capped at RSS_MAX_ITEMS below — so it stays
 * local to this table rather than joining the shared tuple.
 */
export const RSS_SECTIONS = [
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
      en: { title: 'Frontaliere Ticino — English', description: 'News and guides for cross-border workers in Ticino', language: 'en', articlePrefix: `/en/${ARTICLE_SECTION_CORE.frontaliere.indexSlug.en}/` }, // locale-segment-ok: voce di una mappa localeMeta indicizzata per locale — il prefisso /en/ e il branch per-locale, non un path costruito dinamicamente
      de: { title: 'Frontaliere Ticino — Deutsch', description: 'Nachrichten und Leitfaden für Grenzgänger im Tessin', language: 'de', articlePrefix: `/de/${ARTICLE_SECTION_CORE.frontaliere.indexSlug.de}/` }, // locale-segment-ok: voce di una mappa localeMeta indicizzata per locale — il prefisso /de/ e il branch per-locale, non un path costruito dinamicamente
      fr: { title: 'Frontaliere Ticino — Français', description: 'Actualités et guides pour les frontaliers au Tessin', language: 'fr', articlePrefix: `/fr/${ARTICLE_SECTION_CORE.frontaliere.indexSlug.fr}/` }, // locale-segment-ok: voce di una mappa localeMeta indicizzata per locale — il prefisso /fr/ e il branch per-locale, non un path costruito dinamicamente
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
      en: { title: 'Frontaliere Ticino — Switzerland', description: 'News and guides about Switzerland: economy, work, taxes and daily life', language: 'en', articlePrefix: `/en/${ARTICLE_SECTION_CORE.svizzera.indexSlug.en}/` }, // locale-segment-ok: voce di una mappa localeMeta indicizzata per locale — il prefisso /en/ e il branch per-locale, non un path costruito dinamicamente
      de: { title: 'Frontaliere Ticino — Schweiz', description: 'Nachrichten und Leitfäden zur Schweiz: Wirtschaft, Arbeit, Steuern und Alltag', language: 'de', articlePrefix: `/de/${ARTICLE_SECTION_CORE.svizzera.indexSlug.de}/` }, // locale-segment-ok: voce di una mappa localeMeta indicizzata per locale — il prefisso /de/ e il branch per-locale, non un path costruito dinamicamente
      fr: { title: 'Frontaliere Ticino — Suisse', description: 'Actualités et guides sur la Suisse : économie, travail, fiscalité et vie quotidienne', language: 'fr', articlePrefix: `/fr/${ARTICLE_SECTION_CORE.svizzera.indexSlug.fr}/` }, // locale-segment-ok: voce di una mappa localeMeta indicizzata per locale — il prefisso /fr/ e il branch per-locale, non un path costruito dinamicamente
    },
  },
];

const DEFAULT_LAYOUT = { seoDir: 'services/seo', localesDir: 'services/locales', slugDir: null };

/**
 * Where the slug-data module sits. `slugDataFile` in the canonical section
 * tuple is a SITE-relative path (`services/routerBlogData.ts`); a repo holding
 * only the corpus keeps the same file under a different parent. `slugDir`
 * re-parents it by filename; left null, the tuple's path is used verbatim.
 */
function resolveSlugFile(path, slugFile, slugDir) {
  if (!slugDir) return slugFile;
  return path.join(slugDir, path.basename(slugFile));
}

// ── Parsers ───────────────────────────────────────────────────────────

/** Parse seo-blog*.ts chunks for per-article SEO metadata. */
function parseSeoBlogs(fs, path, rootDir, seoDir, seoFiles) {
  const articles = new Map(); // articleId → metadata

  for (const file of seoFiles) {
    const filePath = path.join(rootDir, seoDir, file);
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

      const headline = block.match(/"headline":\s*"([^"]+)"/)?.[1];
      const description = block.match(/"description":\s*"([^"]+)"/)?.[1];
      const datePublished = block.match(/"datePublished":\s*"([^"]+)"/)?.[1];
      const dateModified = block.match(/"dateModified":\s*"([^"]+)"/)?.[1];
      const articleSection = block.match(/"articleSection":\s*"([^"]+)"/)?.[1];
      const ogDescription = block.match(/ogDescription:\s*'([^']+)'/)?.[1];

      if (!headline || !datePublished) continue;

      articles.set(articleId, {
        headline,
        description: description || ogDescription || headline,
        datePublished,
        dateModified: dateModified || datePublished,
        articleSection: articleSection || 'Notizie',
        excerpt: ogDescription || description || headline,
      });
    }
  }

  return articles;
}

/** Parse the `BlogArticleId` → per-locale URL-slug map. */
function parseBlogSlugs(fs, path, rootDir, slugFile) {
  const filePath = path.join(rootDir, slugFile);
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

function parseLocalizedField(fs, path, rootDir, localesDir, metaFileName, field) {
  const filePath = path.join(rootDir, localesDir, metaFileName);
  if (!fs.existsSync(filePath)) return new Map();
  const src = fs.readFileSync(filePath, 'utf-8');

  const out = new Map(); // articleId → value
  // Handle escaped single quotes (e.g. dell\'Italia) by matching \\' as part of the value
  const re = new RegExp(`'blog\\.article\\.([^']+)\\.${field}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g');
  let match;
  while ((match = re.exec(src)) !== null) {
    // Unescape \\' → ' so values render correctly in RSS XML
    out.set(match[1], match[2].replace(/\\'/g, "'"));
  }
  return out;
}

/** Concatenate the per-locale body chunks of every article in a body dir. */
function parseBlogBodies(fs, path, rootDir, localesDir, bodyDir, locale) {
  const bodies = new Map();
  const dir = path.join(rootDir, localesDir, bodyDir, locale);
  if (!fs.existsSync(dir)) return bodies;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
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

const FALLBACK_IMAGE = `${BASE_URL}/icons/icon-512x512.png`;

// ── Feed rendering ────────────────────────────────────────────────────

function renderFeed(section, locale, articles, slugs, titles, excerpts, bodies, images) {
  const meta = section.localeMeta[locale];

  // The IT per-locale feed's self-link points at the section's main feed
  // (rss.xml / rss-svizzera.xml), since the main feed is a byte copy of the IT
  // one. Preserves the exact pre-#1226 frontaliere output.
  const feedUrl =
    locale === 'it' ? `${BASE_URL}/${section.mainFeed}` : `${BASE_URL}/${section.feedFile(locale)}`;

  const items = [];
  for (const [articleId, article] of articles) {
    const locSlugs = slugs.get(articleId);
    // Section-aware slug fallback: frontaliere → IT-slug then id; svizzera → id.
    const slug =
      locSlugs?.[locale] ||
      (section.slugFallback === 'it' ? locSlugs?.it : undefined) ||
      articleId;
    const title = titles.get(articleId) || article.headline;
    const excerpt = excerpts.get(articleId) || article.excerpt || article.description;

    items.push({
      title,
      slug,
      excerpt: excerpt.slice(0, 500),
      pubDate: article.datePublished,
      category: article.articleSection,
      imageUrl: images.get(articleId) || FALLBACK_IMAGE,
      articleId,
    });
  }

  // Sort by date descending and take top N
  items.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  const topItems = items.slice(0, RSS_MAX_ITEMS);
  if (topItems.length === 0) return null;

  const lastBuildDate = toRfc822(topItems[0].pubDate);

  const itemsXml = topItems
    .map((item) => {
      const body = bodies?.get(item.articleId);
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
    })
    .join('\n');

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

/**
 * Build every RSS feed for one section.
 *
 * Returns `{ id, articleCount, slugCount, feeds }` where `feeds` is an ordered
 * `[filename, xml]` list — the caller decides where the bytes land (public/ in
 * the site, dist/api/ in the publisher). Nothing is written here.
 *
 * `registry` is the section's article array; only `id` and `image` are read,
 * to resolve `media:content` without touching the filesystem.
 */
export function buildSectionFeeds({ fs, path, rootDir, section, registry = [], layout = {} }) {
  const { seoDir, localesDir, slugDir } = { ...DEFAULT_LAYOUT, ...layout };

  const articles = parseSeoBlogs(fs, path, rootDir, seoDir, section.seoFiles);
  const slugs = parseBlogSlugs(fs, path, rootDir, resolveSlugFile(path, section.slugFile, slugDir));
  if (articles.size === 0) {
    return { id: section.id, articleCount: 0, slugCount: slugs.size, feeds: [] };
  }

  // `Article.image` is already absolute for blog heroes (the registry maps them
  // through `cdnBlogImage`), but the older `/images/places/*` entries are still
  // origin-relative and are NOT offloaded to the CDN — the filesystem probe this
  // replaces served exactly those from BASE_URL. Same split, no host guessing.
  const images = new Map();
  for (const a of registry) {
    if (!a || !a.id || !a.image) continue;
    images.set(a.id, a.image.startsWith('http') ? a.image : `${BASE_URL}${a.image}`);
  }

  const feeds = [];
  for (const locale of RSS_LOCALES) {
    const metaFileName = section.metaFile(locale);
    const titles = parseLocalizedField(fs, path, rootDir, localesDir, metaFileName, 'title');
    const excerpts = parseLocalizedField(fs, path, rootDir, localesDir, metaFileName, 'excerpt');
    const bodies = parseBlogBodies(fs, path, rootDir, localesDir, section.bodyDir, locale);

    const xml = renderFeed(section, locale, articles, slugs, titles, excerpts, bodies, images);
    if (!xml) continue;

    feeds.push([section.feedFile(locale), xml]);
    // The main feed is a byte copy of the Italian one — the IT feed already
    // self-links to the main filename (see `feedUrl` above), so no re-render.
    if (locale === 'it') feeds.push([section.mainFeed, xml]);
  }

  return { id: section.id, articleCount: articles.size, slugCount: slugs.size, feeds };
}

/** Build every feed of every section. `registries` is keyed by section id. */
export function buildAllRssFeeds({ fs, path, rootDir, registries = {}, layout = {} }) {
  return RSS_SECTIONS.map((section) =>
    buildSectionFeeds({
      fs,
      path,
      rootDir,
      section,
      registry: registries[section.id] ?? [],
      layout,
    }),
  );
}
