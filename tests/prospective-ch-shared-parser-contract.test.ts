import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAllKlinikenValensJobs } from '../scripts/lib/kliniken-valens-job-parser.mjs';
import { createProspectiveChParser } from '../scripts/lib/prospective-ch-job-parser-common.mjs';
import { fetchAllSpitexBaselJobs } from '../scripts/lib/spitex-basel-job-parser.mjs';

const EXPECTED_CONSUMERS = [
  'asana-spital-job-parser.mjs',
  'balgrist-job-parser.mjs',
  'baloise-job-parser.mjs',
  'brack-alltron-job-parser.mjs',
  'buehler-job-parser.mjs',
  'claraspital-job-parser.mjs',
  'concara-job-parser.mjs',
  'epi-stiftung-job-parser.mjs',
  'equans-job-parser.mjs',
  'grand-resort-bad-ragaz-job-parser.mjs',
  'gz-dielsdorf-job-parser.mjs',
  'helvetia-job-parser.mjs',
  'kanton-basel-landschaft-job-parser.mjs',
  'klinik-lengg-job-parser.mjs',
  'klinik-sgm-job-parser.mjs',
  'kliniken-valens-job-parser.mjs',
  'livit-job-parser.mjs',
  'luks-job-parser.mjs',
  'paraplegie-job-parser.mjs',
  'pdag-job-parser.mjs',
  'pzm-muensingen-job-parser.mjs',
  'raiffeisen-job-parser.mjs',
  'schulthess-klinik-job-parser.mjs',
  'spitaeler-schaffhausen-job-parser.mjs',
  'spital-buelach-job-parser.mjs',
  'spital-nidwalden-job-parser.mjs',
  'spitex-basel-job-parser.mjs',
  'stadt-bern-job-parser.mjs',
  'stadt-luzern-job-parser.mjs',
  'unibe-job-parser.mjs',
  'uzh-job-parser.mjs',
  'viva-luzern-job-parser.mjs',
  'volksschule-luzern-job-parser.mjs',
].sort();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Prospective.ch shared parser contract', () => {
  it('keeps all 33 direct consumers on the audited shared factory', () => {
    const libDir = path.resolve(process.cwd(), 'scripts/lib');
    const consumers = readdirSync(libDir)
      .filter((file) => file.endsWith('-job-parser.mjs'))
      .filter((file) => readFileSync(path.join(libDir, file), 'utf8')
        .includes('createProspectiveChParser({'))
      .sort();

    expect(consumers).toEqual(EXPECTED_CONSUMERS);
    for (const file of consumers) {
      expect(readFileSync(path.join(libDir, file), 'utf8'))
        .toContain("from './prospective-ch-job-parser-common.mjs'");
    }
  });

  it('normalizes space/hyphen postal separators and never turns separator-only input into the HQ city or canton', async () => {
    const parser = createProspectiveChParser({
      companyKey: 'prospective-observer',
      companyName: 'Prospective Observer',
      companyDomain: 'observer.example',
      mediumId: '999999',
      defaultCanton: 'TI',
      defaultCity: 'Mendrisio',
      defaultPostalCode: '6850',
      defaultStreetAddress: 'Via HQ 1',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        total: 3,
        jobs: [
          {
            title: 'Dotted location',
            links: { directlink: 'https://observer.example/jobs/1' },
            szas: { sza_title: 'Dotted location', 'sza_location.city': '6850-Mendrisio' },
          },
          {
            title: 'Flat location',
            links: { directlink: 'https://observer.example/jobs/2' },
            szas: { sza_title: 'Flat location', sza_location: 'Via Industria 10, 6900-Lugano' },
          },
          {
            title: 'Malformed location',
            links: { directlink: 'https://observer.example/jobs/3' },
            szas: { sza_title: 'Malformed location', 'sza_location.city': '6850--' },
          },
        ],
      }),
    }));

    const jobs = await parser.fetchAllJobs();
    expect(jobs.map((job) => ({
      title: job.title,
      location: job.location,
      postalCode: job.postalCode,
      streetAddress: job.streetAddress,
    }))).toEqual([
      { title: 'Dotted location', location: 'Mendrisio', postalCode: '6850', streetAddress: 'Via HQ 1' },
      { title: 'Flat location', location: 'Lugano', postalCode: '6900', streetAddress: 'Via Industria 10' },
      // `6850--` names no place: it is dropped, not published with the HQ canton.
    ]);
  });

  describe('source location, never the HQ fallback (issue 9844)', () => {
    type Listing = { szas?: Record<string, string>; attributes?: Record<string, string[]> };
    const feed = (listings: Listing[]) => {
      const jobs = listings.map((listing, index) => ({
        id: index + 1,
        title: `Role ${index + 1}`,
        links: { directlink: `https://observer.example/jobs/${index + 1}` },
        ...listing,
        szas: { sza_title: `Role ${index + 1}`, ...listing.szas },
      }));
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total: jobs.length, jobs }),
      }));
    };
    const where = (jobs: Array<{ title: string; location: string; canton: string; addressCountry: string }>) =>
      jobs.map(({ title, location, canton, addressCountry }) => ({ title, location, canton, addressCountry }));
    const hq = {
      companyKey: 'prospective-hq',
      companyName: 'Prospective HQ',
      companyDomain: 'observer.example',
      mediumId: '999996',
      defaultCanton: 'SG',
      defaultCity: 'Uzwil',
      defaultPostalCode: '9240',
    };

    it('drops foreign, absent and unresolved locations instead of stamping defaultCanton', async () => {
      feed([
        { szas: { 'sza_location.city': 'Wuxi' } },
        { szas: { 'sza_location.city': '' } },
        { szas: { 'sza_workplace.city': 'Alzenau', sza_workplace: 'Siemensstraße 88, Alzenau, Deutschland' } },
        { szas: { 'sza_workplace.city': 'Prague' } },
        { attributes: { 10: ['Forschung & Entwicklung'] } },
        { szas: { 'sza_location.city': '9240 Uzwil' } },
      ]);
      const jobs = await createProspectiveChParser(hq).fetchAllJobs();
      expect(where(jobs)).toEqual([
        { title: 'Role 6', location: 'Uzwil', canton: 'SG', addressCountry: 'CH' },
      ]);
      expect(jobs[0].postalCode).toBe('9240');
    });

    it('tries the next source field when the first names no Swiss place', async () => {
      feed([
        // UZH puts the street in sza_location.city and the city in sza_workplace.city.
        { szas: { 'sza_location.city': 'Kurvenstrasse 31', 'sza_workplace.city': 'Zürich' } },
        // Stadt Bern: flat location without ZIP.
        { szas: { sza_location: 'Murtenstrasse 98, Bern' }, attributes: { 10: ['1'] } },
        { szas: { sza_location: 'St. Niklaus, VS, Schweiz' } },
      ]);
      const jobs = await createProspectiveChParser(hq).fetchAllJobs();
      expect(where(jobs).map(({ location, canton }) => `${location}/${canton}`))
        .toEqual(['Zürich/ZH', 'Bern/BE', 'St. Niklaus/VS']);
    });

    it('allSitesInDefaultCanton only disambiguates a BFS municipality of that canton', async () => {
      const listings = [
        { szas: { 'sza_location.city': 'Oberwil', 'sza_location.zip': '4104' } },
        { szas: { 'sza_location.city': 'Santiago de Chile, Chile', 'sza_location.zip': '2206' } },
        { szas: { 'sza_location.city': 'Wuxi' } },
        { szas: {} },
      ];
      const bl = { ...hq, defaultCanton: 'BL', defaultCity: 'Liestal', defaultPostalCode: '4410' };

      feed(listings);
      expect(await createProspectiveChParser(bl).fetchAllJobs()).toEqual([]);

      feed(listings);
      const jobs = await createProspectiveChParser({ ...bl, allSitesInDefaultCanton: true }).fetchAllJobs();
      expect(where(jobs)).toEqual([
        { title: 'Role 1', location: 'Oberwil', canton: 'BL', addressCountry: 'CH' },
      ]);
    });

    it('siteCantons maps only the declared localities', async () => {
      const listings = [
        { szas: { 'sza_location.city': '8636 Wald' } },
        { szas: { 'sza_location.city': 'Valens' } },
        { szas: { 'sza_location.city': 'Wald ZH' } },
        { szas: { 'sza_location.city': 'Wolfsburg' } },
      ];
      feed(listings);
      const jobs = await createProspectiveChParser({ ...hq, siteCantons: { Wald: 'ZH', valens: 'sg' } }).fetchAllJobs();
      expect(where(jobs).map(({ location, canton }) => `${location}/${canton}`))
        .toEqual(['Wald/ZH', 'Valens/SG', 'Wald ZH/ZH']);

      feed(listings);
      expect(where(await createProspectiveChParser(hq).fetchAllJobs()).map(({ location }) => location))
        .toEqual(['Wald ZH']);
    });

    it('singleLocality places listings without a location at the declared site, never a foreign one', async () => {
      feed([
        { attributes: { 10: ['Pflege'] } },
        { szas: { 'sza_location.city': 'Prague' } },
        { szas: { 'sza_location.city': 'Riehen' } },
      ]);
      const jobs = await createProspectiveChParser({
        ...hq, defaultCanton: 'BS', defaultCity: 'Basel', defaultPostalCode: '4051', singleLocality: true,
      }).fetchAllJobs();
      expect(where(jobs).map(({ location, canton }) => `${location}/${canton}`))
        .toEqual(['Basel/BS', 'Riehen/BS']);
    });

    // Location fields of listings in the captured feeds (2026-09-25).
    it('Kliniken Valens: clinic sites resolve to their canton, Wald to ZH instead of the SG HQ', async () => {
      feed([
        { szas: { 'sza_location.city': 'Valens', 'sza_location.zip': '7317', 'sza_location.region': 'Deutschschweiz' } },
        { szas: { 'sza_location.city': 'Walenstadtberg', 'sza_location.zip': '8881' } },
        { szas: { 'sza_location.city': 'Wald', 'sza_location.zip': '8636', 'sza_location.region': 'Zürcher Oberland' } },
        { szas: { 'sza_location.city': 'Wald ZH', 'sza_location.zip': '8636' } },
        { szas: { 'sza_location.city': 'Walzenhausen' } },
      ]);
      const jobs = await fetchAllKlinikenValensJobs();
      expect(jobs.map((job: { location: string; canton: string; postalCode: string }) => (
        `${job.location}/${job.canton}/${job.postalCode}`
      ))).toEqual([
        'Valens/SG/7317',
        'Walenstadtberg/SG/8881',
        'Wald/ZH/8636',
        'Wald ZH/ZH/8636',
        'Walzenhausen/AR/',
      ]);
    });

    it('SPITEX BASEL: listings without a location stay in Basel through the declared single locality', async () => {
      feed([
        { attributes: { 10: ['Pflege'] } },
        { szas: { 'sza_location.street': 'Feierabendstrasse 44', 'sza_location.zip': '4051' }, attributes: { 10: ['Pflege'] } },
      ]);
      const jobs = await fetchAllSpitexBaselJobs();
      expect(jobs.map((job: { location: string; canton: string; postalCode: string }) => (
        `${job.location}/${job.canton}/${job.postalCode}`
      ))).toEqual(['Basel/BS/4051', 'Basel/BS/4051']);
    });

    it('rejects declarative location config that is not a Swiss canton', () => {
      expect(() => createProspectiveChParser({ ...hq, siteCantons: { Wald: 'XX' } })).toThrow(/siteCantons/);
      expect(() => createProspectiveChParser({ ...hq, defaultCanton: 'CH', allSitesInDefaultCanton: true }))
        .toThrow(/Swiss canton code/);
      expect(() => createProspectiveChParser({ ...hq, defaultCity: '', singleLocality: true }))
        .toThrow(/defaultCity/);
    });
  });

  it('strict pagination reaches a total above one page using unique source identities', async () => {
    const job = (id: number) => ({
      id,
      title: `Role ${id}`,
      links: { directlink: `https://observer.example/jobs/${id}` },
      szas: { sza_title: `Role ${id}`, 'sza_location.city': '6850 Mendrisio' },
    });
    const firstPage = Array.from({ length: 100 }, (_, index) => job(index));
    const secondPage = [job(100)];
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const offset = Number(new URL(rawUrl).searchParams.get('offset'));
      return {
        ok: true,
        json: async () => ({ total: 101, jobs: offset === 0 ? firstPage : secondPage }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const parser = createProspectiveChParser({
      companyKey: 'prospective-strict',
      companyName: 'Prospective Strict',
      companyDomain: 'observer.example',
      mediumId: '999998',
      defaultCanton: 'TI',
      defaultCity: 'Mendrisio',
      defaultPostalCode: '6850',
      strictPagination: true,
    });
    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('offset')).toBe('100');
  });

  it('strict pagination fails when a later page adds no unique source identity', async () => {
    const job = (id: number) => ({
      id,
      title: `Role ${id}`,
      links: { directlink: `https://observer.example/jobs/${id}` },
      szas: { sza_title: `Role ${id}`, 'sza_location.city': '6850 Mendrisio' },
    });
    const firstPage = Array.from({ length: 100 }, (_, index) => job(index));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ total: 101, jobs: firstPage }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const parser = createProspectiveChParser({
      companyKey: 'prospective-strict-repeat',
      companyName: 'Prospective Strict Repeat',
      companyDomain: 'observer.example',
      mediumId: '999997',
      defaultCanton: 'TI',
      defaultCity: 'Mendrisio',
      defaultPostalCode: '6850',
      strictPagination: true,
    });

    await expect(parser.fetchAllJobs()).rejects.toThrow(/pagination did not advance/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
