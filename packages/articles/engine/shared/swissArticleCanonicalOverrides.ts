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
 *
 * GENERALISED TO EVERY ARTICLE SECTION (2026-08-09). The loader and both
 * resolvers below were always section-agnostic — only the call site in
 * `ogPagesPlugin.ts` was hardwired to `SECTION.name === 'svizzera'`, which
 * left the frontaliere section (the larger of the two) with no way to
 * consolidate a near-duplicate pair. The wiring now comes from each
 * section's `canonicalOverrides` candidate-path list
 * (`shared/canonicalOverrideFiles.mjs`, projected onto
 * `ARTICLE_SECTION_DESCRIPTORS`), so adding a section, or a second override
 * file, is data — not another copy of this module. The exported names keep
 * their `Swiss…` spelling on purpose: they are imported by four site test
 * files and by the mirrored engine, and renaming them would be churn with no
 * behavioural payload.
 *
 * WHY A CANDIDATE *LIST* AND NOT ONE PATH. The renderer runs in two repos
 * with different layouts, and the override map has to be found in both or it
 * silently degrades to `{}` — a green build that quietly stops consolidating.
 * This repo keeps `data/…`; the corpus repo (nanakokyobashi-rgb/frontaliere-articles,
 * which is what actually renders article pages since the 2026-08-02 cutover)
 * keeps its own `content/…`, and anything shipped inside
 * `packages/articles/engine/` lands there under `engine/`. Each path is tried
 * in order and the first one that reads wins.
 */
import type { readFileSync as ReadFileSync } from 'node:fs';

export interface CanonicalOverrideFs {
  readFileSync: typeof ReadFileSync;
}

/**
 * Loads a canonical-override map (shape:
 * `{ overrides: Record<slug, absoluteWinnerUrl> }`), keeping only string ->
 * absolute-http(s)-URL entries. Missing/malformed file degrades to `{}`
 * (safe default — never throws, never blocks the build).
 *
 * `overridePath` accepts a single path or an ordered candidate list; the
 * first path that reads AND parses wins, and a candidate that throws is
 * skipped rather than fatal (see the two-repo note in the module header).
 */
export function loadSwissArticleCanonicalOverrides(
  fs: CanonicalOverrideFs,
  overridePath: string | readonly string[],
): Record<string, string> {
  const candidates = typeof overridePath === 'string' ? [overridePath] : overridePath;
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
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
      // Try the next layout; only an exhausted list is a real miss.
    }
  }
  return {};
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
