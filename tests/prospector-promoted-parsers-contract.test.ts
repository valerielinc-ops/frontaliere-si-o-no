import { describe, expect, it, vi } from 'vitest';

const { mockListings } = vi.hoisted(() => ({ mockListings: [] as Array<Record<string, string>> }));

vi.mock('../scripts/lib/prospector/spec-crawler.mjs', () => ({
  loadSpec: vi.fn((companyKey: string) => ({ companyKey })),
  runSpecInProduction: vi.fn(async () => mockListings),
}));

import { fetchAllElektrikerElektromonteurJobsChJobs } from '../scripts/lib/elektriker-elektromonteur-jobs-ch-job-parser.mjs';
import { fetchAllNishcomJobs } from '../scripts/lib/nishcom-job-parser.mjs';
import { fetchAllOpaccSoftwareAgJobs } from '../scripts/lib/opacc-software-ag-job-parser.mjs';
import { fetchAllPksBewerbungChJobs } from '../scripts/lib/pks-bewerbung-ch-job-parser.mjs';
import { fetchAllPolicelavauxChJobs } from '../scripts/lib/policelavaux-ch-job-parser.mjs';

const parsers = [
  fetchAllElektrikerElektromonteurJobsChJobs,
  fetchAllNishcomJobs,
  fetchAllOpaccSoftwareAgJobs,
  fetchAllPksBewerbungChJobs,
  fetchAllPolicelavauxChJobs,
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
});
