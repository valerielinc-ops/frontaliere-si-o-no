import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUmantisListing } from '../scripts/lib/umantis-listing-common.mjs';
import { fetchAllBethesdaSpitalJobs } from '../scripts/lib/bethesda-spital-job-parser.mjs';
import { fetchAllBuergenstockHotelsJobs } from '../scripts/lib/buergenstock-hotels-job-parser.mjs';
import { fetchAllGesundheitszentrumFricktalJobs } from '../scripts/lib/gesundheitszentrum-fricktal-job-parser.mjs';
import { fetchAllKispiZurichJobs } from '../scripts/lib/kispi-zurich-job-parser.mjs';
import { fetchAllKlinikImHaselJobs } from '../scripts/lib/klinik-im-hasel-job-parser.mjs';
import { fetchAllKlinikSonnenhaldeJobs } from '../scripts/lib/klinik-sonnenhalde-job-parser.mjs';
import { fetchAllKzuJobs } from '../scripts/lib/kzu-job-parser.mjs';
import { fetchAllNsnMedicalJobs } from '../scripts/lib/nsn-medical-job-parser.mjs';
import { fetchAllSanatoriumKilchbergJobs } from '../scripts/lib/sanatorium-kilchberg-job-parser.mjs';
import { fetchAllSzbChbJobs } from '../scripts/lib/szb-chb-job-parser.mjs';

const sourceDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const futureDay = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const swiss = (day: string) => day.split('-').reverse().join('.');
const title = 'Mitarbeiter:in Patientenabrechnung, 80-100%';
const detail = readFileSync(new URL('./fixtures/umantis-sonnenhalde/detail-416.html', import.meta.url), 'utf8');
const row = (id: string, date: string) => `<tr class="legacy-row"><td><span>${date ? `Online seit: ${date}` : 'Eintritt: 01.01.2026'}</span><a href="/Vacancies/${id}/Description/1">${title}</a><span>Art: Vollzeit |</span></td></tr>`;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const companies = [
  { key: 'bethesda-spital', fetchJobs: fetchAllBethesdaSpitalJobs },
  { key: 'buergenstock-hotels', fetchJobs: fetchAllBuergenstockHotelsJobs },
  { key: 'gesundheitszentrum-fricktal', fetchJobs: fetchAllGesundheitszentrumFricktalJobs },
  { key: 'kispi-zurich', fetchJobs: fetchAllKispiZurichJobs },
  { key: 'klinik-im-hasel', fetchJobs: fetchAllKlinikImHaselJobs },
  { key: 'klinik-sonnenhalde', fetchJobs: fetchAllKlinikSonnenhaldeJobs },
  { key: 'kzu', fetchJobs: fetchAllKzuJobs },
  { key: 'nsn-medical', fetchJobs: fetchAllNsnMedicalJobs },
  { key: 'sanatorium-kilchberg', fetchJobs: fetchAllSanatoriumKilchbergJobs },
  { key: 'szb-chb', fetchJobs: fetchAllSzbChbJobs },
];
for (const company of companies) {
  describe(`${company.key} Umantis source publication`, () => {
    it.each([
      ['valid', swiss(sourceDay), sourceDay],
      ['absent', '', ''],
      ['invalid calendar', '30.02.2026', ''],
      ['future', swiss(futureDay), ''],
    ])('%s remains strict through the actual scheduled wrapper', async (_label, raw, expected) => {
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/Jobs/All')) return new Response(`<table>${row('416', raw)}</table>`, { status: 200 });
        return new Response(detail, { status: 200 });
      }));
      const jobs = await company.fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ companyKey: company.key, title, datePosted: expected, postedDate: expected,
        postingDateSource: expected ? 'reported' : 'unknown' });
      expect(jobs[0].description).toContain('Fakturierung');
      expect(jobs[0].canton).toBeTruthy();
      expect(jobs[0].url).toContain('/Vacancies/416/');
      expect(jobs[0].crawledAt).toBeTruthy();
    });
  });
}

describe('Online seit belongs only to its own listing row', () => {
  it('rejects a malformed five-digit year rather than reading its prefix', () => {
    expect(parseUmantisListing(`<table>${row('416', '15.05.20260')}</table>`).entries[0].datum).toBe('');
  });
  it('does not inherit the following row publication', () => {
    const { entries } = parseUmantisListing(`<table>${row('416', '')}${row('417', swiss(sourceDay))}</table>`);
    expect(entries.map((entry: { datum: string }) => entry.datum)).toEqual(['', swiss(sourceDay)]);
  });
  it('does not inherit a previous row date placed after its link', () => {
    const previous = `<tr><td><a href="/Vacancies/415/Description/1">${title}</a><span>Online seit: ${swiss(sourceDay)}</span></td></tr>`;
    const { entries } = parseUmantisListing(`<table>${previous}${row('416', '')}</table>`);
    expect(entries.map((entry: { datum: string }) => entry.datum)).toEqual([swiss(sourceDay), '']);
  });
  it('reads an explicitly labelled publication in the newer row UI', () => {
    const html = row('416', swiss(sourceDay)).replace('legacy-row', 'table-as-list__contentrow1');
    expect(parseUmantisListing(html).entries[0].datum).toBe(swiss(sourceDay));
  });
});
