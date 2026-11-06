import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchGreenhouseJobs,
  GreenhouseApiError,
} from '../scripts/lib/ats-clients/greenhouse-client.mjs';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function nonJsonResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  delete process.env.JOBS_CRAWLER_RETRIES;
});

describe('Greenhouse transport fail-closed observer', () => {
  it('accepts an observed JSON jobs payload', async () => {
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        jobs: [{ id: 17396, title: 'Engineer', location: { name: 'Zurich' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchGreenhouseJobs('fixture');

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobReqId: '17396', title: 'Engineer' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a 200 WAF/non-JSON response instead of publishing an empty snapshot', async () => {
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    const fetchMock = vi.fn().mockResolvedValue(
      nonJsonResponse(200, '<html><title>Just a moment...</title></html>'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGreenhouseJobs('fixture')).rejects.toBeInstanceOf(GreenhouseApiError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects a connection failure instead of publishing an empty snapshot', async () => {
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    const connectionError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    const fetchMock = vi.fn().mockRejectedValue(connectionError);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGreenhouseJobs('fixture')).rejects.toMatchObject({
      name: 'GreenhouseApiError',
      statusCode: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
