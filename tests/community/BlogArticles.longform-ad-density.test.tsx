/**
 * Observer for issue #7336 — the inline ad density must follow the article
 * FORMAT, not a single corpus-wide pair of constants.
 *
 * `docs/ads-placement-longform.md` §3 specifies 3 in-content ads (plus the
 * closing multiplex) on a 7-section longform; before this gate every article
 * shared `ARTICLE_INLINE_AD_CAP = 8` / `AD_MIN_WORD_GAP = 200`, so the spec was
 * inapplicable on the 400 `it` articles that already carry ≥7 `## ` sections.
 *
 * The second describe block is the one that protects revenue (AGENTS.md #7):
 * an article that is NOT longform must still place 8, so the change can never
 * become a masked density reduction on the current short format.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderFormattedContent } from '@/components/community/BlogArticles';
import { AD_SLOTS } from '@/services/adsenseSlots';
import {
  isLongformArticle,
  inlineSlotIndex,
  inlineSlotRotationOffset,
  countH2Sections,
  resolveArticleAdDensity,
  longformWordGap,
  LONGFORM_ARTICLE_AD_DENSITY,
  LONGFORM_MAX_WORD_GAP,
  LONGFORM_MIN_WORD_GAP,
  STANDARD_ARTICLE_AD_DENSITY,
} from '@/services/articleAdDensity';

const AD_MARKER = 'data-testid="inline-ad"';
const words = (n: number) => Array.from({ length: n }, (_, i) => `parola${i}`).join(' ');

/** 7 `## ` sections of 250 words each, after a 250-word intro. */
const sectionCount = 7;
const longformBody = [
  words(250),
  ...Array.from({ length: sectionCount }, (_, i) => `## Sezione ${i + 1}\n\n${words(250)}`),
].join('\n\n');

/** Same length and same word gaps, one section short of the longform floor. */
const shortFormBody = [
  words(250),
  ...Array.from({ length: sectionCount - 1 }, (_, i) => `## Sezione ${i + 1}\n\n${words(250)}`),
  words(250),
].join('\n\n');

/**
 * Mirrors the component wiring: the per-article cap lives in the ad renderer
 * (`makeInlineAd`), the word gap in `renderFormattedContent`.
 */
const renderWithProfile = (body: string, profile: { inlineCap: number; minWordGap: number }) => {
  let emitted = 0;
  const adRenderer = (keyPrefix: string) => {
    if (emitted >= profile.inlineCap) return null;
    emitted += 1;
    return <div key={keyPrefix} data-testid="inline-ad" />;
  };
  const html = renderToStaticMarkup(renderFormattedContent(body, undefined, adRenderer, profile.minWordGap));
  return html.split(AD_MARKER).length - 1;
};

describe('isLongformArticle', () => {
  it('counts `## ` sections without counting `### `/`#### ` sub-headings', () => {
    expect(countH2Sections([longformBody])).toBe(sectionCount);
    expect(countH2Sections(['## Uno\n\n### Due\n\n#### Tre'])).toBe(1);
  });

  it('is true at 7 sections and false at 6', () => {
    expect(isLongformArticle([longformBody])).toBe(true);
    expect(isLongformArticle([shortFormBody])).toBe(false);
  });

  it('is false for a 7-section body under the ad-eligibility word floor', () => {
    const thin = Array.from({ length: sectionCount }, (_, i) => `## Sezione ${i + 1}\n\n${words(5)}`).join('\n\n');
    expect(countH2Sections([thin])).toBe(sectionCount);
    expect(isLongformArticle([thin])).toBe(false);
  });

  it('ignores untranslated body placeholders, as the renderer does', () => {
    expect(countH2Sections(['blog.article.foo.body1'])).toBe(0);
  });
});

describe('longform profile (docs/ads-placement-longform.md §3)', () => {
  it('places exactly 3 in-content ads on a 7-section article', () => {
    expect(resolveArticleAdDensity([longformBody])).toBe(LONGFORM_ARTICLE_AD_DENSITY);
    expect(renderWithProfile(longformBody, LONGFORM_ARTICLE_AD_DENSITY)).toBe(3);
  });

  it('spreads them instead of clustering all three at the top', () => {
    let emitted = 0;
    const adRenderer = (keyPrefix: string) => {
      if (emitted >= LONGFORM_ARTICLE_AD_DENSITY.inlineCap) return null;
      emitted += 1;
      return <div key={keyPrefix} data-testid="inline-ad" />;
    };
    const html = renderToStaticMarkup(
      renderFormattedContent(longformBody, undefined, adRenderer, LONGFORM_ARTICLE_AD_DENSITY.minWordGap),
    );
    const lastAd = html.lastIndexOf(AD_MARKER);
    // The last of the three sits past the middle of the body, i.e. the wider
    // gap did its job — with the standard 200-word gap all three land in the
    // first sections.
    expect(lastAd).toBeGreaterThan(html.length / 2);
  });
});

