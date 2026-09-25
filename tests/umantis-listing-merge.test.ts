import { describe, expect, it, vi } from 'vitest';
import { mergeUmantisListing } from '../scripts/lib/umantis-listing-merge.mjs';

describe('mergeUmantisListing', () => {
  it('keeps the first-seen value and logs both kept and discarded values on conflict', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergeUmantisListing(
      { vacancyId: '1924', title: 'First title' },
      { vacancyId: '1924', title: 'Second title' },
      'Acme',
    );
    expect(merged.title).toBe('First title');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'Acme vacancy 1924: conflicting title across listing views (kept="First title", discarded="Second title")',
    ));
    warn.mockRestore();
  });

  it('logs both ids of the conflicting pair when vacancyId itself disagrees, not just the kept one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Same map bucket (e.g. matched by a secondary key) but the vacancyId field
    // itself disagrees between the two views — the discarded id must stay visible.
    mergeUmantisListing(
      { vacancyId: '100', title: 'Berater:in' },
      { vacancyId: '101', title: 'Berater:in' },
      'Acme',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'Acme vacancy 100: conflicting vacancyId across listing views (kept="100", discarded="101")',
    ));
    warn.mockRestore();
  });

  it('is order-dependent by design: swapping existing/incoming flips which value wins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = { vacancyId: '1', title: 'A' };
    const b = { vacancyId: '1', title: 'B' };
    expect(mergeUmantisListing(a, b).title).toBe('A');
    expect(mergeUmantisListing(b, a).title).toBe('B');
    warn.mockRestore();
  });
});
