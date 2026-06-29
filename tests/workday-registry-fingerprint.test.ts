/**
 * F1 of the Workday slug-drift fix: the PERSISTED registry fingerprint
 * (extractJobIdentityFromUrl → fingerprintJob, the slug-registry key) must be
 * rename-proof for Workday URLs, mirroring the merge-key fix (mergeUrlKey Rule W,
 * PR #3073). Before this, a Workday title rename minted a brand-new fingerprint
 * (the key embedded the renamable title leaf), so getRegisteredSlug missed the
 * old entry and the registry never re-pinned the canonical slug across the rename.
 *
 * Two invariants:
 *  - SAME requisition + renamed title  → SAME fingerprint (rename-proof).
 *  - SAME requisition, DIFFERENT tenant → DIFFERENT fingerprint (no cross-employer
 *    collision — every tenant shares the `myworkdayjobs.com` registrable domain,
 *    so the identity must key on the full host).
 */
import { describe, expect, it } from 'vitest';
import { extractJobIdentityFromUrl, fingerprintJob } from '../scripts/lib/dedicated-crawler-common.mjs';

const swissLife = (titleLeaf: string) =>
  `https://swisslife.wd3.myworkdayjobs.com/en-US/Swiss_Life_Career_Site/job/Sion/${titleLeaf}`;

describe('extractJobIdentityFromUrl — Workday requisition fingerprint (F1)', () => {
  it('is stable across a title-leaf rename (same requisition)', () => {
    const before = swissLife('Conseiller-en-immobilier--f-h-d-----Sierre-_R11696');
    const after = swissLife('Immobilienberater--w-m-d-_R11696');
    expect(extractJobIdentityFromUrl(before)).toBe('swisslife.wd3.myworkdayjobs.com|r11696');
    expect(extractJobIdentityFromUrl(before)).toBe(extractJobIdentityFromUrl(after));
    expect(fingerprintJob({ url: before })).toBe(fingerprintJob({ url: after }));
  });

  it('keeps distinct tenants with the same requisition number apart', () => {
    const a = 'https://swisslife.wd3.myworkdayjobs.com/job/Sion/Whatever_R11696';
    const b = 'https://novartis.wd3.myworkdayjobs.com/job/Basel/Whatever_R11696';
    expect(extractJobIdentityFromUrl(a)).not.toBe(extractJobIdentityFromUrl(b));
  });

  it('handles the full spread of vendor requisition formats', () => {
    const id = (u: string) => extractJobIdentityFromUrl(u);
    expect(id('https://abbott.wd5.myworkdayjobs.com/en-US/abbottcareers/job/CH/Cloud-Architect_31138417'))
      .toBe('abbott.wd5.myworkdayjobs.com|31138417');
    expect(id('https://x.wd3.myworkdayjobs.com/job/L/Solution-Consultant_REQ-16005'))
      .toBe('x.wd3.myworkdayjobs.com|req-16005');
    expect(id('https://x.wd3.myworkdayjobs.com/job/L/Apprendistato-afc_R-0002527'))
      .toBe('x.wd3.myworkdayjobs.com|r-0002527');
  });

  it('leaves non-Workday identity untouched', () => {
    expect(extractJobIdentityFromUrl('https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1'))
      .toBe('umantis.com|3164');
  });
});
