import { describe, expect, it } from 'vitest';
import { sourcePostingDateFields } from '../scripts/lib/source-posting-date.mjs';
import { compareValidatedPostingDates } from '../scripts/lib/job-posting-date.mjs';

const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

describe('publication date ESM contract', () => {
  it('loads the shared helper and compares validated microsecond timestamps', () => {
    const date = daysAgo(2);
    expect(sourcePostingDateFields(date).postingDateSource).toBe('reported');
    expect(compareValidatedPostingDates(`${date}T00:00:00.123456Z`, `${date}T00:00:00.123455Z`)).toBeGreaterThan(0);
    expect(compareValidatedPostingDates(`${date}T00:00:00.123455Z`, `${date}T00:00:00.123456Z`)).toBeLessThan(0);
  });
});
