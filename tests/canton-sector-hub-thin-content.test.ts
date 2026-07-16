/**
 * follow-up(#4258 / #4261) — thin-content floor for per-canton sector hubs.
 *
 * PR #4258 removed the job-count floor for non-TI `/cerca-lavoro-{canton}/{sector}/`
 * pages (`build-plugins/jobsSeoPagesPlugin.ts`): every (canton, sector, locale)
 * combo now emits a real, indexed page even at 0 matching jobs. The reviewer
 * flagged that this was "reasoned from the code" but never verified against a
 * real build (full local SEO builds OOM, so `dist/` isn't reliably available).
 *
 * Unlike the TI-owned sector hub (`jobSectorLanding.ts::buildSectorProse`,
 * covered by `tests/sector-landing-content.test.ts`), the non-TI per-canton
 * page does NOT run its prose through `padToMinWords`. Its body is composed
 * of two unconditional, job-count-independent blocks:
 *   - `renderJobBoardListingDensityProse` (shared/jobListingProse.ts)
 *   - `renderJobBoardCommuterContext` (shared/jobBoardCommuterContext.ts)
 * Both are static/templated and never skip or shorten based on `resultCount`.
 * This test locks that invariant in place at the worst case (0 jobs) so a
 * future refactor can't silently gate either block behind a job-count check.
 */
import { describe, expect, it } from 'vitest';
import { renderJobBoardListingDensityProse } from '../build-plugins/shared/jobListingProse';
import { renderJobBoardCommuterContext } from '../build-plugins/shared/jobBoardCommuterContext';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

function wordCount(html: string): number {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean).length;
}

describe('per-canton sector hub — thin-content floor at 0 matching jobs', () => {
  it('renderJobBoardListingDensityProse alone clears 200 words at resultCount=0', () => {
    for (const locale of LOCALES) {
      const html = renderJobBoardListingDensityProse(locale, {
        subject: 'infermieri',
        location: 'Zurigo',
        resultCount: 0,
        companyCount: 0,
        locationCount: 0,
      });
      expect(wordCount(html), `${locale} density prose is thin at 0 jobs`).toBeGreaterThanOrEqual(200);
    }
  });

  it('renderJobBoardCommuterContext (sectors-hub slot) clears 200 words regardless of job count', () => {
    for (const locale of LOCALES) {
      const html = renderJobBoardCommuterContext({
        locale,
        location: 'Zurigo',
        omitCommute: true,
        sectorOrType: 'Infermieri',
        cantonDisplay: 'Zurigo',
        cantonSlot: 'sectors-hub',
      });
      expect(wordCount(html), `${locale} commuter context is thin at 0 jobs`).toBeGreaterThanOrEqual(200);
    }
  });

  it('the two unconditional blocks combined clear the 210-word floor the reviewer cited, at 0 jobs', () => {
    for (const locale of LOCALES) {
      const density = renderJobBoardListingDensityProse(locale, {
        subject: 'infermieri',
        location: 'Zurigo',
        resultCount: 0,
        companyCount: 0,
        locationCount: 0,
      });
      const commuter = renderJobBoardCommuterContext({
        locale,
        location: 'Zurigo',
        omitCommute: true,
        sectorOrType: 'Infermieri',
        cantonDisplay: 'Zurigo',
        cantonSlot: 'sectors-hub',
      });
      expect(
        wordCount(density) + wordCount(commuter),
        `${locale} combined per-canton sector hub prose is below the 210-word floor at 0 jobs`,
      ).toBeGreaterThanOrEqual(210);
    }
  });
});
