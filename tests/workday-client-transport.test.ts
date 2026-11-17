import { afterEach, describe, expect, it, vi } from 'vitest';

const { launchStealthOrChromiumMock } = vi.hoisted(() => ({
  launchStealthOrChromiumMock: vi.fn(),
}));

vi.mock('../scripts/lib/stealth-browser.mjs', () => ({
  chromeUserAgent: () => 'Mozilla/5.0 Chrome/140.0.0.0',
  isStealthBrowser: () => false,
  launchStealthOrChromium: launchStealthOrChromiumMock,
}));

import { createWorkdaySwissParser } from '../scripts/lib/workday-swiss-job-parser-common.mjs';
import { fetchAllKsbJobs } from '../scripts/lib/ksb-job-parser.mjs';
import {
  fetchWorkdayJobDetail,
  fetchWorkdayJsonWithRetry,
  fetchWorkdayJobs,
  WorkdayApiError,
} from '../scripts/lib/ats-clients/workday-client.mjs';

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
  it('retries a rate-limited JSON request before returning the listing', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const directFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total: 1, jobPostings: [] }), { status: 200 }));
    vi.stubGlobal('fetch', directFetch);

    const data = await fetchWorkdayJsonWithRetry(API_BASE, `${API_BASE}/jobs`, {
      method: 'POST',
      body: '{}',
      browserFallback: null,
    });

    expect(data).toEqual({ total: 1, jobPostings: [] });
    expect(directFetch).toHaveBeenCalledTimes(2);
  });

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

  it('recovers a retry-exhausted HTTP failure through the browser origin', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', directFetch);
    const { page, browser } = browserTransport({
      total: 1,
      jobPostings: [{ title: 'Swiss role', externalPath: '/job/Zurich/Swiss_R1', locationsText: 'Zurich' }],
    });

    const jobs = [];
    for await (const posting of fetchWorkdayJobs(API_BASE, { minDelayMs: 0 })) jobs.push(posting);

    expect(jobs).toHaveLength(1);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('recovers a retry-exhausted detail through an injected browser transport', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const browserFallback = vi.fn().mockResolvedValue({
      jobPostingInfo: { jobDescription: '<p>Recovered detail</p>' },
    });
    vi.stubGlobal('fetch', directFetch);

    const detail = await fetchWorkdayJobDetail(API_BASE, '/job/Zurich/Swiss_R1', {
      browserFallback,
    });

    expect(detail?.jobPostingInfo?.jobDescription).toBe('<p>Recovered detail</p>');
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(browserFallback).toHaveBeenCalledOnce();
    expect(browserFallback).toHaveBeenCalledWith(expect.objectContaining({
      url: `${API_BASE}/job/Zurich/Swiss_R1`,
      method: 'GET',
      timeoutMs: 15_000,
    }));
  });

  it('uses the lazy default browser transport for a rate-limited detail', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const { page, browser } = browserTransport({
      jobPostingInfo: { jobDescription: '<p>Recovered detail</p>' },
    });

    const detail = await fetchWorkdayJobDetail(API_BASE, '/job/Zurich/Swiss_R1');

    expect(detail?.jobPostingInfo?.jobDescription).toBe('<p>Recovered detail</p>');
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('uses one browser session to recover parser detail after Workday rate limiting', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const detailPayload = {
      jobPostingInfo: {
        location: { descriptor: 'Zurich, Switzerland' },
        jobRequisitionLocation: {
          country: { alpha2Code: 'CH', descriptor: 'Switzerland' },
        },
        jobDescription: '<p>Responsibilities include coordinating cross functional projects, preparing clear documentation, supporting the local team, and improving reliable processes. The successful candidate brings relevant experience, strong communication skills, sound judgement, careful attention to detail, and fluent English. We offer a collaborative international workplace, flexible working hours, professional development, meaningful ownership, and a structured application process with supportive colleagues and modern tools.</p>',
      },
    };
    const directFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/jobs')) {
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Swiss role',
            externalPath: '/job/Zurich/Swiss_R1',
            locationsText: 'Zurich, Switzerland',
            postedOn: 'Posted Today',
            bulletFields: ['R1'],
          }],
        }), { status: 200 });
      }
      return new Response('', { status: 429 });
    });
    vi.stubGlobal('fetch', directFetch);
    const { page, browser } = browserTransport(detailPayload);

    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      defaultCanton: 'ZH',
      defaultCity: 'Zurich',
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Swiss role');
    expect(directFetch).toHaveBeenCalledTimes(3);
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('uses one browser session for two KSB detail requests after rate limiting', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const vacancy = '<p>Responsibilities include coordinating cross functional projects, preparing clear documentation, supporting the local team, and improving reliable processes. The successful candidate brings relevant experience, strong communication skills, sound judgement, careful attention to detail, and fluent German. We offer a collaborative workplace, flexible working hours, professional development, meaningful ownership, and a structured application process with supportive colleagues and modern tools.</p>';
    const detailPayloads = [
      [],
      { jobPostingInfo: { jobDescription: vacancy, timeType: 'Full time' } },
      { jobPostingInfo: { jobDescription: vacancy, timeType: 'Part time' } },
    ];
    const directFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/jobs')) {
        return new Response(JSON.stringify({
          total: 2,
          jobPostings: [
            { title: 'KSB role one', externalPath: '/job/Baden/KSB_R1', locationsText: 'Baden, Switzerland', bulletFields: ['R1'] },
            { title: 'KSB role two', externalPath: '/job/Baden/KSB_R2', locationsText: 'Baden, Switzerland', bulletFields: ['R2'] },
          ],
        }), { status: 200 });
      }
      return new Response('', { status: 429 });
    });
    vi.stubGlobal('fetch', directFetch);
    const { page, browser } = browserTransport(null);
    page.evaluate.mockImplementation(async () => ({
      status: 200,
      body: JSON.stringify(detailPayloads.shift()),
    }));

    const jobs = await fetchAllKsbJobs();

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job: any) => job.title)).toEqual(['KSB role one', 'KSB role two']);
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('keeps a retry-exhausted status when the browser fallback is also transient', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const { page } = browserTransport({});
    page.evaluate.mockResolvedValue({ status: 503, body: '' });

    const iterator = fetchWorkdayJobs(API_BASE, { minDelayMs: 0 });
    await expect(iterator.next()).rejects.toMatchObject({ statusCode: 503, retryExhausted: true });
  });

  it('derives a public career page from a tenant-only CXS base', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const { page } = browserTransport({
      total: 0,
      jobPostings: [],
    });

    const jobs = [];
    for await (const posting of fetchWorkdayJobs(
      'https://everest.wd5.myworkdayjobs.com/wday/cxs/everest-re',
      { minDelayMs: 0 },
    )) jobs.push(posting);

    expect(jobs).toHaveLength(0);
    expect(page.goto).toHaveBeenCalledWith(
      'https://everest.wd5.myworkdayjobs.com/en-US/everest-re',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
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