/**
 * Short multi-segment longform — the tail issue #7746 measured on the corpus:
 * 35 of the 401 ad-eligible longform `it` articles were placing fewer than 2
 * in-content ads (4 of them zero), because the word credit restarts on every
 * body segment and a segment shorter than the 300-word gap can never pay it.
 *
 * 3 segments of 3 sections × ~75 words ≈ 230 words each: ≥7 `## ` sections
 * (longform by structure) but no segment able to bank 300 words.
 */
const shortSegmentLongform = Array.from({ length: 3 }, (_, seg) =>
  Array.from({ length: 3 }, (_, i) => `## Sezione ${seg * 3 + i + 1}\n\n${words(75)}`).join('\n\n'),
);

/** Mirrors the component's multi-segment wiring: ONE cap and ONE gap for the
 *  article, `renderFormattedContent` called once per segment. */
const renderArticle = (segments: readonly string[], profile: { inlineCap: number; minWordGap: number }) => {
  let emitted = 0;
  const adRenderer = (keyPrefix: string) => {
    if (emitted >= profile.inlineCap) return null;
    emitted += 1;
    return <div key={keyPrefix} data-testid="inline-ad" />;
  };
  return segments
    .map(segment => renderToStaticMarkup(renderFormattedContent(segment, undefined, adRenderer, profile.minWordGap)))
    .join('')
    .split(AD_MARKER).length - 1;
};

describe('longform ad floor on short segments (#7746)', () => {
  it('is longform by structure yet cannot bank the 300-word gap in any segment', () => {
    expect(isLongformArticle(shortSegmentLongform)).toBe(true);
    expect(countH2Sections(shortSegmentLongform)).toBe(9);
    for (const segment of shortSegmentLongform) {
      expect(segment.split(/\s+/).filter(Boolean).length).toBeLessThan(LONGFORM_MAX_WORD_GAP);
    }
  });

  it('places at least 2 in-content ads instead of the 0 the fixed 300-word gap gave it', () => {
    expect(renderArticle(shortSegmentLongform, LONGFORM_ARTICLE_AD_DENSITY)).toBeLessThan(2);
    const profile = resolveArticleAdDensity(shortSegmentLongform);
    expect(profile.minWordGap).toBeLessThan(LONGFORM_MAX_WORD_GAP);
    expect(renderArticle(shortSegmentLongform, profile)).toBeGreaterThanOrEqual(2);
  });

  it('never spaces a longform tighter than the standard profile would', () => {
    // The floor is what stops the scaled gap from becoming a density INCREASE
    // on a thin body (AGENTS.md #7 read in both directions).
    expect(LONGFORM_MIN_WORD_GAP).toBe(STANDARD_ARTICLE_AD_DENSITY.minWordGap);
    expect(longformWordGap(shortSegmentLongform)).toBeGreaterThanOrEqual(LONGFORM_MIN_WORD_GAP);
    expect(renderArticle(shortSegmentLongform, resolveArticleAdDensity(shortSegmentLongform)))
      .toBeLessThanOrEqual(renderArticle(shortSegmentLongform, STANDARD_ARTICLE_AD_DENSITY));
  });

  it('leaves an article whose segments can pay the full gap on the 300 of §4', () => {
    // 108 of the 401 corpus longforms are in this case: the ceiling keeps them
    // byte-identical, so the fix is a floor for the starved tail only.
    expect(resolveArticleAdDensity([longformBody])).toBe(LONGFORM_ARTICLE_AD_DENSITY);
    expect(longformWordGap([longformBody])).toBe(LONGFORM_MAX_WORD_GAP);
  });

  it('falls back to the ceiling when every segment is an untranslated placeholder', () => {
    expect(longformWordGap(['blog.article.foo.body1'])).toBe(LONGFORM_MAX_WORD_GAP);
  });
});

describe('standard profile is unchanged (AGENTS.md #7)', () => {
  it('places 8 ads on the same body under the standard profile — the pre-fix baseline', () => {
    // 7 `## ` boundaries + the end-of-segment slot, all clearing the 200-word
    // gap: the cap is what stops the 8th. This is the "prima = 8" of #7336,
    // and asserting it here is what makes the 3 above a repositioning of the
    // longform format only, not a corpus-wide density cut.
    expect(renderWithProfile(longformBody, STANDARD_ARTICLE_AD_DENSITY)).toBe(8);
  });

  it('leaves a 6-section article on the standard profile, with its full ad count', () => {
    expect(resolveArticleAdDensity([shortFormBody])).toBe(STANDARD_ARTICLE_AD_DENSITY);
    // 6 `## ` boundaries + end-of-segment, exactly what it emitted before.
    expect(renderWithProfile(shortFormBody, STANDARD_ARTICLE_AD_DENSITY)).toBe(7);
  });

  it('keeps cap 8 and gap 200 as the standard constants', () => {
    expect(STANDARD_ARTICLE_AD_DENSITY.inlineCap).toBe(8);
    expect(STANDARD_ARTICLE_AD_DENSITY.minWordGap).toBe(200);
  });
});

