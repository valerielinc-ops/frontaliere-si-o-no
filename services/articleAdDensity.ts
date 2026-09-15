/**
 * Ad-density profile per article format (issue #7336).
 *
 * `docs/ads-placement-longform.md` §3 specifies a reduced in-content density
 * for the longform format (3 in-content ads + the closing multiplex on a
 * 7-section piece) against the ~8 the short format targets. Until this module
 * existed the placement in `components/community/BlogArticles.tsx` had a single
 * pair of module constants — cap 8, gap 200 — with no format predicate at all,
 * so the spec stayed inapplicable while the corpus already contained the shape
 * it describes.
 *
 * The predicate is pure and lives outside the component so the two profiles can
 * be asserted without an i18n/router/Suspense render
 * (`tests/community/BlogArticles.longform-ad-density.test.tsx`).
 */

import { fnv1a32Mod } from '../scripts/lib/fnv1a.mjs';
import { countArticleBodyWords } from './articleBodySegments';
import {
  advanceMarkdownFence,
  markdownFenceFor,
  type MarkdownFence,
} from '../packages/articles/engine/shared/normalizeArticleMarkdown';

/** Number of `## ` sections from which an article is treated as longform. */
export const LONGFORM_MIN_H2_SECTIONS = 7;

/** Minimum body size for any inline ad to be eligible in the renderer. */
export const AD_ELIGIBLE_MIN_WORDS = 220;
export const AD_ELIGIBLE_MIN_CHARS = 1400;

/**
 * Word floor of the longform predicate. Deliberately the SAME floor as the
 * exported word floor used by `adEligible` in the renderer: a body under it
 * carries no inline ad at all, so the profile choice is decided by structure
 * (section count), never by shortening the reach of the ad-eligibility gate.
 */
export const LONGFORM_MIN_WORDS = AD_ELIGIBLE_MIN_WORDS;

export interface ArticleAdDensityProfile {
  /** Per-article cap on inline ads. */
  readonly inlineCap: number;
  /** Min words of content between two consecutive inline ads. */
  readonly minWordGap: number;
  /** True when the longform profile was selected. */
  readonly longform: boolean;
}

/**
 * Current (short-form) profile, unchanged since 2026-05-19: ~4 ads on a 1500w
 * article, ~7-8 on a 3000w one. Every non-longform article keeps exactly this
 * (AGENTS.md #7: no monetisation reduction on the current format).
 */
export const STANDARD_ARTICLE_AD_DENSITY: ArticleAdDensityProfile = {
  inlineCap: 8,
  minWordGap: 200,
  longform: false,
};

/**
 * Ceiling of the longform word gap — the spacing `docs/ads-placement-longform.md`
 * §4 calibrates on the corpus. See `longformWordGap` for why it is a ceiling
 * and not the value every longform article gets.
 */
export const LONGFORM_MAX_WORD_GAP = 300;

/**
 * Floor of the longform word gap. Deliberately the STANDARD profile's gap: the
 * longform profile may space its ads WIDER than the short format, never
 * tighter, so scaling the gap down for a short-segmented body can restore the
 * ads it lost but can never push it past the density it had before the profile
 * existed (AGENTS.md #7 in both directions).
 */
export const LONGFORM_MIN_WORD_GAP = STANDARD_ARTICLE_AD_DENSITY.minWordGap;

/**
 * Longform profile — `docs/ads-placement-longform.md` §3/§4: 3 in-content ads
 * (the closing `ARTICLE_END_MULTIPLEX` is placed by the component and is not
 * part of this cap), spread rather than clustered at the top. The wider gap is
 * what spreads them: with the standard 200 the cap alone would spend all three
 * on the first sections and leave the rest of the piece bare, which is the
 * opposite of the wireframe (ad after §1, §3, §5).
 *
 * 300, not more, is calibrated on the corpus rather than assumed: the median
 * longform `it` article is 1634 words over 3 body segments (the word credit
 * restarts on each segment), so a 500-word gap would starve it down to a mean
 * of 1.57 ads — BELOW the three the spec asks for, which would make this a
 * density cut instead of the specified profile. At 300 the mean is 2.75 and
 * 342 of the 402 longform articles land on exactly 3.
 *
 * `minWordGap` here is the CEILING of the gap, not a constant: a body whose
 * segments are too short to ever bank 300 words pays a reduced gap instead of
 * losing its ads — see `longformWordGap` and `resolveArticleAdDensity`.
 */
export const LONGFORM_ARTICLE_AD_DENSITY: ArticleAdDensityProfile = {
  inlineCap: 3,
  minWordGap: LONGFORM_MAX_WORD_GAP,
  longform: true,
};

/**
 * Words of body a longform segment must bank before an ad becomes eligible,
 * given the shape of THIS article (issue #7746).
 *
 * Why it cannot stay the constant 300: the renderer's word credit is
 * per-SEGMENT, not per-article — `renderFormattedContent` is called once per
 * body segment and `wordsSinceLastAd` restarts from 0 on every call. A longform
 * article of 900 words over 3 segments therefore offers ~300 words of credit
 * per segment and, needing 300 in a single segment to fire, lands on ONE
 * in-content ad or none, while carrying the ≥7 sections that make it longform.
 * Measured on the `it` corpus: 35 of the 401 ad-eligible longform articles sat
 * under 2 ads (4 at zero, 31 at one) — a tail the mean of 2.75 hid.
 *
 * The gap therefore scales with what a segment can actually pay: half the mean
 * segment length, so an ad has room to fire once per segment and still sit at a
 * section boundary rather than on top of the previous one.
 *
 * Both ends of the clamp are load-bearing:
 *   - ceiling `LONGFORM_MAX_WORD_GAP` (300) — an article whose segments are
 *     long enough keeps exactly today's spacing (108 of 401 are unchanged), so
 *     this is a floor for the starved tail, never a densification of the rest;
 *   - floor `LONGFORM_MIN_WORD_GAP` = the STANDARD profile's gap (200) — a
 *     longform article can never be spaced TIGHTER than the same body would be
 *     under the short-form profile. That is what keeps this from turning into a
 *     density increase on thin bodies: measured, no article ends up with more
 *     ads than the pre-#7336 standard profile gave it, and none with fewer than
 *     it has today (mean 2.75 → 2.95, articles under 2 ads 35 → 5).
 */
