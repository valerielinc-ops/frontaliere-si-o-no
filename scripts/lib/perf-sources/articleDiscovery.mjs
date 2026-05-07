// Article discovery + metadata parsing for fetch-article-performance.mjs.
//
// We deliberately avoid bundling the TS files. Instead we grep them for the
// shapes we need:
//   - blog-meta-{it,en,de,fr}.ts  -> 'blog.article.<slug>.title' / .excerpt
//   - services/seo/seo-blog*.ts   -> articleSection + datePublished per slug
//
// This keeps the fetcher dependency-free (no tsx, no esbuild round-trip).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const LOCALES = /** @type {const} */ (['it', 'en', 'de', 'fr']);

const URL_PREFIX_BY_LOCALE = {
  it: 'https://frontaliereticino.ch/articoli-frontaliere/',
  en: 'https://frontaliereticino.ch/en/articoli-frontaliere/',
  de: 'https://frontaliereticino.ch/de/articoli-frontaliere/',
  fr: 'https://frontaliereticino.ch/fr/articoli-frontaliere/',
};

/**
 * Parse one blog-meta-<locale>.ts file. Returns Map<slug, {title, excerpt}>.
 * Lines look like:
 *   'blog.article.<slug>.title': 'Title text',
 *   'blog.article.<slug>.excerpt': 'Excerpt...',
 * Indentation can be 1 or more spaces — both shapes appear in the file.
 */
export function parseBlogMetaFile(text) {
  const out = new Map();
  // Capture either single- or double-quoted string values; allow embedded
  // escaped quotes.
  const re = /['"]blog\.article\.([a-z0-9-]+)\.(title|excerpt)['"]\s*:\s*(['"])((?:\\.|(?!\3).)*)\3/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const slug = m[1];
    const field = m[2];
    const raw = m[4];
    // Unescape simple JS string escapes (\\ \' \" \n)
    const value = raw.replace(/\\(['"\\nrt])/g, (_, c) => {
      if (c === 'n') return '\n';
      if (c === 'r') return '\r';
      if (c === 't') return '\t';
      return c;
    });
    if (!out.has(slug)) out.set(slug, { title: '', excerpt: '' });
    out.get(slug)[field] = value;
  }
  return out;
}

/**
 * Parse all locale meta files. Returns Map<slug, { byLocale: { it: {title, excerpt}, ... } }>.
 */
