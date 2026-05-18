/**
 * Pure helper that decides where to inject inline AdSense units inside a blog article body.
 *
 * Strategy (chosen 2026-05-18): scalable density with a hybrid trigger —
 *   insert an inline ad when BOTH conditions hold since the previous ad:
 *     - at least STEP_SEGMENTS segments have passed, AND
 *     - at least STEP_MIN_WORDS words have been read.
 *
 * Heading-safe: never inserts immediately before or after a markdown heading block
 * so an H2/H3 is never visually orphaned from its body. Also never inserts before
 * the last visible segment (would look like a footer ad next to the end-card).
 *
 * Paywall-aware: walks only over `visibleSegmentCount` so no ad-request is wasted
 * inside content hidden behind the email gate.
 */

export const STEP_SEGMENTS = 2;
export const STEP_MIN_WORDS = 250;
export const MAX_INLINE_ADS = 5;

export interface AdInsertionOptions {
 /** When the hybrid trigger produces zero insertions but the article is
  *  ad-eligible upstream, force at least this many ads (placed at the earliest
  *  non-heading mid-article boundaries). Preserves pre-2026-05 behavior for the
  *  narrow band of articles that pass the upstream eligibility gate but sit
  *  below STEP_MIN_WORDS. */
 readonly minimumWhenEligible?: number;
}

/** Map of `segmentIndex` → ad position number (1-based, 1..MAX_INLINE_ADS). */
export type AdInsertionMap = ReadonlyMap<number, number>;

export interface AdInsertionPlan {
  readonly insertions: AdInsertionMap;
  readonly adsPlaced: number;
}

const HEADING_PREFIXES = ['## ', '### ', '#### '] as const;

function isHeadingBlock(segment: string | undefined): boolean {
  if (!segment) return false;
  const trimmed = segment.trimStart();
  return HEADING_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function countWords(segment: string): number {
  const trimmed = segment.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function computeArticleAdSlots(
  segments: ReadonlyArray<string>,
  visibleSegmentCount: number,
  options: AdInsertionOptions = {},
): AdInsertionPlan {
  const insertions = new Map<number, number>();
  const upperBound = Math.min(visibleSegmentCount, segments.length);

  let wordsSinceLastAd = 0;
  let segmentsSinceLastAd = 0;
  let adsPlaced = 0;

  for (let i = 0; i < upperBound; i += 1) {
    const segment = segments[i] ?? '';
    wordsSinceLastAd += countWords(segment);
    segmentsSinceLastAd += 1;

    const nextIdx = i + 1;
    if (nextIdx >= upperBound) break;
    if (adsPlaced >= MAX_INLINE_ADS) break;
    if (isHeadingBlock(segment)) continue;
    if (isHeadingBlock(segments[nextIdx])) continue;

    if (
      segmentsSinceLastAd >= STEP_SEGMENTS &&
      wordsSinceLastAd >= STEP_MIN_WORDS
    ) {
      adsPlaced += 1;
      insertions.set(nextIdx, adsPlaced);
      wordsSinceLastAd = 0;
      segmentsSinceLastAd = 0;
    }
  }

  const floor = Math.min(options.minimumWhenEligible ?? 0, MAX_INLINE_ADS);
  if (floor > 0 && adsPlaced < floor) {
    for (let i = 0; i < upperBound - 1 && adsPlaced < floor; i += 1) {
      const candidate = i + 1;
      if (insertions.has(candidate)) continue;
      if (isHeadingBlock(segments[i])) continue;
      if (isHeadingBlock(segments[candidate])) continue;
      adsPlaced += 1;
      insertions.set(candidate, adsPlaced);
    }
  }

  return { insertions, adsPlaced };
}
