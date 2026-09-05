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

/** Number of `## ` sections from which an article is treated as longform. */
export const LONGFORM_MIN_H2_SECTIONS = 7;

/**
 * Word floor of the longform predicate. Deliberately the SAME floor as
 * `adEligible` in the renderer (220 words): a body under it carries no inline
 * ad at all, so the profile choice is decided by structure (section count),
 * never by shortening the reach of the ad-eligibility gate itself.
 */
export const LONGFORM_MIN_WORDS = 220;

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
 */
export const LONGFORM_ARTICLE_AD_DENSITY: ArticleAdDensityProfile = {
  inlineCap: 3,
  minWordGap: 300,
  longform: true,
};

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
    for (const block of segment.split('\n\n')) {
      if (block.trim().startsWith('## ')) count += 1;
    }
  }
  return count;
}

/** Total words of the body, same tokenizer as the renderer's `countWordsIn`. */
function countWords(segments: readonly string[]): number {
  return segments.join(' ').split(/\s+/).filter(Boolean).length;
}

/**
 * True for the multi-section longform shape of `docs/ads-placement-longform.md`
 * §3 — ≥7 `## ` sections over a body past the ad-eligibility word floor.
 */
export function isLongformArticle(segments: readonly string[]): boolean {
  return countH2Sections(segments) >= LONGFORM_MIN_H2_SECTIONS
    && countWords(segments) >= LONGFORM_MIN_WORDS;
}

/** Profile the inline placement must use for this body. */
export function resolveArticleAdDensity(segments: readonly string[]): ArticleAdDensityProfile {
  return isLongformArticle(segments) ? LONGFORM_ARTICLE_AD_DENSITY : STANDARD_ARTICLE_AD_DENSITY;
}