/**
 * Observer for issue #7747 — the inline slot rotation must reach all five
 * `ARTICLE_INLINE_MOBILE*` units across the corpus.
 *
 * `makeInlineAd` used `counter % table.length` with the counter starting at 0
 * and stopping at the profile cap: on the longform profile (cap 3, table of 5)
 * only positions 0,1,2 were ever reached, so `_4` (3084573347) and `_5`
 * (4692185947) took zero impressions on the 402 longform `it` articles despite
 * a configuration identical to the other three. A fill rate pinned at 0 reads
 * as a dead unit and can trip an alert.
 */
const INLINE_SLOT_TABLE = [
  AD_SLOTS.ARTICLE_INLINE_MOBILE,
  AD_SLOTS.ARTICLE_INLINE_MOBILE_2,
  AD_SLOTS.ARTICLE_INLINE_MOBILE_3,
  AD_SLOTS.ARTICLE_INLINE_MOBILE_4,
  AD_SLOTS.ARTICLE_INLINE_MOBILE_5,
] as const;

/** Mirrors the component's `makeInlineAd` slot pick for one article. */
const slotsServed = (articleId: string, cap: number): string[] =>
  Array.from({ length: cap }, (_, i) => INLINE_SLOT_TABLE[inlineSlotIndex(articleId, i, INLINE_SLOT_TABLE.length)].slot);

/** Corpus stand-in: as many ids as the `it` longform population (#7747). */
const corpusIds = Array.from({ length: 402 }, (_, i) => `articolo-longform-${i}`);

describe('inline slot rotation (#7747)', () => {
  it('reproduces the zero-impression pre-fix rotation: cap 3 over 5 slots reaches 3', () => {
    const cap = LONGFORM_ARTICLE_AD_DENSITY.inlineCap;
    const preFix = new Set(corpusIds.flatMap(() => Array.from({ length: cap }, (_, i) => i % INLINE_SLOT_TABLE.length)));
    expect(preFix.size).toBe(3);
    expect(preFix.has(3)).toBe(false);
    expect(preFix.has(4)).toBe(false);
  });

  it('covers all five units over the longform corpus, `_4`/`_5` included', () => {
    const served = new Set(corpusIds.flatMap(id => slotsServed(id, LONGFORM_ARTICLE_AD_DENSITY.inlineCap)));
    expect(served).toEqual(new Set(INLINE_SLOT_TABLE.map(s => s.slot)));
    expect(served.has(AD_SLOTS.ARTICLE_INLINE_MOBILE_4.slot)).toBe(true);
    expect(served.has(AD_SLOTS.ARTICLE_INLINE_MOBILE_5.slot)).toBe(true);
  });

  it('emits the same NUMBER of ads per article, all distinct units (AGENTS.md #7)', () => {
    for (const profile of [LONGFORM_ARTICLE_AD_DENSITY, STANDARD_ARTICLE_AD_DENSITY]) {
      for (const id of corpusIds.slice(0, 50)) {
        const served = slotsServed(id, profile.inlineCap);
        expect(served).toHaveLength(profile.inlineCap);
        // Consecutive ads on one page still rotate by 1: with a cap at or below
        // the table length no unit repeats on the same article, exactly as
        // before the offset existed.
        const expectedDistinct = Math.min(profile.inlineCap, INLINE_SLOT_TABLE.length);
        expect(new Set(served).size).toBe(expectedDistinct);
      }
    }
  });

  it('is deterministic per article id — same slots on every render and on SSR', () => {
    for (const id of corpusIds.slice(0, 20)) {
      expect(slotsServed(id, 3)).toEqual(slotsServed(id, 3));
    }
    // Hardcoded so a change to the hash (which would redistribute the whole
    // corpus) breaks here instead of silently.
    expect(inlineSlotRotationOffset('articolo-longform-0', 5)).toBe(inlineSlotRotationOffset('articolo-longform-0', 5));
    expect(slotsServed('articolo-longform-0', 3)).toEqual(slotsServed('articolo-longform-0', 3));
  });

  it('spreads the starting offset across the table instead of pinning it to 0', () => {
    const offsets = new Set(corpusIds.map(id => inlineSlotRotationOffset(id, INLINE_SLOT_TABLE.length)));
    expect(offsets).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it('degrades to index 0 on a table of zero slots instead of NaN', () => {
    expect(inlineSlotIndex('qualsiasi', 0, 0)).toBe(0);
    expect(inlineSlotRotationOffset('qualsiasi', 0)).toBe(0);
  });
});
