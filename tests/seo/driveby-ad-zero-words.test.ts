/**
 * driveby-ad-zero-words.test.ts
 *
 * Regression guard for follow-up(#2760) item 2: the above-fold driveby ad
 * markup (`DRIVEBY_AD_SNIPPET`) and the job-list end multiplex slot must
 * contribute ZERO words to `countHtmlBodyWords`, the function that gates
 * indexability via `robotsMetaForContent` (>= MIN_INDEXABLE_WORDS → index).
 *
 * Why this matters: PR #2760 injects `DRIVEBY_AD_SNIPPET` above the fold on
 * three landing-page plugins (weeklyEmployersPlugin, jobMarketSnapshotPlugin,
 * marketReportPlugin) — all import the SAME constant from build-plugins/
 * constants.ts. The reviewer assumed (but did not re-run) that this `<div>/
 * <ins>` markup counts as 0 words. If a future edit adds visible text to the
 * snippet (e.g. an "Advertisement" label), a page sitting exactly on the
 * MIN_INDEXABLE_WORDS boundary could flip in EITHER direction:
 *   - extra words → a thin page falsely crosses ABOVE the floor (indexed thin
 *     content, AGENTS.md non-negotiable #4), or
 *   - if the markup itself were ever counted → a borderline page drops BELOW
 *     and is silently de-indexed (zero SEO traffic).
 * Locking the zero-words invariant on the shared constant covers all three
 * plugins by construction and makes that drift impossible-by-test.
 *
 * If this starts failing, do NOT relax the assertion: the ad markup leaked
 * visible text into the indexability word count — strip it at the source.
 */

import { describe, expect, it } from 'vitest';

import {
  DRIVEBY_AD_SNIPPET,
  MIN_INDEXABLE_WORDS,
  countHtmlBodyWords,
  robotsMetaForContent,
} from '@/build-plugins/constants';
import { adSlotHtml } from '@/build-plugins/lib/adSlotHtml';

describe('driveby / end-multiplex ad markup contributes zero indexability words (#2762)', () => {
  it('DRIVEBY_AD_SNIPPET counts as 0 words', () => {
    // Sanity: the snippet IS real ad markup, not an empty string.
    expect(DRIVEBY_AD_SNIPPET).toContain('<ins');
    expect(DRIVEBY_AD_SNIPPET.length).toBeGreaterThan(0);
    expect(countHtmlBodyWords(DRIVEBY_AD_SNIPPET)).toBe(0);
  });

  it('JOBLIST_END_MULTIPLEX slot markup counts as 0 words', () => {
    const multiplex = adSlotHtml('JOBLIST_END_MULTIPLEX');
    expect(multiplex).toContain('<ins');
    expect(countHtmlBodyWords(multiplex)).toBe(0);
  });

  it('injecting both ad slots does not change the body word count', () => {
    const prose = 'word '.repeat(60).trim(); // 60 plain words, no markup
    const baseline = countHtmlBodyWords(prose);
    expect(baseline).toBe(60);

    const withAds = `${DRIVEBY_AD_SNIPPET}\n<p>${prose}</p>\n${adSlotHtml('JOBLIST_END_MULTIPLEX')}`;
    expect(countHtmlBodyWords(withAds)).toBe(baseline);
  });

  it('a page exactly at the MIN_INDEXABLE_WORDS floor stays indexable after ad injection', () => {
    // Body with EXACTLY the floor number of words — the worst case for a flip.
    const floorProse = `<p>${'word '.repeat(MIN_INDEXABLE_WORDS).trim()}</p>`;
    expect(countHtmlBodyWords(floorProse)).toBe(MIN_INDEXABLE_WORDS);
    expect(robotsMetaForContent(floorProse)).toContain('index,follow');
    expect(robotsMetaForContent(floorProse)).not.toContain('noindex');

    const withAds = `${DRIVEBY_AD_SNIPPET}\n${floorProse}\n${adSlotHtml('JOBLIST_END_MULTIPLEX')}`;
    // The driveby markup must NOT push the count off the floor in either direction.
    expect(countHtmlBodyWords(withAds)).toBe(MIN_INDEXABLE_WORDS);
    expect(robotsMetaForContent(withAds)).toContain('index,follow');
    expect(robotsMetaForContent(withAds)).not.toContain('noindex');
  });
});
