import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateJobUrl, validateJobUrls } from '../scripts/lib/validate-job-url.mjs';

const ABB_EXPIRED_URL =
  'https://careers.abb/global/en/job/ABB1GLOBALJR00042364EXTERNALENGLOBAL/Logistics-Operator-IPU-B-S-f-m-d--80-100';
const ABB_LIVE_URL =
  'https://careers.abb/global/en/job/ABB1GLOBALJR00099999EXTERNALENGLOBAL/Active-Role';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateJobUrl ABB closure banner', () => {
  it('rejects an HTTP 200 ABB tombstone even when JobPosting JSON-LD remains', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          '<script type="application/ld+json">{"@type":"JobPosting","title":"Old role"}</script>' +
            '<div>THE JOB YOU ARE TRYING TO\n   APPLY FOR IS NO LONGER AVAILABLE</div>',
          { status: 200 },
        ),
      ),
    );

    await expect(validateJobUrl(ABB_EXPIRED_URL, { id: 'company-expired' })).resolves.toMatchObject({
      id: 'company-expired',
      valid: false,
      status: 200,
      reason: 'phrase:the job you are trying to apply for is no longer available',
      definitive: true,
    });
  });

  it('keeps an HTTP 200 ABB detail page valid when the banner is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          '<script type="application/ld+json">{"@type":"JobPosting","title":"Active role"}</script>' +
            '<h1>Active role</h1><p>Apply now.</p>',
          { status: 200 },
        ),
      ),
    );

    await expect(validateJobUrl(ABB_LIVE_URL, { id: 'company-live' })).resolves.toMatchObject({
      id: 'company-live',
      valid: true,
      status: 200,
      reason: 'ok',
    });
  });
});

describe('validateJobUrl response deadline', () => {
  it('settles when a response body ignores the abort signal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        url: 'https://jobs.coopjobs.ch/job/hung-body',
        text: () => new Promise(() => {}),
      }),
    );

    await expect(
      validateJobUrl('https://jobs.coopjobs.ch/job/hung-body', {
        id: 'hung-body',
        timeoutMs: 20,
      }),
    ).resolves.toMatchObject({
      id: 'hung-body',
      valid: true,
      status: 0,
      reason: 'network-timeout',
    });
  });

  it('does not strand the concurrent batch behind one hung response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input) => String(input).endsWith('/hung')
        ? Promise.resolve({
          status: 200,
          url: String(input),
          text: () => new Promise(() => {}),
        })
        : Promise.resolve(new Response('<h1>Live job</h1>', { status: 200 }))),
    );

    await expect(
      validateJobUrls([
        { id: 'hung', url: 'https://jobs.coopjobs.ch/job/hung' },
        { id: 'live', url: 'https://jobs.coopjobs.ch/job/live' },
      ], { concurrency: 2, timeoutMs: 20 }),
    ).resolves.toMatchObject([
      { id: 'hung', valid: true, reason: 'network-timeout' },
      { id: 'live', valid: true, reason: 'ok' },
    ]);
  });

  it('cancels timed-out response bodies across consecutive batches', async () => {
    let liveProbes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        liveProbes += 1;
        return {
          status: 200,
          url: String(input),
          body: {
            cancel: async () => {
              liveProbes -= 1;
            },
          },
          text: () => new Promise(() => {}),
        };
      }),
    );

    const jobs = [{ id: 'hung', url: 'https://jobs.coopjobs.ch/job/hung' }];
    await validateJobUrls(jobs, { concurrency: 1, timeoutMs: 20 });
    await validateJobUrls(jobs, { concurrency: 1, timeoutMs: 20 });

    expect(liveProbes).toBe(0);
  });

  it('keeps the timeout verdict when cancellation releases a pending reader', async () => {
    let releasePendingRead;
    const closedBanner = new TextEncoder().encode(
      'This job is no longer available',
    );
    const reader = {
      reads: 0,
      read: vi.fn(() => {
        reader.reads += 1;
        if (reader.reads === 1) {
          return Promise.resolve({ done: false, value: closedBanner });
        }
        return new Promise((resolve) => {
          releasePendingRead = resolve;
        });
      }),
      cancel: vi.fn(() => {
        releasePendingRead?.({ done: true });
        return Promise.resolve();
      }),
      releaseLock: vi.fn(),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        url: 'https://jobs.coopjobs.ch/job/cancelled-reader',
        body: { getReader: () => reader },
      }),
    );

    await expect(
      validateJobUrl('https://jobs.coopjobs.ch/job/cancelled-reader', {
        id: 'cancelled-reader',
        timeoutMs: 20,
      }),
    ).resolves.toMatchObject({
      id: 'cancelled-reader',
      valid: true,
      status: 0,
      reason: 'network-timeout',
    });
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });
});
