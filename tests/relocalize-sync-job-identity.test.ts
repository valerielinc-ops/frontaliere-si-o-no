/**
 * previousSlugs writer regression (#3785/#3794/#3844/#3852/#3874) — sync
 * cross-job contamination.
 *
 * Reproduced from production data (KSA slice, commit aea161ce08 window):
 * syncTranslationsToCrawlerFile matched slice job ksa-07ec20d26c7e
 * (umantis Vacancies/5105) to assembled job ksa-efaa616bf2a8
 * (umantis Vacancies/2558) because the assembled sibling's previousSlugs
 * contained the crawler job's ACTIVE slug and the single-pass first-wins
 * index let history keys shadow other jobs' active-slug keys. The sync then
 * copied the SIBLING's titleByLocale/slugByLocale into the wrong slice
 * record; cleanPreviousSlugsPerLocale dropped every history entry that now
 * matched the (wrong) active slugs — a silent previousSlugs loss.
 *
 * These tests pin the fixed matching semantics:
 *   1. URL identity always beats slug keys.
 *   2. A job's previousSlugs can never shadow another job's active slug.
 *   3. A slug-keyed match is rejected when both sides have disagreeing URLs.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAssembledJobIndex,
  matchAssembledJob,
} from '../scripts/relocalize-pending-jobs.mjs';

const COMPANY_KEY = 'ksa';

// Same-title family, real shape: sibling B's previousSlugs contains A's active slug.
const jobA = {
  id: 'ksa-07ec20d26c7e',
  companyKey: 'ksa',
  company: 'Kantonsspital Aarau (KSA)',
  url: 'https://recruitingapp-122706.umantis.com/Vacancies/5105/Application/CheckLogin/1',
  slug: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
  slugByLocale: {
    de: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
    it: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
    en: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
    fr: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
  },
};

const jobB = {
  id: 'ksa-efaa616bf2a8',
  companyKey: 'ksa',
  company: 'Kantonsspital Aarau (KSA)',
  url: 'https://recruitingapp-122706.umantis.com/Vacancies/2558/Application/CheckLogin/1',
  slug: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
  slugByLocale: {
    it: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
    en: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
    fr: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
  },
  // History tangled by duplicate-merging of the same-title family: contains A's ACTIVE slug.
  previousSlugs: ['dipl-pflegefachfrau-pflegefachmann-ksa-ch'],
};

describe('buildAssembledJobIndex + matchAssembledJob (sync identity)', () => {
  it("a sibling's previousSlugs never shadows another job's active slug (prod repro)", () => {
    // Sibling B is iterated FIRST — the old single-pass index let its
    // previousSlugs claim A's active slug key.
    const index = buildAssembledJobIndex([jobB, jobA], COMPANY_KEY);
    const matched = matchAssembledJob(
      { id: jobA.id, url: jobA.url, slug: jobA.slug },
      index,
    );
    expect(matched).toBeTruthy();
    expect(matched.id).toBe('ksa-07ec20d26c7e');
  });

  it('URL identity wins over any slug key', () => {
    const index = buildAssembledJobIndex([jobB, jobA], COMPANY_KEY);
    // Crawler job carries B's slug (stale data) but A's URL: URL must win.
    const matched = matchAssembledJob(
      { id: jobA.id, url: jobA.url, slug: jobB.slug },
      index,
    );
    expect(matched.id).toBe('ksa-07ec20d26c7e');
  });

  it('rejects a slug-keyed match when both sides have disagreeing URLs', () => {
    // Only B is assembled (A dropped from data/jobs.json, e.g. by the
    // assembler's slug-dedup pass). Crawler job A would match B via B's
    // previousSlugs — the exact cross-job copy that wiped translations.
    const index = buildAssembledJobIndex([jobB], COMPANY_KEY);
    const matched = matchAssembledJob(
      { id: jobA.id, url: jobA.url, slug: jobA.slug },
      index,
    );
    expect(matched).toBeNull();
  });

  it('still matches by slug when the crawler job has no URL (legacy id-less records)', () => {
    const index = buildAssembledJobIndex([jobB, jobA], COMPANY_KEY);
    const matched = matchAssembledJob({ id: 'x', slug: jobB.slug }, index);
    expect(matched.id).toBe('ksa-efaa616bf2a8');
  });

  it('still resolves renamed jobs via previousSlugs when no active owner claims the key', () => {
    // The legitimate use of previousSlugs keys: the assembled job renamed its
    // master slug and the crawler file still references the old one. No other
    // job's active slug competes here, and the URL agrees.
    const renamed = {
      ...jobB,
      previousSlugs: ['old-master-slug-before-rename'],
    };
    const index = buildAssembledJobIndex([renamed, jobA], COMPANY_KEY);
    const matched = matchAssembledJob(
      { id: renamed.id, url: renamed.url, slug: 'old-master-slug-before-rename' },
      index,
    );
    expect(matched.id).toBe('ksa-efaa616bf2a8');
  });

  it('scopes the index to the requested company key', () => {
    const foreign = { ...jobA, companyKey: 'other-co' };
    const index = buildAssembledJobIndex([foreign], COMPANY_KEY);
    expect(index.size).toBe(0);
  });
});
