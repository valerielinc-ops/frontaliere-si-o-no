/**
 * Pure helper that decides where to inject inline AdSense units between top-level
 * article body segments.
 *
 * Strategy (2026-05-19): max-density mode — auth-gate removed, every paragraph
 * inside the body now gets its own ad via the in-renderer hook in
 * BlogArticles.tsx. This module only handles the *inter-segment* boundary
 * (between body1 / body2 / ...). It places one ad at every boundary so the
 * fallback density never drops below "one ad between sections".
 *
 * No heading-safety check: the per-paragraph injector inside renderFormattedContent
 * is the dominant placer; inter-segment ads complement it.
 */

export const STEP_SEGMENTS = 1;
export const STEP_MIN_WORDS = 0;
/** Effectively uncapped — kept as an export for back-compat with any importers. */
export const MAX_INLINE_ADS = Number.MAX_SAFE_INTEGER;

export interface AdInsertionOptions {
 /** Legacy floor (kept for compatibility — no-op now that density is already maximal). */
 readonly minimumWhenEligible?: number;
}

/** Map of `segmentIndex` → ad position number (1-based). */
export type AdInsertionMap = ReadonlyMap<number, number>;

export interface AdInsertionPlan {
  readonly insertions: AdInsertionMap;
  readonly adsPlaced: number;
}

export function computeArticleAdSlots(
  segments: ReadonlyArray<string>,
  visibleSegmentCount: number,
  _options: AdInsertionOptions = {},
): AdInsertionPlan {
  const insertions = new Map<number, number>();
  const upperBound = Math.min(visibleSegmentCount, segments.length);

  let adsPlaced = 0;
  // Place an ad before every segment after the first. With STEP_SEGMENTS=1 /
  // STEP_MIN_WORDS=0 the trigger is unconditional.
  for (let i = 1; i < upperBound; i += 1) {
    adsPlaced += 1;
    insertions.set(i, adsPlaced);
  }

  return { insertions, adsPlaced };
}
