import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchWorkdayJobs: vi.fn() }));

vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/ats-clients/workday-client.mjs')>(),
  fetchWorkdayJobs: mocks.fetchWorkdayJobs,
}));

import {
  WorkdayApiError,
  WorkdayRateLimitError,
  WorkdayAuthError,
} from '../scripts/lib/ats-clients/workday-client.mjs';
import { fetchAllBernerMontageJobs } from '../scripts/lib/berner-montage-job-parser.mjs';
import { fetchAllBossardJobs } from '../scripts/lib/bossard-job-parser.mjs';

const WORKDAY_SWISS_LOCATION_ID = '187134fccb084a0ea9b4b95f23890dbe';
const crawlers = [
  { name: 'Berner Montage', fetchAllJobs: fetchAllBernerMontageJobs },
  { name: 'Bossard', fetchAllJobs: fetchAllBossardJobs },
];

afterEach(() => {
  mocks.fetchWorkdayJobs.mockReset();
  vi.restoreAllMocks();
});

describe.each(crawlers)('$name Workday facet fallback', ({ fetchAllJobs }) => {
  it.each([
    ['429 rate limit', () => new WorkdayRateLimitError('https://workday.test/jobs', {
      consecutiveFailures: 1,
      retryAfterMs: 0,
      circuitOpen: false,
    })],
    ['500 server error', () => new WorkdayApiError('Workday API error', 500, 'https://workday.test/jobs')],
    ['transport failure', () => new TypeError('fetch failed')],
    ['anti-bot error', () => new WorkdayAuthError('Workday auth block', 403, 'https://workday.test/jobs')],
  ])('does not retry the listing without its Swiss filter after %s', async (_label, makeError) => {
    const error = makeError();
    mocks.fetchWorkdayJobs.mockImplementationOnce(async function* () {
      throw error;
    });

    if (error instanceof WorkdayAuthError) {
      await expect(fetchAllJobs()).resolves.toEqual([]);
    } else {
      await expect(fetchAllJobs()).rejects.toBe(error);
    }

    expect(mocks.fetchWorkdayJobs).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWorkdayJobs.mock.calls[0][1]).toMatchObject({
      appliedFacets: { locationCountry: [WORKDAY_SWISS_LOCATION_ID] },
    });
  });

  it.each([400, 422])('keeps the unfiltered fallback for Workday API HTTP %i', async (statusCode) => {
    mocks.fetchWorkdayJobs
      .mockImplementationOnce(async function* () {
        throw new WorkdayApiError(`Workday API error HTTP ${statusCode}`, statusCode, 'https://workday.test/jobs');
      })
      .mockImplementationOnce(async function* () {});

    await expect(fetchAllJobs()).resolves.toEqual([]);

    expect(mocks.fetchWorkdayJobs).toHaveBeenCalledTimes(2);
    const [[facetedApiBase, facetedOptions], [fallbackApiBase, fallbackOptions]] = mocks.fetchWorkdayJobs.mock.calls;
    expect(fallbackApiBase).toBe(facetedApiBase);
    expect(facetedOptions).toMatchObject({
      appliedFacets: { locationCountry: [WORKDAY_SWISS_LOCATION_ID] },
    });
    expect(fallbackOptions.appliedFacets).toBeUndefined();
  });
});
