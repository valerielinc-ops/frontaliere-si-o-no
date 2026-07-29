/**
 * Per-slug canonical-override loader for svizzera-section blog articles
 * (issue #3010 item 1, follow-up to PR #3000 "de-collide duplicate svizzera
 * localized slugs"). Mirrors the cannibalization-fix pattern already used by
 * `build-plugins/jobsSeoPagesPlugin.ts` for `data/job-canonical-overrides.json`
 * (per-slug map, `<link rel="canonical">` + `og:url` point at a winner URL
 * instead of the page's own URL) — kept as a separate module/data file
 * because the article registry and URL shape differ, but the resolver
 * contract is intentionally the same shape so both call sites read the same
 * way.
 *
 * Per issue #3010, the shadowed pages must stay live and reachable at their
 * own URL (repo anti-cut rule — no removing/noindexing indexed pages
 * without explicit per-URL owner approval); this loader only changes the
 * canonical *hint*.
 *
 * CORRECTION (2026-07-03): the shadowed article's `<url>` block IS dropped
 * from `public/sitemap-blog-ch.xml` and `public/sitemap-news.xml` — the
 * same convention already used by `data/job-canonical-overrides.json` for
 * jobs (see `build-plugins/jobsSeoPagesPlugin.ts`). A sitemap `<loc>` whose
 * own page canonicalizes elsewhere is a hard CI gate failure
 * (`scripts/audit-sitemap-canonicals.mjs` / `scripts/validate-sitemap-pages.mjs`,
 * "Sitemap <loc> URLs MUST self-canonicalize") with no override exception,
 * so listing a shadowed slug in the sitemap is never correct regardless of
 * the anti-cut rule — the page stays live, it is just not advertised in the
 * sitemap. RSS feeds (`public/rss-svizzera*.xml`) are intentionally left
 * untouched: there is no equivalent self-canonical gate for RSS items, and
 * normal RSS semantics list all published items regardless of canonical
 * hint.
 */
import type { readFileSync as ReadFileSync } from 'node:fs';

export interface CanonicalOverrideFs {
  readFileSync: typeof ReadFileSync;
}

/**
 * Loads `data/swiss-article-canonical-overrides.json` (shape:
 * `{ overrides: Record<slug, absoluteWinnerUrl> }`), keeping only string ->
 * absolute-http(s)-URL entries. Missing/malformed file degrades to `{}`
 * (safe default — never throws, never blocks the build).
 */
export function loadSwissArticleCanonicalOverrides(
  fs: CanonicalOverrideFs,
  overridePath: string,
): Record<string, string> {
  try {
    const raw = fs.readFileSync(overridePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const map = parsed?.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {};
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof k === 'string' && typeof v === 'string' && v.startsWith('http')) {
        cleaned[k] = v;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

/**
 * Resolves the effective canonical/og:url URL for a page given its own
 * slug: returns the override target when the slug is a known shadowed
 * variant, otherwise returns `defaultUrl` (the page's own URL — normal
 * self-canonical behavior, including for the authoritative/winner variant
 * of each pair, which has no entry in the map).
 */
export function resolveSwissArticleCanonicalUrl(
  slug: string,
  overrides: Readonly<Record<string, string>>,
  defaultUrl: string,
): string {
  return overrides[slug] || defaultUrl;
}

/**
 * Issue #3368 item 1: a shadowed article's own slug is deliberately absent
 * from `sitemap-blog-ch.xml` (see the CORRECTION note above), so a
 * `<lastmod>`-derived JSON-LD `dateModified` fallback keyed on the page's
 * own slug always misses for shadowed pages. Since the shadowed and
 * authoritative pages are a near-duplicate pair about the same content,
 * the authoritative winner's still-present sitemap `<lastmod>` is a valid
 * freshness proxy — this resolves the winner's own slug (last URL path
 * segment) from the same override map already loaded for canonical/og:url,
 * so callers can look it up in `sitemapLastmodBySlug` instead of falling
 * straight through to a static SEO-literal date. Returns `undefined` for a
 * non-shadowed slug (no override entry).
 */
export function resolveShadowedArticleWinnerSlug(
  slug: string,
  overrides: Readonly<Record<string, string>>,
): string | undefined {
  const winnerUrl = overrides[slug];
  if (!winnerUrl) return undefined;
  return winnerUrl.replace(/\/$/, '').split('/').pop() || undefined;
}
