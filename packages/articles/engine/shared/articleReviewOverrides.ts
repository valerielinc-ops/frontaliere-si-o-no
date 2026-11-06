/**
 * Per-article expert-review signal (`reviewedBy` JSON-LD) for fiscal/legal
 * (YMYL) articles — issue #6337, follow-up to PR #6326 "topical authority".
 *
 * There was no mechanism at all to express "an expert reviewed this
 * article" (`grep -rn "reviewedBy" packages/` was 0 hits before this file),
 * so PR #6326 correctly left the field unset rather than fabricate a trust
 * signal. This loader reads a small `articleId -> reviewerAuthorSlug` map
 * that starts empty (`{}`) — no article is marked reviewed until an editor
 * adds an entry by hand. VISION.md ordine di valore #4 forbids fabricated
 * trust signals, so the map defaulting to `{}` (nothing reviewed) rather
 * than guessing is the point, not a placeholder to fill in later.
 *
 * Ships engine-local (`packages/articles/engine/shared/…`), same reasoning
 * as the `frontaliere` entry in `canonicalOverrideFiles.mjs`: article pages
 * are rendered by the corpus repo (nanakokyobashi-rgb/frontaliere-articles)
 * since the 2026-08-02 cutover, and `mirror-articles-engine.yml` only
 * carries `packages/articles/engine/**` — a file under `data/` would never
 * reach the renderer that actually matters.
 *
 * CANDIDATE LIST, not a single path — same reason as
 * `loadSwissArticleCanonicalOverrides`. `mirror-articles-engine.yml` does
 * `cp -R packages/articles/engine "$work/engine"`, so in the corpus repo
 * this file lands at `engine/shared/article-reviewed-by.json`, NOT under
 * `packages/articles/…`. A single hardcoded `packages/articles/…` path
 * degrades silently to `{}` in the repo that actually renders the pages —
 * the whole feature is a no-op there. The call site tries both layouts in
 * order; the first one that reads wins.
 */
import type { readFileSync as ReadFileSync } from 'node:fs';

export interface ArticleReviewOverridesFs {
  readFileSync: typeof ReadFileSync;
}

/**
 * Loads the review-override map (shape: `Record<articleId, reviewerAuthorSlug>`),
 * keeping only string -> string entries. Missing/malformed file degrades to
 * `{}` (safe default — never throws, never blocks the build, never implies
 * a review that didn't happen).
 *
 * `overridePath` accepts a single path or an ordered candidate list (see the
 * two-repo note in the module header); the first candidate that reads AND
 * parses wins, and a candidate that throws is skipped rather than fatal.
 */
export function loadArticleReviewOverrides(
  fs: ArticleReviewOverridesFs,
  overridePath: string | readonly string[],
): Record<string, string> {
  const candidates = typeof overridePath === 'string' ? [overridePath] : overridePath;
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw);
      const cleaned: Record<string, string> = {};
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof k === 'string' && typeof v === 'string') {
            cleaned[k] = v;
          }
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
 * Resolves the reviewer's author slug for an article, or `undefined` when
 * the article has no entry (not reviewed — the default for every article).
 */
export function resolveArticleReviewerSlug(
  articleId: string,
  overrides: Readonly<Record<string, string>>,
): string | undefined {
  return overrides[articleId];
}
