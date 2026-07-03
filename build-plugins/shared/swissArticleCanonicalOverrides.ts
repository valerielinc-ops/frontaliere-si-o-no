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
 * Divergence from the job-plugin convention: overridden article slugs are
 * NOT dropped from the sitemap/RSS. Per issue #3010, the shadowed pages must
 * stay live and indexable-with-a-hint (repo anti-cut rule — no
 * removing/de-listing indexed pages without explicit per-URL owner
 * approval), only the canonical *hint* changes.
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