export function longformWordGap(segments: readonly string[]): number {
  const bodyParts = segments.filter(segment => segment && !segment.startsWith('blog.article.'));
  if (bodyParts.length === 0) return LONGFORM_MAX_WORD_GAP;
  const perSegment = Math.floor(countArticleBodyWords(bodyParts) / bodyParts.length / 2);
  return Math.min(LONGFORM_MAX_WORD_GAP, Math.max(LONGFORM_MIN_WORD_GAP, perSegment));
}

/**
 * Counts `## ` section headings the way the renderer sees them: blocks split on
 * the blank line, `### `/`#### ` excluded (a `## ` prefix test alone would
 * count them too). Same acceptance rule as the H2 branch of
 * `renderFormattedContent`, so the predicate can never disagree with the
 * boundaries the ads are actually placed on.
 */
export function countH2Sections(segments: readonly string[]): number {
  let count = 0;
  for (const segment of segments) {
    if (!segment || segment.startsWith('blog.article.')) continue;
    let fence: MarkdownFence | null = null;
    for (const block of segment.split('\n\n')) {
      const lines = block.split('\n');
      const wasInsideFence = fence !== null;
      const opensFence = !wasInsideFence && markdownFenceFor(lines[0]) !== null;
      fence = advanceMarkdownFence(lines, fence);
      if (wasInsideFence || opensFence) continue;
      if (block.trim().startsWith('## ')) count += 1;
    }
  }
  return count;
}

/**
 * True for the multi-section longform shape of `docs/ads-placement-longform.md`
 * §3 — ≥7 `## ` sections over a body past the ad-eligibility word floor.
 */
export function isLongformArticle(segments: readonly string[]): boolean {
  return countH2Sections(segments) >= LONGFORM_MIN_H2_SECTIONS
    && countArticleBodyWords(segments) >= LONGFORM_MIN_WORDS;
}

/**
 * Profile the inline placement must use for this body. The longform gap is
 * resolved per article (`longformWordGap`), so a short-segmented longform piece
 * keeps its ads instead of failing a gap its segments cannot pay (#7746).
 */
export function resolveArticleAdDensity(segments: readonly string[]): ArticleAdDensityProfile {
  if (!isLongformArticle(segments)) return STANDARD_ARTICLE_AD_DENSITY;
  const minWordGap = longformWordGap(segments);
  return minWordGap === LONGFORM_ARTICLE_AD_DENSITY.minWordGap
    ? LONGFORM_ARTICLE_AD_DENSITY
    : { ...LONGFORM_ARTICLE_AD_DENSITY, minWordGap };
}

/**
 * Start index of the inline slot rotation for THIS article (issue #7747).
 *
 * The rotation in `makeInlineAd` is `counter % slotTable.length` with the
 * counter starting at 0 and stopping at the profile cap. On the longform
 * profile the cap is 3 and the table holds 5 units, so indices 0,1,2 were the
 * only ones ever reached: `ARTICLE_INLINE_MOBILE_4` and `_5` took zero
 * impressions on the 402 longform `it` articles while carrying a configuration
 * identical to the other three (`fluid`/`in-article`, minHeight 220) — a fill
 * rate stuck at 0 that reads as a broken unit rather than as an unused one.
 *
 * Offsetting the START of the rotation per article moves WHICH unit serves
 * without touching HOW MANY ads are emitted (AGENTS.md #7): every article still
 * gets exactly `inlineCap` ads, and across the corpus all five units are
 * reached. The offset is a deterministic hash of the article id, not a random
 * draw, for three reasons: the same article always renders the same slots
 * across re-renders and across SSR/hydration (a random pick would mismatch the
 * server markup), the distribution over the corpus is uniform by construction,
 * and the audit can recompute the expected slot for any article offline.
 *
 * `fnv1a32Mod` is the shared hash of `scripts/lib/fnv1a.mjs` — the one place
 * this algorithm lives (AGENTS.md #6), not a fourth hand-rolled copy.
 */
export function inlineSlotRotationOffset(articleId: string, slotCount: number): number {
  if (!Number.isInteger(slotCount) || slotCount <= 0) return 0;
  return fnv1a32Mod(String(articleId ?? ''), slotCount);
}

/**
 * Index into the inline slot table for the `adIndex`-th in-content ad of this
 * article. Step stays 1 — consecutive ads on the same page keep serving
 * DIFFERENT units, exactly as before; only the starting point moves.
 */
export function inlineSlotIndex(articleId: string, adIndex: number, slotCount: number): number {
  if (!Number.isInteger(slotCount) || slotCount <= 0) return 0;
  return (inlineSlotRotationOffset(articleId, slotCount) + adIndex) % slotCount;
}
