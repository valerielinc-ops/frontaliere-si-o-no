/**
 * Shared article-content resolution for the newsletter senders (#4299).
 *
 * Extracted out of scripts/send-newsletter.mjs so scripts/newsletter-winback-campaign.mjs
 * (the dormant-tier win-back sequence) can localize the SAME article-performance
 * winners the regular weekly send uses, without a second, drift-prone copy of the
 * slug/meta-file parsing logic. Single source of truth for:
 *   - `localePathPrefix`   — empty for IT (canonical), `/{lang}` otherwise
 *   - `getBlogSlug`        — article id -> localized slug (services/routerBlogData.ts)
 *   - `loadBlogMeta`       — article id -> { title, excerpt } (services/locales/blog-meta-*.ts)
 *   - `localizeArticle`    — article id -> { title, excerpt, url, badge } (matches
 *     buildNewsletter's `data.article` contract in services/newsletter-template.mjs)
 *   - `loadArticlePerformanceWinners` — data/article-performance.json `.winners`
 *
 * Pure file-read parsing (regex over the .ts source), no bundler/TS-transpile
 * needed at CLI runtime — same approach the extracted functions already used.
 */
import fs from 'node:fs';

/** Build the locale URL prefix — empty for IT (canonical), `/{lang}` otherwise. */
export function localePathPrefix(locale) {
  return locale === 'it' ? '' : `/${locale}`;
}

/** Blog section URL path per locale (matches router.ts SLUG_TABLES) */
export const BLOG_SECTION_PATH = {
  it: 'articoli-frontaliere',
  en: 'cross-border-articles',
  de: 'grenzgaenger-artikel',
  fr: 'articles-frontalier',
};

// Capture group for a single-quoted string literal that allows escaped chars
// (e.g. `'L\'incertezza...'`). A plain `'([^']*)'` truncates at the first
// `\'` so excerpts containing apostrophes get cut to their first character.
const QUOTED_RE_SRC = `'((?:\\\\.|[^'\\\\])*)'`;

function unescapeJsString(s) {
  return s.replace(/\\(.)/g, (_m, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

/**
 * Resolve an article ID to its localized slug from routerBlogData.ts.
 * Falls back to the article ID itself if the slug map can't be read.
 */
export function getBlogSlug(articleId, locale = 'it') {
  try {
    const rdPath = new URL('../../services/routerBlogData.ts', import.meta.url);
    const raw = fs.readFileSync(rdPath, 'utf8');
    const escaped = articleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Try requested locale first, fall back to Italian
    for (const lang of [locale, 'it']) {
      const regex = new RegExp(`'${escaped}':\\s*\\{[^}]*?${lang}:\\s*${QUOTED_RE_SRC}`);
      const match = raw.match(regex);
      if (match) return unescapeJsString(match[1]);
    }
    return articleId;
  } catch {
    return articleId;
  }
}

/**
 * Load localized blog metadata for an article ID.
 * Returns { title, excerpt } or null if not found.
 * Falls back to Italian if the requested locale file doesn't exist / lacks the article.
 */
export function loadBlogMeta(articleId, locale = 'it') {
  for (const lang of [locale, 'it']) {
    try {
      const metaPath = new URL(`../../services/locales/blog-meta-${lang}.ts`, import.meta.url);
      const raw = fs.readFileSync(metaPath, 'utf8');
      const titleKey = `blog.article.${articleId}.title`;
      const excerptKey = `blog.article.${articleId}.excerpt`;
      const titleMatch = raw.match(new RegExp(`'${titleKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*${QUOTED_RE_SRC}`));
      const excerptMatch = raw.match(new RegExp(`'${excerptKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*${QUOTED_RE_SRC}`));
      if (titleMatch) {
        return {
          title: unescapeJsString(titleMatch[1]),
          excerpt: excerptMatch ? unescapeJsString(excerptMatch[1]) : '',
        };
      }
    } catch {
      // Try next locale
    }
  }
  console.warn(`⚠️ Blog meta not found for "${articleId}" in ${locale}/it`);
  return null;
}

/**
 * Build a localized article object for a given article ID and locale.
 * @returns {{title:string, excerpt:string, url:string, badge:true}|null}
 */
export function localizeArticle(articleId, locale) {
  const blogPath = BLOG_SECTION_PATH[locale] || BLOG_SECTION_PATH.it;
  const slug = getBlogSlug(articleId, locale);
  const meta = loadBlogMeta(articleId, locale);
  if (!meta) return null;
  const prefix = localePathPrefix(locale);
  return {
    title: meta.title,
    excerpt: meta.excerpt,
    // `url` — matches renderArticle's destructured param and directUrl()
    // call in services/newsletter-template.mjs (the live template; NOT
    // scripts/newsletter-template.mjs, which is dead/unimported).
    url: `${prefix}/${blogPath}/${slug}/`,
    badge: true,
  };
}

// data/article-performance.json `.winners` — real click/scroll-depth winners
// per cluster (pratico/fiscale/novita perform, generic doesn't, see #4299).
// Loaded once and cached; a missing/unreadable file degrades to an empty
// pool, so callers always fall back to their own default article rather than
// throwing.
let _articlePerformanceWinners = null;
export function loadArticlePerformanceWinners() {
  if (_articlePerformanceWinners) return _articlePerformanceWinners;
  try {
    const raw = fs.readFileSync(new URL('../../data/article-performance.json', import.meta.url), 'utf8');
    const data = JSON.parse(raw);
    _articlePerformanceWinners = Array.isArray(data.winners) ? data.winners : [];
  } catch (e) {
    console.warn('⚠️ article-performance.json unavailable, article content falls back to the default pick:', e.message);
    _articlePerformanceWinners = [];
  }
  return _articlePerformanceWinners;
}

/** Test-only: clear the memoized winners cache so fixtures don't leak across tests. */
export function _resetArticlePerformanceWinnersCache() {
  _articlePerformanceWinners = null;
}
