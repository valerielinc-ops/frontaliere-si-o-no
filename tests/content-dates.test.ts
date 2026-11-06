// A date on a FAQ answer or on the calculator parameters must be the date of a
// real change. Build-time `git log` cannot give it (deploy checkouts are shallow),
// so the dates are committed and this hash check is what keeps them true.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import contentDates from '../data/content-dates.json';
import { ALL_FAQ_HUB } from '../data/faq-hub';
import { hashFaqEntry, hashFiscalParams } from '../scripts/lib/content-date-hash';

const FIX = 'npx tsx scripts/update-content-dates.ts';
const faq: Record<string, { updatedAt: string; hash: string }> = contentDates.faq;
const isPastDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Date.parse(value) <= Date.now();

describe('content dates follow real changes', () => {
  it('every FAQ entry has a date and no stale record survives', () => {
    expect(Object.keys(faq).sort()).toEqual(ALL_FAQ_HUB.map((entry) => entry.id).sort());
  });

  it.each(ALL_FAQ_HUB.map((entry) => [entry.id, entry] as const))('%s: text change has a new date', (id, entry) => {
    expect(faq[id].hash, `text of ${id} changed without a new date: run ${FIX}`).toBe(hashFaqEntry(entry));
    expect(isPastDay(faq[id].updatedAt)).toBe(true);
  });

  it('a parameter or calculation change has a new date', () => {
    expect(contentDates.fiscalParams.hash, `fiscal parameters changed without a new date: run ${FIX}`)
      .toBe(hashFiscalParams(resolve(__dirname, '..')));
    expect(isPastDay(contentDates.fiscalParams.updatedAt)).toBe(true);
  });

  it('a recorded source check is a real past day', () => {
    for (const entry of ALL_FAQ_HUB) {
      if (entry.sourcesCheckedAt !== undefined) expect(isPastDay(entry.sourcesCheckedAt), entry.id).toBe(true);
    }
  });
});
