/**
 * Runtime article overlay — the last link that made a new article wait for a
 * site deploy.
 *
 * The blog list is rendered from `data/blog-articles-data.ts` and the
 * `blog-meta-*` chunks, both COMPILED INTO THIS BUNDLE. Articles are generated
 * and published by nanakokyobashi-rgb/frontaliere-articles, which pushes each
 * one to its shard within a minute — so its own URL is live immediately, while
 * the hub, the archive and the homepage kept showing the set this build knew
 * about. Measured 2026-08-03: fourteen articles live at their own URL, present
 * in the sitemaps and the RSS, and the hub's newest entry dated 2026-07-29.
 *
 * This fetches the index that repo now publishes and merges anything the
 * bundle lacks. Same shape as the jobs index this app already fetches
 * (`/data/jobs-<locale>-index.json`), so it is a data read, not a new
 * mechanism.
 *
 * FAIL-OPEN, and that is the point. A missing file, a bad status, malformed
 * JSON, a slow network or a shape that does not match all resolve to "no
 * overlay", and the caller renders exactly what it renders today. The overlay
 * can only ADD articles the bundle does not have and can only FILL titles that
 * are absent — it never overwrites what this build shipped, so a stale index
 * cannot rewrite a published page's metadata. Optional trust metadata is
 * filled when a legacy bundled row does not have it, but is never replaced.
 */

import { cdnDataUrl, cdnFreshUrl } from '@/services/cdnDataBase';
import { mergeArticleMetaOverlay } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import type { ArticleSection } from '@/services/articleSections';
import { getAuthorBySlug } from '@/data/authors';
import type { Article } from '@/packages/articles/content/blog-articles-data';

/** Mirrors one entry of the published index; every field beyond id/title optional. */
export interface OverlayArticle {
  id: string;
  title: string;
  excerpt?: string;
  category?: string;
  date?: string;
  updatedAt?: string;
  image?: string;
  hasCalculator?: boolean;
  authorSlug?: string;
  /** Per-article display name; falls back to the local author registry by slug. */
  authorName?: string;
  /**
   * Provenance of this article's draft, when the publisher declares it. The
   * articles this overlay adds are exactly the ones this build does NOT ship,
   * so without a passthrough here the declaration would be dead for the
   * freshest articles — the population the transparency disclosure is most
   * likely to get wrong. `mergeOverlay` spreads the entry as-is, so declaring
   * the field is all that is needed. See `services/articleProvenance.ts`.
   */
  aiAssisted?: boolean;
  /**
   * The article's slug for THIS index's locale, when the publisher emits one.
   * Optional and forward-looking: with it the list can link a brand-new
   * article without asking for the ~550 KB slugs.json (see the mount effect in
   * components/community/BlogArticles.tsx).
   */
  slug?: string;
  /** Optional corpus classification fields carried by newer indexes. */
  articleType?: 'news' | 'evergreen';
  canton?: string[];
}

export type OverlaySection = ArticleSection;

const ARTICLE_CATEGORIES = new Set<Article['category']>(['fiscale', 'pratico', 'novita', 'pensione']);

/** Convert a published overlay row into the article shape consumed by the SPA. */
export function articleFromOverlay(entry: OverlayArticle): Article {
  const category = ARTICLE_CATEGORIES.has(entry.category as Article['category'])
    ? entry.category as Article['category']
    : 'novita';
  const authorSlug = typeof entry.authorSlug === 'string' ? entry.authorSlug.trim() || undefined : undefined;
  const declaredAuthorName = typeof entry.authorName === 'string' ? entry.authorName.trim() : '';
  const authorName = declaredAuthorName
    || (authorSlug ? getAuthorBySlug(authorSlug)?.name : undefined);
  return {
    id: entry.id,
    category,
    date: entry.date || '',
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    image: entry.image || '/images/places/lugano.webp',
    hasCalculator: entry.hasCalculator === true,
    ...(entry.articleType ? { articleType: entry.articleType } : {}),
    ...(authorSlug ? { authorSlug } : {}),
    ...(authorName ? { authorName } : {}),
    ...(typeof entry.aiAssisted === 'boolean' ? { aiAssisted: entry.aiAssisted } : {}),
    ...(entry.canton ? { canton: entry.canton } : {}),
  };
}

