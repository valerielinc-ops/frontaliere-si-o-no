import { describe, expect, it } from 'vitest';
import { sourcePostingDateFields } from '../scripts/lib/source-posting-date.mjs';
import { compareValidatedPostingDates } from '../scripts/lib/job-posting-date.mjs';

describe('publication date ESM contract', () => {
  it('loads the shared helper and compares validated microsecond timestamps', () => {
    expect(sourcePostingDateFields('2026-09-01').postingDateSource).toBe('reported');
    expect(compareValidatedPostingDates('2026-09-01T00:00:00.123456Z', '2026-09-01T00:00:00.123455Z')).toBeGreaterThan(0);
    expect(compareValidatedPostingDates('2026-09-01T00:00:00.123455Z', '2026-09-01T00:00:00.123456Z')).toBeLessThan(0);
  });
});
