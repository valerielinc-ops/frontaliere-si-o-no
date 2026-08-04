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
 * cannot rewrite a published page's metadata.
 */

import { cdnDataUrl } from '@/services/cdnDataBase';
import { mergeArticleMetaOverlay } from '@/services/i18n';
import type { Locale } from '@/services/i18n';

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
}

export type OverlaySection = 'frontaliere' | 'svizzera';

/** Beyond this the fetch is abandoned — a blog list must not wait on it. */
const TIMEOUT_MS = 4000;

function isUsable(a: unknown): a is OverlayArticle {
  if (typeof a !== 'object' || a === null) return false;
  const r = a as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0
      && typeof r.title === 'string' && r.title.length > 0;
}

/**
 * Fetch the overlay for one section+locale. Resolves to `[]` on any problem.
 */
export async function fetchArticleOverlay(
  section: OverlaySection,
  locale: Locale,
): Promise<OverlayArticle[]> {
  const url = cdnDataUrl(`/data/blog-index-${section}-${locale}.json`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    const articles = (body as { articles?: unknown })?.articles;
    if (!Array.isArray(articles)) return [];
    return articles.filter(isUsable);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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
 * is dropped whole: this build's own record is authoritative for anything it
 * shipped.
 */
export function mergeOverlay<T extends { id: string }>(
  bundled: readonly T[],
  overlay: readonly OverlayArticle[],
  locale: Locale,
): { articles: T[]; added: number } {
  if (overlay.length === 0) return { articles: bundled as T[], added: 0 };

  const known = new Set(bundled.map((a) => a.id));
  const fresh = overlay.filter((a) => !known.has(a.id));
  if (fresh.length === 0) return { articles: bundled as T[], added: 0 };

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
  const merged = [...(fresh as unknown as T[]), ...bundled];
  return { articles: merged, added: fresh.length };
}
