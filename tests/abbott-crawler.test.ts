import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ABBOTT_COMPANY_NAME,
  ABBOTT_KEY,
  fetchAllAbbottJobs,
  resolveAbbottLocation,
} from '../scripts/lib/abbott-job-parser.mjs';

// Replay harness for fetchAllAbbottJobs: the Workday network calls are
// replaced by the payloads below, every pure helper of the client stays real.
const workdayReplay = vi.hoisted(() => ({
  listings: [] as Array<Record<string, unknown>>,
  details: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    async *fetchWorkdayJobs() {
      yield* workdayReplay.listings;
    },
    fetchWorkdayJobDetail: async (_apiBase: string, externalPath: string) =>
      workdayReplay.details.get(externalPath) ?? null,
  };
});

describe('Abbott crawler location resolution', () => {
  it('uses the structured requisition locality over a Workday listing label', () => {
    expect(resolveAbbottLocation(
      'Switzerland - Basel',
      { descriptor: 'Switzerland > Allschwil : H-127' },
    )).toBe('Allschwil');
    expect(resolveAbbottLocation(
      'Switzerland - Remote',
      { descriptor: 'Switzerland > Baar : Neuhofstrasse 23' },
    )).toBe('Baar');
  });

  it('falls back to the listing locality when the requisition field is absent', () => {
    expect(resolveAbbottLocation('Switzerland - Zurich')).toBe('Zurich');
  });

  it('reads no locality from a listing label that names a work mode (issue 9839 rule)', () => {
    expect(resolveAbbottLocation('Switzerland - Remote')).toBe('');
    expect(resolveAbbottLocation('2 Locations')).toBe('');
  });

  it('does not relabel an unresolved or foreign requisition with the listing city', () => {
    expect(resolveAbbottLocation(
      'Switzerland - Basel',
      { descriptor: 'Germany > Frankfurt' },
    )).toBe('');
    expect(resolveAbbottLocation(
      'Switzerland - Basel',
      { descriptor: 'Remote / Unmapped' },
    )).toBe('');
  });

  // Sibling of issue 9839 (nvidia-zurich): a listing whose location names no
  // Swiss place used to be published as `Remote / BS` or `Basel / BS`, the HQ
  // defaults. The listing labels and the requisition descriptor below are the
  // live shapes of 2026-09-25; the detail payloads without a requisition field
  // are the case of a failed detail fetch.
  describe('fetchAllAbbottJobs replay: a job needs a named Swiss locality', () => {
    const description = 'Abbott is looking for a specialist to join the Swiss team. '.repeat(3);
    const replay = [
      { title: 'Medical Educator - Romandie', path: '/job/Switzerland---Remote/Medical-Educator_R1', label: 'Switzerland - Remote', requisition: null },
      { title: 'Klinischer Kalzium-Spezialist', path: '/job/Switzerland---Remote/Klinischer-Kalzium-Spezialist_R2', label: 'Switzerland - Remote', requisition: 'Switzerland > Baar : Neuhofstrasse 23' },
      { title: 'Territory Manager', path: '/job/Switzerland---Basel/Territory-Manager_R3', label: '2 Locations', requisition: null },
      { title: 'Quality Specialist', path: '/job/Switzerland---Basel/Quality-Specialist_R4', label: 'Switzerland - Basel', requisition: null },
    ];

    afterEach(() => {
      workdayReplay.listings = [];
      workdayReplay.details.clear();
      vi.restoreAllMocks();
    });

    it('skips a work-mode or rollup label without a requisition site, keeps named localities', async () => {
      for (const job of replay) {
        workdayReplay.listings.push({
          title: job.title,
          externalPath: job.path,
          locationsText: job.label,
          postedOn: 'Posted 3 Days Ago',
          bulletFields: [job.path.split('_').pop()],
        });
        workdayReplay.details.set(job.path, {
          jobPostingInfo: {
            title: job.title,
            timeType: 'Full time',
            jobDescription: `<p>${description}</p>`,
            ...(job.requisition ? { jobRequisitionLocation: { descriptor: job.requisition } } : {}),
          },
        });
      }
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
        fn();
        return 0;
      }) as unknown as typeof setTimeout);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const jobs = await fetchAllAbbottJobs();

      expect(jobs.map((job: { title: string; location: string; canton: string }) => [job.title, job.location, job.canton]))
        .toEqual([
          ['Klinischer Kalzium-Spezialist', 'Baar', 'ZG'],
          ['Quality Specialist', 'Basel', 'BS'],
        ]);
    });
  });

  // Work-mode labels decorated with a country, region or canton (EN/DE/FR/IT),
  // with no requisition site: no segment may become the locality.
  describe('work-mode listing labels (issue 9839 rule)', () => {
    afterEach(() => {
      workdayReplay.listings = [];
      workdayReplay.details.clear();
      vi.restoreAllMocks();
    });

    async function replayLabel(label: string) {
      const path = '/job/Switzerland/Specialist_R9';
      workdayReplay.listings.push({
        title: 'Specialist', externalPath: path, locationsText: label, postedOn: 'Posted 3 Days Ago', bulletFields: ['R9'],
      });
      workdayReplay.details.set(path, {
        jobPostingInfo: { title: 'Specialist', timeType: 'Full time', jobDescription: `<p>${'Abbott Swiss role. '.repeat(8)}</p>` },
      });
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
        fn();
        return 0;
      }) as unknown as typeof setTimeout);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      return fetchAllAbbottJobs();
    }

    it.each([
  'Remote, Switzerland',
  'Home Office - Switzerland',
  'Switzerland - Remote',
  'Hybrid (CH)',
  'Hybrid (ZH)',
  'Homeoffice',
  'Télétravail, Suisse',
  'Telelavoro - Ticino',
])('reads no locality from %s and publishes no job', async (label) => {
      expect(resolveAbbottLocation(label)).toBe('');
      expect(await replayLabel(label)).toEqual([]);
    });

    it('keeps the named place when a work mode sits beside it', async () => {
      expect(resolveAbbottLocation('Switzerland - Zurich - Remote')).toBe('Zurich');
      expect(resolveAbbottLocation('Remote - Zurich')).toBe('Zurich');
      const jobs = await replayLabel('Remote - Zurich');
      expect(jobs.map((job: { location: string; canton: string }) => [job.location, job.canton])).toEqual([['Zurich', 'ZH']]);
    });
  });

  it('keeps the parser identity stable', () => {
    expect(ABBOTT_KEY).toBe('abbott');
    expect(ABBOTT_COMPANY_NAME).toBe('Abbott');
  });
});
