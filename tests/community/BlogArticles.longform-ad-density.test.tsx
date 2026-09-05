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
import {
  isLongformArticle,
  countH2Sections,
  resolveArticleAdDensity,
  LONGFORM_ARTICLE_AD_DENSITY,
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

describe('standard profile is unchanged (AGENTS.md #7)', () => {
  it('still places 8 ads on a non-longform article of the same length', () => {
    expect(resolveArticleAdDensity([shortFormBody])).toBe(STANDARD_ARTICLE_AD_DENSITY);
    expect(renderWithProfile(shortFormBody, STANDARD_ARTICLE_AD_DENSITY)).toBe(8);
  });

  it('keeps cap 8 and gap 200 as the standard constants', () => {
    expect(STANDARD_ARTICLE_AD_DENSITY.inlineCap).toBe(8);
    expect(STANDARD_ARTICLE_AD_DENSITY.minWordGap).toBe(200);
  });
});
