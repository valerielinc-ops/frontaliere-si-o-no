import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/ats-clients/workday-client.mjs')>();
  return {
    ...actual,
    fetchWorkdayJobs: vi.fn(),
    fetchWorkdayBoardSummary: vi.fn(),
  };
});

import { createWorkdaySwissParser } from '../scripts/lib/workday-swiss-job-parser-common.mjs';
import {
  fetchWorkdayBoardSummary,
  fetchWorkdayJobs,
  WorkdayApiError,
  WorkdayAuthError,
  WorkdayRateLimitError,
} from '../scripts/lib/ats-clients/workday-client.mjs';

const SWISS_ID = '187134fccb084a0ea9b4b95f23890dbe';
const listMock = vi.mocked(fetchWorkdayJobs);
const summaryMock = vi.mocked(fetchWorkdayBoardSummary);

function makeParser() {
  return createWorkdaySwissParser({
    companyKey: 'testco',
    companyName: 'Test Co',
    companyDomain: 'testco.com',
    tenantHost: 'testco.wd3.myworkdayjobs.com',
    sitePath: 'Test_Careers',
    defaultCanton: 'ZH',
    defaultCity: 'Zurich',
  });
}

function fail(error: Error) {
  return (async function* () {
    throw error;
  })();
}

function empty() {
  return (async function* () {})();
}

function requestedFacets() {
  return listMock.mock.calls.map(([, options]) => options.appliedFacets);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('createWorkdaySwissParser — fail-closed facet transport errors', () => {
  it.each([
    ['HTTP 500', () => new WorkdayApiError('server error', 500)],
    ['network failure', () => new TypeError('socket failed')],
    ['HTTP 429', () => new WorkdayRateLimitError('https://testco/jobs', {
      consecutiveFailures: 2,
      retryAfterMs: 0,
      circuitOpen: true,
    })],
  ])('propagates %s without a board summary or unfiltered request', async (_label, makeError) => {
    const error = makeError();
    listMock.mockImplementation(() => fail(error) as any);

    await expect(makeParser().fetchAllJobs()).rejects.toBe(error);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(summaryMock).not.toHaveBeenCalled();
    expect(requestedFacets()).toEqual([{ locationCountry: [SWISS_ID] }]);
  });

  it('marks an initial Workday auth block and stops without another request', async () => {
    const authError = new WorkdayAuthError('anti-bot block', 403);
    listMock.mockImplementation(() => fail(authError) as any);

    const jobs = await makeParser().fetchAllJobs();

    expect(jobs).toHaveLength(0);
    expect((jobs as any).fetchOutcome).toBe('anti_bot_block');
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(summaryMock).not.toHaveBeenCalled();
    expect(requestedFacets()).toEqual([{ locationCountry: [SWISS_ID] }]);
  });

  it.each([400, 422])('allows HTTP %i facet validation to reach the unfiltered fallback', async (statusCode) => {
    listMock.mockImplementation((_apiBase, options) => (
      Object.keys(options.appliedFacets).length > 0
        ? fail(new WorkdayApiError('facet rejected', statusCode)) as any
        : empty() as any
    ));
    summaryMock.mockResolvedValue({ total: 0, postingCount: 0, facets: [] });

    const jobs = await makeParser().fetchAllJobs();

    expect(jobs).toHaveLength(0);
    expect(requestedFacets()).toEqual([
      { locationCountry: [SWISS_ID] },
      {},
    ]);
  });

  it('allows a discovered facet retry to fall back only when that retry also returns 400/422', async () => {
    listMock.mockImplementation((_apiBase, options) => {
      const key = Object.keys(options.appliedFacets)[0];
      if (key === 'locationCountry') return fail(new WorkdayApiError('default facet rejected', 400)) as any;
      if (key === 'Country') return fail(new WorkdayApiError('discovered facet rejected', 422)) as any;
      return empty() as any;
    });
    summaryMock.mockResolvedValue({
      total: 1,
      postingCount: 1,
      facets: [{ facetParameter: 'Country', values: [{ id: SWISS_ID, descriptor: 'Switzerland', count: 1 }] }],
    });

    const jobs = await makeParser().fetchAllJobs();

    expect(jobs).toHaveLength(0);
    expect(requestedFacets()).toEqual([
      { locationCountry: [SWISS_ID] },
      { Country: [SWISS_ID] },
      {},
    ]);
    expect(summaryMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a board-summary failure instead of falling back unfiltered', async () => {
    const summaryError = new WorkdayApiError('summary failed', 500);
    listMock.mockImplementation(() => fail(new WorkdayApiError('facet rejected', 400)) as any);
    summaryMock.mockRejectedValue(summaryError);

    await expect(makeParser().fetchAllJobs()).rejects.toBe(summaryError);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(summaryMock).toHaveBeenCalledTimes(1);
    expect(requestedFacets()).toEqual([{ locationCountry: [SWISS_ID] }]);
  });

  it('records an auth block while discovering a replacement facet without an unfiltered query', async () => {
    const authError = new WorkdayAuthError('anti-bot block', 403);
    listMock.mockImplementation(() => fail(new WorkdayApiError('facet rejected', 422)) as any);
    summaryMock.mockRejectedValue(authError);

    const jobs = await makeParser().fetchAllJobs();

    expect(jobs).toHaveLength(0);
    expect((jobs as any).fetchOutcome).toBe('anti_bot_block');
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(summaryMock).toHaveBeenCalledTimes(1);
    expect(requestedFacets()).toEqual([{ locationCountry: [SWISS_ID] }]);
  });

  it('propagates a transient discovered-facet retry failure without the unfiltered request', async () => {
    const retryError = new WorkdayApiError('discovered facet server error', 500);
    listMock.mockImplementation((_apiBase, options) => {
      const key = Object.keys(options.appliedFacets)[0];
      if (key === 'locationCountry') return fail(new WorkdayApiError('default facet rejected', 400)) as any;
      if (key === 'Country') return fail(retryError) as any;
      return empty() as any;
    });
    summaryMock.mockResolvedValue({
      total: 1,
      postingCount: 1,
      facets: [{ facetParameter: 'Country', values: [{ id: SWISS_ID, descriptor: 'Switzerland', count: 1 }] }],
    });

    await expect(makeParser().fetchAllJobs()).rejects.toBe(retryError);

    expect(requestedFacets()).toEqual([
      { locationCountry: [SWISS_ID] },
      { Country: [SWISS_ID] },
    ]);
  });
});
