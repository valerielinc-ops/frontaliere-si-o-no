import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllArxadaJobs } from '../scripts/lib/arxada-job-parser.mjs';
import { fetchAllFielmannJobs } from '../scripts/lib/fielmann-job-parser.mjs';
import { fetchAllHuntsmanJobs } from '../scripts/lib/huntsman-job-parser.mjs';
import { fetchAllSwissLifeJobs } from '../scripts/lib/swiss-life-job-parser.mjs';
import { fetchFnzJobs } from '../scripts/update-fnz-jobs.mjs';
import {
  resetWorkdayImplicitRateLimitStateForTests,
  WorkdayRateLimitError,
} from '../scripts/lib/ats-clients/workday-client.mjs';

const publicFetchCallers = [
  ['Arxada parser', fetchAllArxadaJobs],
  ['Fielmann parser', fetchAllFielmannJobs],
  ['Huntsman parser', fetchAllHuntsmanJobs],
  ['Swiss Life parser', fetchAllSwissLifeJobs],
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

  it('does not turn a failed listing request into an empty result', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    await expect(fetchJobs()).rejects.toThrow(/HTTP 404/);
  });
});
