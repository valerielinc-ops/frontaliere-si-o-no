/**
 * Boundary-aware slug truncation never produces a mid-token cut.
 *
 * Regression test for the live PwC case (2026-05-12 22:50 UTC crawler run):
 * `audit-dei-processi-aziendali-...-pwc-switzerland-geneve` (121 chars) was
 * chopped to 120 by a plain `.slice(0, 120)`, dropping the trailing `e` and
 * producing the unrouted slug `...switzerland-genev`. The cut form ended up
 * in `all-known-job-slugs.json` and surfaced 11 days later as a dead URL.
 */
import { describe, it, expect } from 'vitest';
import { truncateSlugAtWordBoundary } from '../scripts/lib/slug-truncate.mjs';

describe('truncateSlugAtWordBoundary', () => {
  it('returns input unchanged when already within cap', () => {
    expect(truncateSlugAtWordBoundary('short-slug', 90)).toBe('short-slug');
    expect(truncateSlugAtWordBoundary('exact-fit', 9)).toBe('exact-fit');
  });

  it('returns clean cut when cap lands on a hyphen', () => {
    // 'foo-bar-baz' cut at 7 → 'foo-bar' (position 7 is '-')
    expect(truncateSlugAtWordBoundary('foo-bar-baz', 7)).toBe('foo-bar');
  });

  it('rolls back to last hyphen when cap lands mid-token', () => {
    const input = 'pwc-switzerland-geneve';
    // cap=20 → 'pwc-switzerland-gene' (mid-word) → rolls back to 'pwc-switzerland'
    expect(truncateSlugAtWordBoundary(input, 20)).toBe('pwc-switzerland');
  });

  it('preserves the trailing token when cap is exactly one char short of full', () => {
    // The PwC regression case
    const input = 'audit-dei-processi-aziendali-e-informatici-settore-commercio-industria-e-servizi-stagista-6-9-mesi-pwc-switzerland-geneve';
    expect(input.length).toBe(121);
    const result = truncateSlugAtWordBoundary(input, 120);
    // Must NOT end with a partial 'genev'
    expect(result.endsWith('genev')).toBe(false);
    // Must end at a hyphen-delimited boundary
    expect(/[a-z0-9]$/.test(result)).toBe(true);
    expect(result.split('-').pop()).toBe('switzerland');
  });

  it('falls back to mid-token chop when rolling back would exceed 25% of cap', () => {
    // Pathological: one giant token with no separators
    const input = 'verylongmonolithicwordwithoutdashes';
    expect(truncateSlugAtWordBoundary(input, 20)).toBe('verylongmonolithicwo');
  });

  it('handles empty and falsy inputs', () => {
    expect(truncateSlugAtWordBoundary('', 100)).toBe('');
    expect(truncateSlugAtWordBoundary(null as unknown as string, 100)).toBe('');
    expect(truncateSlugAtWordBoundary(undefined as unknown as string, 100)).toBe('');
  });

  it('handles the user-reported geneva-vs-genev case at 120-cap', () => {
    // 91 chars total, well under 120
    const input = 'tirocinio-di-3-mesi-in-audit-servizi-finanziari-gennaio-a-marzo-2027-pwc-switzerland-geneva';
    expect(truncateSlugAtWordBoundary(input, 120)).toBe(input);
  });
});
