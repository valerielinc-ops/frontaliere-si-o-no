import { describe, expect, it, vi } from 'vitest';

const { mockListings } = vi.hoisted(() => ({ mockListings: [] as Array<Record<string, string>> }));

vi.mock('../scripts/lib/prospector/spec-crawler.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSpec: vi.fn((companyKey: string) => ({ companyKey })),
  runSpecInProduction: vi.fn(async () => mockListings),
}));

import { fetchAllElektrikerElektromonteurJobsChJobs } from '../scripts/lib/elektriker-elektromonteur-jobs-ch-job-parser.mjs';
import { fetchAllNishcomJobs } from '../scripts/lib/nishcom-job-parser.mjs';
import { fetchAllOpaccSoftwareAgJobs } from '../scripts/lib/opacc-software-ag-job-parser.mjs';
import { fetchAllPksBewerbungChJobs } from '../scripts/lib/pks-bewerbung-ch-job-parser.mjs';
import { fetchAllPolicelavauxChJobs } from '../scripts/lib/policelavaux-ch-job-parser.mjs';
import { fetchAllAzSystemsChJobs } from '../scripts/lib/az-systems-ch-job-parser.mjs';
import { fetchAllEqeChJobs } from '../scripts/lib/eqe-ch-job-parser.mjs';
import { fetchAllInternezzoAgJobs } from '../scripts/lib/internezzo-ag-job-parser.mjs';
import { fetchAllInviasSwissJobs } from '../scripts/lib/invias-swiss-job-parser.mjs';
import { fetchAllJobdoorChJobs } from '../scripts/lib/jobdoor-ch-job-parser.mjs';
import { fetchAllLemcoPrecisionComJobs } from '../scripts/lib/lemco-precision-com-job-parser.mjs';
import { fetchAllLipsuisseChJobs } from '../scripts/lib/lipsuisse-ch-job-parser.mjs';
import { fetchAllMountainsChJobs } from '../scripts/lib/mountains-ch-job-parser.mjs';
import { fetchAllSkanComJobs } from '../scripts/lib/skan-com-job-parser.mjs';
import { fetchAllZindelUnitedSwissJobs } from '../scripts/lib/zindel-united-swiss-job-parser.mjs';

const parsers = [
  fetchAllElektrikerElektromonteurJobsChJobs,
  fetchAllNishcomJobs,
  fetchAllOpaccSoftwareAgJobs,
  fetchAllPksBewerbungChJobs,
  fetchAllPolicelavauxChJobs,
  fetchAllAzSystemsChJobs,
  fetchAllEqeChJobs,
  fetchAllInternezzoAgJobs,
  fetchAllInviasSwissJobs,
  fetchAllJobdoorChJobs,
  fetchAllLemcoPrecisionComJobs,
  fetchAllLipsuisseChJobs,
  fetchAllMountainsChJobs,
  fetchAllSkanComJobs,
  fetchAllZindelUnitedSwissJobs,
];

function listing(url: string): Record<string, string> {
  return {
    title: 'Test vacancy',
    description: 'A sufficiently detailed vacancy description for the parser contract.',
    location: 'Lugano',
    addressLocality: 'Lugano',
    addressRegion: 'TI',
    addressCountry: 'CH',
    timeType: 'full-time',
    url,
  };
}

function setMockListings(
  entries: Array<Record<string, string>>,
  metadata: Record<string, unknown> = {},
) {
  for (const key of ['fetchOutcome', 'discoveredCount']) {
    Reflect.deleteProperty(mockListings, key);
  }
  mockListings.splice(0, mockListings.length, ...entries);
  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(mockListings, key, {
      configurable: true,
      enumerable: false,
      value,
    });
  }
}

describe('promoted Prospector parser contract', () => {
  it('emits complete address fields and one identity for tracking-only URL variants', async () => {
    for (const fetchJobs of parsers) {
      mockListings.splice(0, mockListings.length, listing('https://jobs.example.test/detail/123?utm_source=first'));
      const first = (await fetchJobs())[0];

      mockListings.splice(0, mockListings.length, listing('https://jobs.example.test/detail/123?utm_source=second'));
      const second = (await fetchJobs())[0];

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second.id).toBe(first.id);
      expect(second.url).toBe('https://jobs.example.test/detail/123');
      expect(second.applyUrl).toBe('https://jobs.example.test/detail/123');
      expect(second.postalCode).toBeTruthy();
      expect(second.streetAddress).toBeTruthy();
    }
  });

  it('preserves source fetch metadata through mapping and empty results', async () => {
    for (const fetchJobs of parsers) {
      setMockListings([listing('https://jobs.example.test/detail/123')], {
        fetchOutcome: 'ok',
        discoveredCount: 1,
      });
      const jobs = await fetchJobs();

      expect(jobs.fetchOutcome).toBe('ok');
      expect(jobs.discoveredCount).toBe(1);

      setMockListings([], {
        fetchOutcome: 'filtered_empty',
        discoveredCount: 1,
      });
      const empty = await fetchJobs();

      expect(empty).toHaveLength(0);
      expect(empty.fetchOutcome).toBe('filtered_empty');
      expect(empty.discoveredCount).toBe(1);
    }
  });
});
