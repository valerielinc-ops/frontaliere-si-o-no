import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProspectiveChParser } from '../scripts/lib/prospective-ch-job-parser-common.mjs';

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

  it('normalizes space/hyphen postal separators and never turns separator-only input into the HQ city', async () => {
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
      { title: 'Malformed location', location: '6850--', postalCode: '6850', streetAddress: '' },
    ]);
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
