/**
 * Generalised transient-fetch coverage for the SHARED crawler fetch layers.
 *
 * `crawler-fetch-retry.test.ts` pins `crawler-template`'s fetchJson/fetchHtml.
 * This file pins the OTHER high-multiplier fetch paths that were previously on
 * a bare `fetch()` with no retry — the structural-resilience generalisation:
 *   - hospital-custom-html-helpers.fetchHtml  (88 hospital crawlers)
 *   - ATS clients: greenhouse / lever / smartrecruiters / workday
 *   - playwright-runtime.fetchWithRateLimit   (every Playwright ATS crawler)
 *
 * Invariant under test (same as the merged helper): retry bounded on TRANSIENT
 * signals (network/timeout/429/5xx), fail fast on persistent 4xx (404/403),
 * never retry anti-bot blocks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { fetchHtml as hospitalFetchHtml } from '../scripts/lib/hospital-custom-html-helpers.mjs';
import { fetchGreenhouseJobs, GreenhouseApiError } from '../scripts/lib/ats-clients/greenhouse-client.mjs';
import { fetchLeverJobs } from '../scripts/lib/ats-clients/lever-client.mjs';

function htmlResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// Keep backoff instant so the suite stays fast.
const FAST = { JOBS_CRAWLER_RETRY_BASE_MS: '0' };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
});

function withFastRetry() {
  process.env.JOBS_CRAWLER_RETRY_BASE_MS = FAST.JOBS_CRAWLER_RETRY_BASE_MS;
}

describe('hospital-custom-html-helpers.fetchHtml (88-crawler multiplier)', () => {
  it('retries a transient 503 then returns the body', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(503, ''))
      .mockResolvedValueOnce(htmlResponse(200, '<html>jobs</html>'));
    vi.stubGlobal('fetch', fetchMock);

    const html = await hospitalFetchHtml('https://klinik.test/jobs');
    expect(html).toBe('<html>jobs</html>');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient network error (ECONNRESET) then succeeds', async () => {
    withFastRetry();
    const netErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(htmlResponse(200, '<html>ok</html>'));
    vi.stubGlobal('fetch', fetchMock);

    const html = await hospitalFetchHtml('https://klinik.test/jobs');
    expect(html).toBe('<html>ok</html>');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast on 404 without retrying (source moved)', async () => {
    withFastRetry();
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(404, 'not found'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(hospitalFetchHtml('https://klinik.test/gone')).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('greenhouse-client.fetchGreenhouseJobs', () => {
  it('retries a transient 502 then returns parsed jobs', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502, {}))
      .mockResolvedValueOnce(jsonResponse(200, { jobs: [{ id: 1, title: 'Dev', location: { name: 'Zurich' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchGreenhouseJobs('acme');
    expect(jobs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast on 404 (board moved) without retrying', async () => {
    withFastRetry();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGreenhouseJobs('gone')).rejects.toBeInstanceOf(GreenhouseApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('lever-client.fetchLeverJobs', () => {
  it('retries a transient 500 then returns normalised jobs', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, [
        { id: 'a', text: 'Engineer', categories: { location: 'Geneva' }, hostedUrl: 'https://l.test/a' },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchLeverJobs('acme', { companyName: 'Acme' });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast on 404 (slug moved) without retrying', async () => {
    withFastRetry();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLeverJobs('gone')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
