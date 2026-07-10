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
    expect(extractJobIdentityFromUrl('https://example.com/jobs/view/123456'))
      .toBe('example.com|123456');
  });
});

describe('extractJobIdentityFromUrl — Umantis per-tenant vacancy fingerprint', () => {
  // Same invariant pair as Workday F1 above, for umantis. Before this fix the
  // identity was `umantis.com|<vid>` (registrableDomain dropped the tenant
  // subdomain), while vacancy ids are PER-TENANT sequences — so distinct
  // employers collided on one slug-registry entry and cross-pinned each
  // other's slugs (2026-07-10 audit: GKB "Immobilienbewerter" vacancy 1910 at
  // tenant 2607 vs KSA "Pflegefachfrau Zusatzmodul B/C" vacancy 1910 at
  // tenant 122706 — 50 active cross-tenant collisions, the "poisoned family").
  // Existing id|umantis.com|* entries are migrated by
  // scripts/migrate-umantis-registry-fingerprints.mjs.
  it('keys on the FULL tenant host', () => {
    expect(extractJobIdentityFromUrl('https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1'))
      .toBe('recruitingapp-2908.umantis.com|3164');
    expect(fingerprintJob({ url: 'https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1' }))
      .toBe('id|recruitingapp-2908.umantis.com|3164');
  });

  it('keeps distinct tenants with the same vacancy id apart (GKB vs KSA incident shape)', () => {
    const gkb = 'https://recruitingapp-2607.umantis.com/Vacancies/1910/Description/1';
    const ksa = 'https://recruitingapp-122706.umantis.com/Vacancies/1910/Application/CheckLogin/1';
    expect(extractJobIdentityFromUrl(gkb)).toBe('recruitingapp-2607.umantis.com|1910');
    expect(extractJobIdentityFromUrl(ksa)).toBe('recruitingapp-122706.umantis.com|1910');
    expect(extractJobIdentityFromUrl(gkb)).not.toBe(extractJobIdentityFromUrl(ksa));
  });

  it('is stable across the Description → CheckLogin URL shape migration', () => {
    const description = 'https://recruitingapp-122706.umantis.com/Vacancies/5105/Description/1?lang=ger';
    const checkLogin = 'https://recruitingapp-122706.umantis.com/Vacancies/5105/Application/CheckLogin/1';
    expect(extractJobIdentityFromUrl(description)).toBe(extractJobIdentityFromUrl(checkLogin));
    expect(extractJobIdentityFromUrl(description)).toBe('recruitingapp-122706.umantis.com|5105');
  });
});