/** Beyond this the fetch is abandoned — a blog list must not wait on it. */
const TIMEOUT_MS = 4000;

function isUsable(a: unknown): a is OverlayArticle {
  if (typeof a !== 'object' || a === null) return false;
  const r = a as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0
      && typeof r.title === 'string' && r.title.length > 0;
}

interface OverlayIndex {
  articles: OverlayArticle[];
  total: number;
  oldest: string | null;
}

/** One fetch of a published index URL. `null` on any problem. */
async function fetchIndexUrl(url: string): Promise<OverlayIndex | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json() as { articles?: unknown; total?: unknown; oldest?: unknown };
    if (!Array.isArray(body?.articles)) return null;
    return {
      articles: body.articles.filter(isUsable),
      total: typeof body.total === 'number' ? body.total : 0,
      oldest: typeof body.oldest === 'string' ? body.oldest : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read both cache identities of an index and union them by id.
 *
 * The rotating URL bounds a stale unpurged browser variant, while the bare URL
 * is the one the publisher purges. Neither is always fresher: run 38079614519
 * served an updated bare `de`/`fr` index while the current rotating bucket was
 * still ten minutes old. Reading only either identity can therefore drop a
 * just-published article. A failure of one remains fail-open through the other.
 */
async function fetchIndex(path: string): Promise<OverlayIndex | null> {
  const bareUrl = cdnDataUrl(path);
  const variants = (await Promise.all([
    fetchIndexUrl(bareUrl),
    fetchIndexUrl(cdnFreshUrl(bareUrl)),
  ])).filter((index): index is OverlayIndex => index !== null);
  if (variants.length === 0) return null;

  const articles: OverlayArticle[] = [];
  const seen = new Set<string>();
  for (const index of variants) {
    for (const article of index.articles) {
      if (seen.has(article.id)) continue;
      seen.add(article.id);
      articles.push(article);
    }
  }

  const oldest = variants
    .map((index) => index.oldest)
    .filter((value): value is string => value !== null)
    .sort()[0] ?? null;
  return {
    articles,
    total: Math.max(...variants.map((index) => index.total)),
    oldest,
  };
}

/**
 * Fetch the overlay for one section+locale. Resolves to `[]` on any problem.
 *
 * `bundledCount` — how many articles this build shipped — turns the published
 * window from a contract into a fast path. The publisher caps the recent index
 * at 150 entries, which was sized against how often the site deploys; when
 * deploys stall (2026-08-03 → 04) the bundle stops advancing while articles
 * keep publishing, and anything older than the window and newer than the
 * bundle falls into neither. Those articles are live at their own URL and
 * invisible in every list, and nothing reports it.
 *
 * So: if the window provably cannot close the gap — the bundle plus the whole
 * window still totals less than the corpus — fetch the complete index instead.
 * On the common path (`bundledCount` current) the comparison is false and not
 * a byte more is downloaded. Omit `bundledCount` to keep the old behaviour.
 */
export async function fetchArticleOverlay(
  section: OverlaySection,
  locale: Locale,
  bundledCount?: number,
  bundledNewest?: string,
): Promise<OverlayArticle[]> {
  const recent = await fetchIndex(`/data/blog-index-${section}-${locale}.json`);
  if (!recent) return [];

  // Two independent triggers, because the count on its own has a blind spot.
  //
  // The count estimates the gap as `total - bundledCount`, but the real gap is
  // against the INTERSECTION: ids this build ships that the corpus has since
  // dropped inflate `bundledCount` and mask a genuine shortfall. The date test
  // has no such blind spot — if this build's newest article predates the
  // window's oldest entry, the window starts after the bundle ends and there
  // is provably something in between, whatever the counts say. `oldest` is
  // published for exactly this.
  const countSaysGap =
    typeof bundledCount === 'number' && bundledCount + recent.articles.length < recent.total;
  const dateSaysGap =
    typeof bundledNewest === 'string' && recent.oldest !== null && bundledNewest < recent.oldest;

  if (countSaysGap || dateSaysGap) {
    const full = await fetchIndex(`/data/blog-index-${section}-${locale}-full.json`);
    // Still fail-open: a missing or malformed full index leaves the window's
    // entries in place rather than dropping the overlay altogether.
    if (full && full.articles.length > recent.articles.length) return full.articles;
  }
  return recent.articles;
}

/**
 * Merge an overlay into a bundled registry.
 *
 * Returns the merged list plus how many entries were genuinely new, so a
 * caller can skip a state update that would change nothing. Titles and
 * excerpts go into the i18n store under the same keys the bundled chunks use,
 * so every existing `t('blog.article.<id>.title')` call site keeps working
 * with no change.
 *
 * `known` is matched on `id`. An overlay entry whose id the bundle already has
 * cannot replace the bundled title or content, but it may fill trust metadata
 * that a legacy bundle did not carry yet.
 */
export function mergeOverlay<T extends { id: string }>(
  bundled: readonly T[],
  overlay: readonly OverlayArticle[],
  locale: Locale,
): { articles: T[]; added: number; updated: number } {
  if (overlay.length === 0) return { articles: bundled as T[], added: 0, updated: 0 };

  const known = new Set(bundled.map((a) => a.id));
  const fresh = overlay.filter((a) => !known.has(a.id));

  // A row already shipped in the bundle remains authoritative for title and
  // content. It is not authoritative for optional trust metadata that was
  // introduced after that build, though: dropping the whole overlay row here
  // made an explicit `aiAssisted` declaration disappear on hydration. Fill
  // only fields whose bundled value is absent or malformed, using the same
  // author-registry fallback as fresh overlay rows.
  const overlayById = new Map(overlay.map((entry) => [entry.id, entry]));
  let updated = 0;
  const enrichedBundled = bundled.map((article) => {
    const entry = overlayById.get(article.id);
    if (!entry) return article;

    const candidate = articleFromOverlay(entry);
    const patch: Partial<Pick<OverlayArticle, 'authorSlug' | 'authorName' | 'aiAssisted'>> = {};
    const current = article as T & Pick<OverlayArticle, 'authorSlug' | 'authorName' | 'aiAssisted'>;
    if ((typeof current.authorSlug !== 'string' || !current.authorSlug.trim()) && candidate.authorSlug) {
      patch.authorSlug = candidate.authorSlug;
    }
    if ((typeof current.authorName !== 'string' || !current.authorName.trim()) && candidate.authorName) {
      patch.authorName = candidate.authorName;
    }
    if (typeof current.aiAssisted !== 'boolean' && typeof candidate.aiAssisted === 'boolean') {
      patch.aiAssisted = candidate.aiAssisted;
    }
    if (Object.keys(patch).length === 0) return article;
    updated += 1;
    return { ...article, ...patch } as T;
  });

  if (fresh.length === 0 && updated === 0) return { articles: bundled as T[], added: 0, updated: 0 };

  const translations: Record<string, string> = {};
  for (const a of fresh) {
    translations[`blog.article.${a.id}.title`] = a.title;
    if (a.excerpt) translations[`blog.article.${a.id}.excerpt`] = a.excerpt;
  }
  mergeArticleMetaOverlay(locale, translations);
  // Italian is the fallback locale every list cell falls back to when a
  // localized key is missing, so seed it too when we are elsewhere.
  if (locale !== 'it') mergeArticleMetaOverlay('it', translations);

  // Newest first, matching how the index is published and how a list reads.
  const merged = [...(fresh as unknown as T[]), ...enrichedBundled];
  return { articles: merged, added: fresh.length, updated };
}