export function discoverArticles({ rootDir }) {
  /** @type {Map<string, { byLocale: Record<string, {title:string, excerpt:string}> }>} */
  const articles = new Map();
  for (const locale of LOCALES) {
    const file = path.join(rootDir, 'services', 'locales', `blog-meta-${locale}.ts`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf-8');
    const parsed = parseBlogMetaFile(text);
    for (const [slug, fields] of parsed) {
      if (!articles.has(slug)) articles.set(slug, { byLocale: {} });
      articles.get(slug).byLocale[locale] = fields;
    }
  }
  return articles;
}

/**
 * Build a flat list of canonical article URLs (one per slug per locale that
 * has a title). Returns Array<{ slug, locale, url, title, excerpt }>.
 */
export function articleUrls(articles) {
  /** @type {Array<{slug:string, locale:string, url:string, title:string, excerpt:string}>} */
  const rows = [];
  for (const [slug, { byLocale }] of articles) {
    for (const locale of LOCALES) {
      const meta = byLocale[locale];
      if (!meta || !meta.title) continue;
      rows.push({
        slug,
        locale,
        url: `${URL_PREFIX_BY_LOCALE[locale]}${slug}/`,
        title: meta.title,
        excerpt: meta.excerpt || '',
      });
    }
  }
  rows.sort((a, b) => a.url.localeCompare(b.url));
  return rows;
}

/**
 * Parse seo-blog*.ts files for the structured-data hints we want:
 *   - articleSection (cluster)
 *   - datePublished
 *
 * Each "entry" is a JS object literal keyed by `<slug>` (note: NOT prefixed
 * with `blog-`; the seo-blog files use page-id keys like
 * `'blog-stipendio-netto-2026'`). We derive the slug from canonicalPath.
 */
export function parseSeoBlogFiles({ rootDir }) {
  /** @type {Map<string, {cluster: string|null, publishedAt: string|null}>} */
  const meta = new Map();
  const seoDir = path.join(rootDir, 'services', 'seo');
  if (!existsSync(seoDir)) return meta;
  const files = readdirSync(seoDir).filter((f) => /^seo-blog(?:-\d+)?\.ts$/.test(f));
  for (const f of files) {
    const text = readFileSync(path.join(seoDir, f), 'utf-8');
    extractEntriesFromSeoBlog(text, meta);
  }
  return meta;
}

/**
 * Scan an seo-blog*.ts file for entries that include canonicalPath +
 * articleSection / datePublished, and write findings into `meta`.
 *
 * Strategy: split text by top-level entries roughly via canonicalPath.
 * For each canonicalPath '/articoli-frontaliere/<slug>' grab the slug,
 * then look in a 4 KB window for articleSection + datePublished.
 */
export function extractEntriesFromSeoBlog(text, meta) {
  const re = /canonicalPath:\s*['"]\/articoli-frontaliere\/([a-z0-9-]+)\/?['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const slug = m[1];
    const start = Math.max(0, m.index - 4000);
    const end = Math.min(text.length, m.index + 4000);
    const window = text.slice(start, end);
    const sectionM = window.match(/['"]articleSection['"]\s*:\s*['"]([^'"]+)['"]/);
    const dateM = window.match(/['"]datePublished['"]\s*:\s*['"]([^'"]+)['"]/);
    const cluster = sectionM ? sectionM[1] : null;
    const publishedAt = dateM ? dateM[1] : null;
    if (!meta.has(slug) || cluster || publishedAt) {
      const prev = meta.get(slug) || { cluster: null, publishedAt: null };
      meta.set(slug, {
        cluster: cluster || prev.cluster,
        publishedAt: publishedAt || prev.publishedAt,
      });
    }
  }
}

export const BLOG_URL_PREFIX_IT = URL_PREFIX_BY_LOCALE.it;
export const SUPPORTED_LOCALES = LOCALES;

// ── Cluster heuristic classifier ─────────────────────────────
//
// Only ~10 of 2140+ articles have an `articleSection` set in seo-blog*.ts,
// so the producer-side parser returns `cluster: null` for ~99% of winners,
// which collapses the fingerprint topClusters to `[{cluster:"unknown"}]`.
//
// The heuristic below maps each article's title+slug+excerpt to one of seven
// frontalieri-domain clusters. Order matters: more-specific cluster regexes
// run first, with `generic` as the final fallback. A title can match multiple
// clusters but only the first one wins (deterministic, no ambiguity).
//
// This is producer-side fallback. When `meta.cluster` is set (parsed from
// articleSection), `aggregate()` MUST prefer that value — the heuristic only
// fills the 99% gap.

// Stem-based patterns: leading `\b` anchors the start of a word but no
// trailing `\b` so prefixes like "stipend" match "stipendio", "permess"
// matches "permesso/permessi", etc. Matches the same convention as
// FRONTALIERI_DOMAIN_RE in domainTerms.mjs.
const CLUSTER_PATTERNS = [
  ['fiscale',  /\b(tass[ae]|fisc|imposta|irpef|iva|deduci|detraz|quellenst|730|isee|ristorn|accordo|fiscal|busta|ritenut|aliquot)/i],
  ['pensione', /\b(pension|avs|ahv|lpp|bvg|terzo\s*pilastro|secondo\s*pilastro|previdenz|3a|3b|prelievo)/i],
  ['pratico',  /\b(permess|salute|sanit|lamal|cmi|krankenkass|cassa\s*malati|maternit|congedo|disocc|naspi|trasferim|residenz|mutuo|affitt|cas[ae])/i],
  ['lavoro',   /\b(stipend|salar|salaire|gehalt|lavoro|telelavoro|smart\s*working|datore|contrat|disoccupaz|crawler|assum)/i],
  ['mobilita', /\b(frontiera|valico|dogana|pendolar|trasport|treno|bus|auto|carbur|benzin|diesel|bordo|bord[ée]r|commut)/i],
  ['novita',   /\b(202\d|nuov[ao]|cambia|novit[àa]|incident|cronaca|sequestr|arrest|protest|sciopero)/i],
];

/**
 * Map an article (title + slug + excerpt) to a cluster name. Returns one of:
 * 'fiscale' | 'pensione' | 'pratico' | 'lavoro' | 'mobilita' | 'novita' | 'generic'.
 *
 * Pure function — safe to call from `aggregate()` when `meta.cluster` is null.
 */
export function inferClusterFromTitleAndSlug(title, slug, excerpt) {
  const blob = `${title || ''} ${slug || ''} ${excerpt || ''}`;
  for (const [name, rx] of CLUSTER_PATTERNS) {
    if (rx.test(blob)) return name;
  }
  return 'generic';
}
