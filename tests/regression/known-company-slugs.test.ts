import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadKnownCompanySlugs } from '@/build-plugins/shared/employerLinks';

const ROOT = path.resolve(__dirname, '..', '..');

describe('known-company-slugs registry', () => {
  it('contains Coop Genossenschaft and other common employers', () => {
    const slugs = loadKnownCompanySlugs(ROOT);
    // These companies have known canonical pages
    expect(slugs.has('coop-genossenschaft')).toBe(true);
    expect(slugs.has('relewant')).toBe(true);
    expect(slugs.has('pemsa')).toBe(true);
    expect(slugs.size).toBeGreaterThan(200);
  });

  it('reads from known-company-slugs.json (primary) not all-known-job-slugs.json (legacy)', () => {
    // The primary source has 200+ entries; the legacy fallback has only ~34
    const slugs = loadKnownCompanySlugs(ROOT);
    // If we're reading the legacy file, the count would be ≤ 34 — verify primary is used
    expect(slugs.size).toBeGreaterThan(34);
  });
});
