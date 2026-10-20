import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllDalerJobs } from '../scripts/lib/daler-hopital-job-parser.mjs';
import { fetchAllEhnvJobs } from '../scripts/lib/ehnv-job-parser.mjs';
import { fetchAllHJuJobs } from '../scripts/lib/h-ju-hopital-du-jura-job-parser.mjs';

const sourceDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const olderDay = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
const futureDay = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const timestamp = `${sourceDay}T23:30:00.123-03:00`;
const companies = [
  { key: 'daler-hopital', fetchJobs: fetchAllDalerJobs },
  { key: 'ehnv', fetchJobs: fetchAllEhnvJobs },
  { key: 'h-ju-hopital-du-jura', fetchJobs: fetchAllHJuJobs },
];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const company of companies) {
  describe(`${company.key} Johdi Suite publication evidence`, () => {
    it.each([
      ['day', sourceDay, undefined, sourceDay],
      ['full timestamp', undefined, timestamp, timestamp],
      ['missing', undefined, undefined, ''],
      ['invalid', '2026-02-30', 'not a date', ''],
      ['future', futureDay, futureDay, ''],
      ['valid listing with invalid detail', sourceDay, '2026-02-30', sourceDay],
      ['older original detail', sourceDay, olderDay, olderDay],
    ] as const)('%s preserves the atomic trio through the actual wrapper', async (_label, listingDate, detailDate, expected) => {
      const common = { id: 123, title: 'Infirmier hospitalier 80-100%', slug: 'infirmier-hospitalier',
        city: 'Fribourg', canton: 'FR', activity_from: 80, activity_to: 100,
        introduction: '<p>Accompagner nos patients avec une équipe médicale interdisciplinaire.</p>',
        entry_date: sourceDay, created_at: sourceDay, updated_at: sourceDay, expiration_date: futureDay };
      const listing = [{ ...common, publication_date: listingDate }];
      const detail = { ...common, publication_date: detailDate,
        description: '<p>Assurer les soins, documenter les observations et coordonner les interventions avec les autres professionnels de santé.</p>' };
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => new Response(
        JSON.stringify(String(input).includes('/offers/') ? listing : detail),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )));
      const jobs = await company.fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ companyKey: company.key, title: common.title, datePosted: expected,
        postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
      expect(jobs[0].description).toContain('Assurer les soins');
      expect(jobs[0].url).toBeTruthy();
      expect(jobs[0].canton).toBeTruthy();
      expect(jobs[0].crawledAt).toBeTruthy();
      expect(jobs[0].crawledAt).not.toBe(expected);
    });
  });
}
