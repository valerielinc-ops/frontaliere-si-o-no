import { describe, expect, it } from 'vitest';
import {
  dropHousekeepingDuplicatePostings,
  housekeepingDuplicateKeys,
  titleCompanyLocationKey,
} from '../scripts/lib/housekeeping-duplicate-postings.mjs';

const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

// Records shaped like main's slices on 2026-09-29 (URLs and addresses from the
// live sources); step 3 of cleanup-jobs.mjs used to group them on
// title|company|location alone.
const coopStore = (uuid: string, extra: Record<string, unknown> = {}) => ({
  url: `https://jobs.coopjobs.ch/offene-stellen/verkaeufer-in-food/${uuid}`,
  title: 'Verkäufer:in Food', company: 'Coop Genossenschaft', location: 'Zürich',
  crawledAt: daysAgo(1), ...extra,
});

describe('cleanup-jobs step 3: duplicates need a proof from the source (parser-quality audit #5253)', () => {
  it('keeps same-title postings of one city when no postal code and street tell them apart', () => {
    // Coop publishes no store address in its slice: two UUIDs are two vacancies.
    const jobs = [coopStore('9000e66a-ba53-453a-b8a3-a683ddfdcb66'), coopStore('0ca63bc2-a44f-4444-ad40-ef66098c763b')];
    expect(jobs.map((job) => housekeepingDuplicateKeys(job).filter((key) => key.startsWith('place')))).toEqual([[], []]);
    expect(dropHousekeepingDuplicatePostings(jobs).removed).toEqual([]);
  });

  it('keeps two stores of one city with different postal codes or streets', () => {
    const jobs = [
      coopStore('2f1b4fc6-b883-4d7c-963f-a29fd82e6a17', { postalCode: '8047', streetAddress: 'Albisriederstrasse 334' }),
      coopStore('6940a7ef-9cc8-4c7c-86f6-829aa54e066b', { postalCode: '8050', streetAddress: 'Leutschenbachstrasse 70' }),
      coopStore('da3094fe-d01f-49b7-98e1-750f5808ca3f', { postalCode: '8008', streetAddress: 'Seefeldstrasse 199' }),
      coopStore('a9cac79a-4e87-4a32-8dc0-3f9915ee4da0', { postalCode: '8008', streetAddress: 'Seefeldstrasse 123' }),
    ];
    expect(dropHousekeepingDuplicatePostings(jobs).kept).toEqual(jobs);
  });

  it('keeps one Workday requisition per vacancy even with an assembler-filled postal code', () => {
    const jobs = ['R2402', 'R2403', 'R2404'].map((req) => ({
      url: `https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Carouge-La-Praille/Stockiste--h-f-_${req}`,
      title: 'Stockiste (h/f)', company: 'Rituals Cosmetics', location: 'Carouge',
      // assemble-jobs-dataset fills postalCode from the locality, never the street.
      postalCode: '1227', crawledAt: daysAgo(2),
    }));
    expect(dropHousekeepingDuplicatePostings(jobs).removed).toEqual([]);
  });

  it('still removes the same posting at the same full address, keeping the newest crawl in place', () => {
    const base = {
      title: 'Detailhandelsfachfrau:mann EFZ', company: 'Fust', location: 'Oberbüren',
      postalCode: '9245', streetAddress: 'Industrie Haslen 3',
    };
    const older = { ...base, url: 'https://jobs.fust.ch/offene-stellen/detailhandelsfachfrau-mann-efz/8b94f408-ac6f-4721-8f5b-831bada3ab46', crawledAt: daysAgo(3) };
    const other = { ...base, title: 'Servicetechniker:in', url: 'https://jobs.fust.ch/offene-stellen/servicetechniker-in/4237f7bb-f54a-486a-9e2b-d33795a23065', crawledAt: daysAgo(1) };
    const newer = { ...base, url: 'https://jobs.fust.ch/offene-stellen/detailhandelsfachfrau-mann-efz/4fc73b52-740d-4acb-b587-96c4a0651d9d', crawledAt: daysAgo(1) };
    const { kept, removed } = dropHousekeepingDuplicatePostings([older, other, newer]);

    expect(kept).toEqual([newer, other]);
    expect(removed).toEqual([{ loser: older, retained: newer, duplicateKey: 'detailhandelsfachfrau:mann efz|fust|oberbüren' }]);
    // The proof sidecar still carries the key crawler-slice-integrity recomputes.
    expect(removed[0].duplicateKey).toBe(titleCompanyLocationKey(newer));
  });

  it('removes one requisition published under two URLs of the same source', () => {
    const base = { title: 'Kundenberater:in vermögende Privatkunden Biel (w/m)', company: 'Bank Cler', location: 'Biel', crawledAt: daysAgo(1) };
    const current = { ...base, url: 'https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/kundenberaterin-vermoegende-privatkunden-biel-w-m-2740' };
    const renamed = { ...base, url: 'https://www.cler.ch/de/bank-cler/jobs-und-karriere-2026/suchen-und-bewerben/offene-stellen/kundenberaterin-vermoegende-privatkunden-biel-w-m-2740' };
    const otherReq = { ...base, url: 'https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/kundenberaterin-vermoegende-privatkunden-biel-w-m-2741' };
    const { kept, removed } = dropHousekeepingDuplicatePostings([renamed, current, otherReq]);

    expect(removed.map(({ loser, retained }) => [loser.url, retained.url])).toEqual([[current.url, renamed.url]]);
    expect(kept).toEqual([renamed, otherReq]);
  });

  it('never groups a record without a title', () => {
    expect(housekeepingDuplicateKeys({ url: 'https://example.ch/job/1', postalCode: '6900', streetAddress: 'Via Nassa 1' })).toEqual([]);
  });
});
