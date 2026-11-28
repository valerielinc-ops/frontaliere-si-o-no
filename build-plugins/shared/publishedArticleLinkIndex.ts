/**
 * Reads the article index used for reverse links (F6.3c) from the PUBLISHED
 * corpus API over HTTP — the site/corpus boundary is HTTP, never an import.
 *
 * Sources (all under ARTICLES_API_BASE, the same surface pull-articles-api.mjs
 * consumes):
 *   - manifest.json                          commit pin (read before and after)
 *   - slugs.json                             id → per-locale slug, per section
 *   - data/blog-index-<section>-<locale>.json  localized titles + dates (recent window)
 *   - sitemap-blog.xml, sitemap-blog-ch.xml, sitemap-articles-canton-*.xml
 *                                            the set of INDEXABLE urls: an article is
 *                                            linkable only when its url is listed there
 *
 * Fail-soft: any failure returns null and callers keep their previous
 * behaviour. Offline modes: `ARTICLE_LINKS_API_DIR` (a local mirror of the API
 * layout, used by tests and measurements) and `ARTICLE_LINKS_OFFLINE=1`.
 * Under vitest nothing is fetched unless a mirror dir is given.
 */
import fs from 'node:fs';
import np from 'node:path';
import { ARTICLE_SECTION_CORE_ALL } from './articleSectionCore.mjs';
import { LINK_LOCALES, type ArticleLinkIndex, type LinkArticle, type LinkLocale } from './relevantArticleLinks';

// Same default as scripts/lib/articles-api-base.mjs (plugins must not import scripts/).
const DEFAULT_API_BASE = 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPTS = 3;
const CONCURRENCY = 8;
const USER_AGENT = 'frontaliere-site-build/1.0 (article link index)';

interface SectionCore {
  section: string;
  canton?: string;
  indexSlug: Record<LinkLocale, string>;
}

type Reader = (rel: string) => Promise<string>;

function makeReader(): Reader | null {
  const dir = process.env.ARTICLE_LINKS_API_DIR;
  if (dir) return async (rel) => fs.readFileSync(np.join(dir, rel), 'utf8');
  if (process.env.ARTICLE_LINKS_OFFLINE === '1' || process.env.VITEST) return null;
  const base = (process.env.ARTICLES_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  return async (rel) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(`${base}/${rel}`, {
          headers: { 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`${rel}: ${(lastErr as Error)?.message ?? lastErr}`);
  };
}

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Paths (no origin) of every <loc> and hreflang href in a sitemap. */
export function sitemapPaths(xml: string): Set<string> {
  const out = new Set<string>();
  const rx = /(?:<loc>|href=")https?:\/\/[^/<"]+(\/[^<"]*)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(xml)) !== null) out.add(m[1]);
  return out;
}

const sectionList = (): SectionCore[] =>
  Object.values(ARTICLE_SECTION_CORE_ALL as Record<string, SectionCore>);

interface IndexEntry { id?: string; title?: string; date?: string }

/** Pure assembly step (also used by tests and the measurement script). */
export function assembleArticleLinkIndex(input: {
  commit: string;
  slugs: { blog?: Record<string, Record<string, string>>; swiss?: Record<string, Record<string, string>>; cantons?: Record<string, Record<string, Record<string, string>>> };
  /** section → locale → index entries */
  entries: Record<string, Partial<Record<LinkLocale, IndexEntry[]>>>;
  indexable: Set<string>;
}): ArticleLinkIndex {
  const byLocale: Record<LinkLocale, LinkArticle[]> = { it: [], en: [], de: [], fr: [] };
  for (const core of sectionList()) {
    const slugTable =
      core.section === 'frontaliere' ? input.slugs.blog
      : core.section === 'svizzera' ? input.slugs.swiss
      : input.slugs.cantons?.[core.section];
    if (!slugTable) continue;
    for (const locale of LINK_LOCALES) {
      const prefix = locale === 'it' ? '' : `/${locale}`;
      for (const e of input.entries[core.section]?.[locale] ?? []) {
        const id = String(e.id ?? '');
        const title = String(e.title ?? '').trim();
        const date = String(e.date ?? '');
        const slug = slugTable[id]?.[locale];
        if (!id || !title || !date || !slug) continue;
        const href = `${prefix}/${core.indexSlug[locale]}/${slug}/`;
        if (!input.indexable.has(href)) continue;
        byLocale[locale].push({ id, section: core.section, canton: core.canton ?? null, title, date, href });
      }
    }
  }
  for (const locale of LINK_LOCALES) {
    byLocale[locale].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  }
  return { commit: input.commit, byLocale };
}

async function loadOnce(read: Reader): Promise<ArticleLinkIndex> {
  const manifest = JSON.parse(await read('manifest.json'));
  const slugs = JSON.parse(await read('slugs.json'));
  const sections = sectionList();
  const sitemapFiles = [
    'sitemap-blog.xml',
    'sitemap-blog-ch.xml',
    ...sections.filter((s) => s.canton).map((s) => `sitemap-articles-${s.section}.xml`),
  ];
  const indexJobs = sections.flatMap((s) => LINK_LOCALES.map((l) => ({ section: s.section, locale: l })));
  const [maps, idx] = await Promise.all([
    mapLimit(sitemapFiles, CONCURRENCY, async (f) => sitemapPaths(await read(f))),
    mapLimit(indexJobs, CONCURRENCY, async (j) => {
      const doc = JSON.parse(await read(`data/blog-index-${j.section}-${j.locale}.json`));
      return { ...j, articles: (Array.isArray(doc?.articles) ? doc.articles : []) as IndexEntry[] };
    }),
  ]);
  const indexable = new Set<string>();
  for (const m of maps) for (const p of m) indexable.add(p);
  const entries: Record<string, Partial<Record<LinkLocale, IndexEntry[]>>> = {};
  for (const j of idx) (entries[j.section] ??= {})[j.locale] = j.articles;
  const after = JSON.parse(await read('manifest.json'));
  if (after.commit !== manifest.commit) throw new Error('corpus API moved while reading');
  return assembleArticleLinkIndex({ commit: String(manifest.commit), slugs, entries, indexable });
}

let memo: Promise<ArticleLinkIndex | null> | null = null;

/** Loads (once per process) the article index; null when unavailable. */
export function loadArticleLinkIndex(): Promise<ArticleLinkIndex | null> {
  if (memo) return memo;
  const read = makeReader();
  if (!read) return (memo = Promise.resolve(null));
  memo = (async () => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const index = await loadOnce(read);
        const total = LINK_LOCALES.reduce((n, l) => n + index.byLocale[l].length, 0);
        console.log(`[article-links] index @ ${index.commit.slice(0, 10)}: ${total} indexable links across 4 locales`);
        return index;
      } catch (err) {
        console.warn(`[article-links] attempt ${attempt} failed: ${(err as Error).message}`);
      }
    }
    console.warn('[article-links] index unavailable — keeping the previous article blocks');
    return null;
  })();
  return memo;
}

/** Test hook. */
export function resetArticleLinkIndexForTests(): void {
  memo = null;
}
