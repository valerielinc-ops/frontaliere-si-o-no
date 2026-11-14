import { afterEach, describe, expect, it, vi } from 'vitest';

const { launchStealthOrChromiumMock } = vi.hoisted(() => ({
  launchStealthOrChromiumMock: vi.fn(),
}));

vi.mock('../scripts/lib/stealth-browser.mjs', () => ({
  chromeUserAgent: () => 'Mozilla/5.0 Chrome/140.0.0.0',
  isStealthBrowser: () => false,
  launchStealthOrChromium: launchStealthOrChromiumMock,
}));

import { fetchWorkdayJobs, WorkdayApiError } from '../scripts/lib/ats-clients/workday-client.mjs';

const API_BASE = 'https://everestre.wd5.myworkdayjobs.com/wday/cxs/everestre/External';

function browserTransport(body: unknown) {
  const page = {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: vi.fn().mockResolvedValue({ status: 200, body: JSON.stringify(body) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    version: () => '140.0.0',
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  launchStealthOrChromiumMock.mockResolvedValue(browser);
  return { page, context, browser };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  launchStealthOrChromiumMock.mockReset();
});

describe('Workday JSON transport', () => {
  it('recovers a connection-level listing failure through the browser origin', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const directFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', directFetch);
    const { page, browser } = browserTransport({
      total: 1,
      jobPostings: [{ title: 'Swiss role', externalPath: '/job/Zurich/Swiss_R1', locationsText: 'Zurich' }],
    });

    const jobs = [];
    for await (const posting of fetchWorkdayJobs(API_BASE, { minDelayMs: 0 })) jobs.push(posting);

    expect(jobs).toHaveLength(1);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(launchStealthOrChromiumMock).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'crawler',
      fallbackOptions: { headless: true },
    }));
    expect(page.goto).toHaveBeenCalledWith(
      'https://everestre.wd5.myworkdayjobs.com/en-US/External',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('does not turn an HTTP response into a browser fallback', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    const iterator = fetchWorkdayJobs(API_BASE, { minDelayMs: 0 });
    await expect(iterator.next()).rejects.toBeInstanceOf(WorkdayApiError);
    expect(launchStealthOrChromiumMock).not.toHaveBeenCalled();
  });

  it('aborts a stalled browser fallback at the request timeout', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const { page } = browserTransport({});
    const originalFetch = globalThis.fetch;
    page.evaluate.mockImplementation(async (evaluate, args) => {
      const browserFetch = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }));
      vi.stubGlobal('fetch', browserFetch);
      try {
        return await evaluate(args);
      } finally {
        vi.stubGlobal('fetch', originalFetch);
      }
    });

    const startedAt = Date.now();
    const iterator = fetchWorkdayJobs(API_BASE, { minDelayMs: 0, timeoutMs: 50 });
    await expect(iterator.next()).rejects.toMatchObject({ statusCode: 0 });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ requestTimeoutMs: 50 }));
  });
});
