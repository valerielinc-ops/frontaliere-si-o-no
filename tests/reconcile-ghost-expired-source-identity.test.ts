/**
 * #11596 — previousSlugs ownership regrowth through ghost reconciliation.
 *
 * Two live postings of one employer often share title, company and location
 * (two "Sub-assistant Medicine" vacancies at the same hospital). Housekeeping
 * can archive one of them as a dedup duplicate (`dedupArchive: true`) while the
 * other stays active. Its archive record still carries the ORIGINAL posting's
 * `sourceIdentity` and its own disambiguated slugs (`<base>-<its hash>`).
 *
 * reconcileGhostExpired used to treat that record as a "ghost" of the active
 * sibling: same title+company+location plus one colliding generic locale slug
 * was enough, so the sibling inherited the archived posting's whole route
 * history — including the hash-tailed slug that belongs to the other posting.
 * When the crawler re-listed the archived posting, the fleet held a
 * previousSlugs entry owned by another current job (the live-data observer
 * tests/decontaminate-prev-slugs-live-regression.test.ts went red with
 * moved: 7 on 2026-10-05).
 *
 * A ghost is the SAME posting under a different slug. When both records carry
 * a source identity and they disagree, the archive entry is a different
 * posting and must not be merged.
 */
import { describe, it, expect } from 'vitest';
import { reconcileGhostExpired } from '../scripts/assemble-jobs-dataset.mjs';

const BASE = 'https://careers.example-hospital.test/jobs/sub-assistant-medicine';
const ACTIVE_URL = `${BASE}/11111111-1111-4111-8111-111111111111`;
const ARCHIVED_URL = `${BASE}/22222222-2222-4222-8222-222222222222`;

function activeSibling() {
  return {
    id: 'example-hospital-aaaaaaaaaaaa',
    title: 'Unterassistent/in Medizin (a)',
    company: 'Example Hospital',
    location: 'Liestal',
    url: ACTIVE_URL,
    slug: 'medicina-subassista-a-example-hospital-liestal',
    slugByLocale: {
      it: 'medicina-subassista-a-example-hospital-liestal',
      en: 'sub-assistant-medicine-a-example-hospital-liestal',
      de: 'unterassistent-in-medizin-a-example-hospital-liestal',
    },
    previousSlugs: ['unterassistent-in-medizin-a-example-hospital-liestal-old'],
    previousSlugsByLocale: { it: ['unterassistent-in-medizin-a-example-hospital-liestal-old'] },
  };
}

function archivedDuplicate(overrides = {}) {
  return {
    title: 'Unterassistent/in Medizin (a)',
    company: 'Example Hospital',
    location: 'Liestal',
    slug: 'medicina-subassista-a-example-hospital-liestal-s9bict',
    slugByLocale: {
      // Generic locale slug both postings derive from the same title.
      de: 'unterassistent-in-medizin-a-example-hospital-liestal',
      it: 'medicina-subassista-a-example-hospital-liestal-s9bict',
      en: 'sub-assistant-medicine-a-example-hospital-liestal',
    },
    previousSlugs: ['medicina-subassista-a-example-hospital-liestal-s9bict', 'pasticceria-a-example-hospital-liestal'],
    previousSlugsByLocale: { it: ['medicina-subassista-a-example-hospital-liestal-s9bict'] },
    expiredAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    dedupArchive: true,
    sourceIdentity: `url:${ARCHIVED_URL}`,
    ...overrides,
  };
}

describe('reconcileGhostExpired — source identity guard (#11596)', () => {
  it('does not merge a dedup-archived sibling posting into the active job', () => {
    const active = activeSibling();
    const before = JSON.stringify([active.previousSlugs, active.previousSlugsByLocale]);
    const expired = [archivedDuplicate()];

    const { ghostCount, mergedSlugs, cleanedExpired } = reconcileGhostExpired([active], expired);

    expect(ghostCount).toBe(0);
    expect(mergedSlugs).toBe(0);
    expect(cleanedExpired).toEqual(expired);
    expect(JSON.stringify([active.previousSlugs, active.previousSlugsByLocale])).toBe(before);
  });

  it('does not merge when the other posting identity is only in sourceIdentityHistory', () => {
    const active = activeSibling();
    const expired = [archivedDuplicate({
      sourceIdentity: undefined,
      sourceIdentityHistory: [{ sourceIdentity: `url:${ARCHIVED_URL}` }],
    })];

    const { ghostCount, mergedSlugs } = reconcileGhostExpired([active], expired);

    expect(ghostCount).toBe(0);
    expect(mergedSlugs).toBe(0);
    expect(active.previousSlugs).not.toContain('medicina-subassista-a-example-hospital-liestal-s9bict');
  });

  it('still merges an archive record whose source identity is the active posting', () => {
    const active = activeSibling();
    const expired = [archivedDuplicate({ sourceIdentity: `url:${ACTIVE_URL}` })];

    const { ghostCount, mergedSlugs, cleanedExpired } = reconcileGhostExpired([active], expired);

    expect(ghostCount).toBe(1);
    expect(mergedSlugs).toBeGreaterThan(0);
    expect(cleanedExpired).toEqual([]);
    expect(active.previousSlugs).toContain('pasticceria-a-example-hospital-liestal');
  });

  it('still merges when the active identity appears in sourceIdentityHistory', () => {
    const active = activeSibling();
    const expired = [archivedDuplicate({
      sourceIdentityHistory: [
        { sourceIdentity: `url:${ARCHIVED_URL}` },
        { sourceIdentity: `url:${ACTIVE_URL}` },
      ],
    })];

    const { ghostCount } = reconcileGhostExpired([active], expired);

    expect(ghostCount).toBe(1);
  });

  it('keeps legacy behaviour for archive records without any source identity', () => {
    const active = activeSibling();
    const expired = [archivedDuplicate({ sourceIdentity: undefined, dedupArchive: undefined })];

    const { ghostCount } = reconcileGhostExpired([active], expired);

    expect(ghostCount).toBe(1);
  });
});
