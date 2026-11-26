import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllArxadaJobs } from '../scripts/lib/arxada-job-parser.mjs';
import { fetchAllFielmannJobs } from '../scripts/lib/fielmann-job-parser.mjs';
import { fetchAllHuntsmanJobs } from '../scripts/lib/huntsman-job-parser.mjs';
import { fetchAllSwissLifeJobs } from '../scripts/lib/swiss-life-job-parser.mjs';
import { fetchJuliusBaerJobs } from '../scripts/update-julius-baer-jobs.mjs';
import { fetchFnzJobs } from '../scripts/update-fnz-jobs.mjs';
import {
  isWorkdayListingRequest,
  resetWorkdayImplicitRateLimitStateForTests,
  WorkdayRateLimitError,
} from '../scripts/lib/ats-clients/workday-client.mjs';

const publicFetchCallers = [
  ['Arxada parser', fetchAllArxadaJobs],
  ['Fielmann parser', fetchAllFielmannJobs],
  ['Huntsman parser', fetchAllHuntsmanJobs],
  ['Swiss Life parser', fetchAllSwissLifeJobs],
  ['Julius Baer runner', fetchJuliusBaerJobs],
  ['FNZ updater', fetchFnzJobs],
] as const;

afterEach(() => {
  resetWorkdayImplicitRateLimitStateForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(publicFetchCallers)('%s Workday rate-limit propagation', (_name, fetchJobs) => {
  it('preserves the typed rate-limit error from its listing request', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '0' },
    })));

    await expect(fetchJobs()).rejects.toBeInstanceOf(WorkdayRateLimitError);
  });

  it('does not turn an observed listing failure into an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    await expect(fetchJobs()).rejects.toThrow();
  });
});

describe('Workday listing request classification', () => {
  it('requires the tenant-owned /jobs POST endpoint', () => {
    const apiBase = 'https://juliusbaer.wd3.myworkdayjobs.com/wday/cxs/juliusbaer/External';
    expect(isWorkdayListingRequest(apiBase, `${apiBase}/jobs`, 'POST')).toBe(true);
    expect(isWorkdayListingRequest(apiBase, `${apiBase}/jobs`, 'GET')).toBe(false);
    expect(isWorkdayListingRequest(apiBase, `${apiBase}/job/req-1`, 'POST')).toBe(false);
    expect(isWorkdayListingRequest(apiBase, 'https://example.com/wday/cxs/juliusbaer/External/jobs', 'POST')).toBe(false);
  });
});
