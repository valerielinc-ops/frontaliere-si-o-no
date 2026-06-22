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

  it('returns NaN for calendar-impossible date 31/04 (April has 30 days) — rollover guard (#2727)', () => {
    expect(Number.isNaN(parseDateField('31/04/26'))).toBe(true);
  });

  it('returns NaN for calendar-impossible date 31/02 (February has ≤29 days) — rollover guard (#2727)', () => {
    expect(Number.isNaN(parseDateField('31/02/26'))).toBe(true);
  });

  it('returns NaN for 29/02 in a non-leap year — rollover guard (#2727)', () => {
    expect(Number.isNaN(parseDateField('29/02/26'))).toBe(true); // 2026 is not a leap year
  });

  it('still accepts 29/02 in a leap year', () => {
    const d = new Date(parseDateField('29/02/28'));
    expect(d.getUTCFullYear()).toBe(2028);
    expect(d.getUTCMonth()).toBe(1); // February
    expect(d.getUTCDate()).toBe(29);
  });
});
