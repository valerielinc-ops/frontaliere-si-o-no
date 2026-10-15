import { describe, it, expect } from 'vitest';
import { parseDateField } from '../services/newsletter-content.mjs';

describe('parseDateField — European DD/MM slash dates (#2630)', () => {
  it('parses an ambiguous DD/MM/YY (day<=12) as DD/MM, not US MM/DD', () => {
    // The silent bug: new Date('05/06/26') reads 6 May (MM/DD). It is 5 June.
    const ts = parseDateField('05/06/26');
    const d = new Date(ts);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(5); // June (0-indexed)
    expect(d.getUTCDate()).toBe(5);
  });

  it('parses a non-ambiguous DD/MM/YY (day>12) correctly', () => {
    const d = new Date(parseDateField('30/05/26'));
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(4); // May
    expect(d.getUTCDate()).toBe(30);
  });

  it('accepts 4-digit years', () => {
    const d = new Date(parseDateField('07/03/2026'));
    expect(d.getUTCMonth()).toBe(2); // March
    expect(d.getUTCDate()).toBe(7);
  });

  it('returns NaN for an impossible DD/MM (month>12) → caller falls through', () => {
    expect(Number.isNaN(parseDateField('06/13/26'))).toBe(true);
  });

  it('still parses ISO dates via Date()', () => {
    const d = new Date(parseDateField('2026-06-05'));
    expect(d.getUTCMonth()).toBe(5);
    expect(d.getUTCDate()).toBe(5);
  });

  it('returns NaN for junk', () => {
    expect(Number.isNaN(parseDateField('not-a-date'))).toBe(true);
  });

  // #2727 item 3: in-range but calendar-impossible dates pass the day<=31 &&
  // month<=12 guard, and Date.UTC silently rolls them to the next month
  // (31/04 → 1 May, 31/02 → 3 Mar). The round-trip check must reject them so
  // the caller falls through to firstSeenAt rather than trusting a shifted ts.
  it('returns NaN for an in-range but impossible day (31/04)', () => {
    expect(Number.isNaN(parseDateField('31/04/26'))).toBe(true);
  });

  it('returns NaN for 31/02 (February rollover)', () => {
    expect(Number.isNaN(parseDateField('31/02/26'))).toBe(true);
  });

  it('returns NaN for 29/02 in a non-leap year', () => {
    expect(Number.isNaN(parseDateField('29/02/26'))).toBe(true);
  });

  it('accepts 29/02 in a leap year', () => {
    const d = new Date(parseDateField('29/02/24'));
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(1); // February
    expect(d.getUTCDate()).toBe(29);
  });

  it('accepts a valid end-of-month date (30/04)', () => {
    const d = new Date(parseDateField('30/04/26'));
    expect(d.getUTCMonth()).toBe(3); // April
    expect(d.getUTCDate()).toBe(30);
  });
});
