import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
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
import { fetchAllLonzaJobs } from '../scripts/lib/lonza-job-parser.mjs';
import {
  createWorkdayRequestContext,
  fetchWorkdayJobDetail,
  fetchWorkdayJsonWithRetry,
  fetchWorkdayJobs,
  fetchWorkdaySidebarText,
  resetWorkdayImplicitRateLimitStateForTests,
  shouldPropagateWorkdayFetchError,
  WorkdayApiError,
  WorkdayRateLimitError,
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
  resetWorkdayImplicitRateLimitStateForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  launchStealthOrChromiumMock.mockReset();
});

describe('Workday JSON transport', () => {
  it('propagates status-0 transport failures for fail-closed listing callers', () => {
    const transportError = new WorkdayApiError('transport failed', 0, `${API_BASE}/jobs`);

    expect(shouldPropagateWorkdayFetchError(transportError, true)).toBe(true);
    expect(shouldPropagateWorkdayFetchError(transportError)).toBe(false);
  });

  it('shares the runner egress lock and Retry-After cooldown across processes', async () => {
    const egressStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-egress-test-'));
    const requestLogPath = path.join(egressStateDir, 'request-times.log');
    const readRequestTimes = () => {
      if (!fs.existsSync(requestLogPath)) return [];
      return fs.readFileSync(requestLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(Number);
    };

    try {
      const apiBase = 'https://workday.test/wday/cxs/test/External';
      const clientUrl = pathToFileURL(path.resolve('scripts/lib/ats-clients/workday-client.mjs')).href;
      const runClientProcess = (status: number) => new Promise<void>((resolve, reject) => {
        const script = `
          import fs from 'node:fs';
          const status = ${JSON.stringify(status)};
          const requestLogPath = ${JSON.stringify(requestLogPath)};
          globalThis.fetch = async () => {
            fs.appendFileSync(requestLogPath, String(Date.now()) + '\\n');
            if (status === 429) await new Promise((resolve) => setTimeout(resolve, 100));
            return new Response(status === 429 ? '' : JSON.stringify({ ok: true }), {
              status,
              headers: status === 429
                ? { 'Retry-After': '1' }
                : { 'Content-Type': 'application/json' },
            });
          };
          const { fetchWorkdayJsonWithRetry } = await import(${JSON.stringify(clientUrl)});
          try {
            await fetchWorkdayJsonWithRetry(${JSON.stringify(apiBase)}, ${JSON.stringify(`${apiBase}/jobs`)}, {
              retries: 0,
              browserFallback: null,
              egressStateDir: ${JSON.stringify(egressStateDir)},
              egressMinDelayMs: 0,
            });
          } catch (error) {
            if (error?.statusCode !== 429) throw error;
          }
        `;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Workday child process exited with ${code}`));
        });
      });

      const first = runClientProcess(429);
      const deadline = Date.now() + 2000;
      while (readRequestTimes().length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(readRequestTimes()).toHaveLength(1);
      const secondStartedAt = Date.now();
      const second = runClientProcess(200);
      await Promise.all([first, second]);

      const requestTimes = readRequestTimes();
      expect(requestTimes).toHaveLength(2);
      expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(900);
      expect(Date.now() - secondStartedAt).toBeGreaterThanOrEqual(800);
    } finally {
      fs.rmSync(egressStateDir, { recursive: true, force: true });
    }
  });

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
      fallbackCooldownMs: 0,
    });

    expect(data).toEqual({ total: 1, jobPostings: [] });
    expect(directFetch).toHaveBeenCalledTimes(2);
  });

  it('honors Workday Retry-After before retrying a rate-limited JSON request', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
      const directFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('', {
          status: 429,
          headers: { 'Retry-After': '5' },
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ total: 1, jobPostings: [] }), { status: 200 }));
      vi.stubGlobal('fetch', directFetch);

      const pending = fetchWorkdayJsonWithRetry(API_BASE, `${API_BASE}/jobs`, {
        method: 'POST',
        body: '{}',
        retryBaseMs: 100,
        browserFallback: null,
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(directFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ total: 1, jobPostings: [] });
      expect(directFetch).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
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

  it('boots the Lonza fallback on its localized public Workday site', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const page = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      evaluate: vi.fn().mockImplementation(async (_fn, args) => {
        const url = String(args.requestUrl);
        if (url.endsWith('/jobs')) {
          return {
            status: 200,
            body: JSON.stringify({
              total: 1,
              jobPostings: [{
                title: 'Process Engineer',
                externalPath: '/job/Visp/Process_Engineer_R1',
                locationsText: 'Visp, Switzerland',
              }],
            }),
          };
        }
        return {
          status: 200,
          body: JSON.stringify({
            jobPostingInfo: {
              title: 'Process Engineer',
              location: 'Visp, Switzerland',
              jobDescription: 'Responsibilities include process improvement, careful documentation, cross-functional collaboration, reliable communication, and continuous quality work. The role supports production teams, coordinates technical activities, and contributes to a safe, structured, and inclusive workplace with professional development and modern facilities. You will work with experienced specialists, review production data, maintain clear procedures, participate in quality initiatives, and communicate next steps to colleagues while developing practical expertise in a supportive international environment.',
            },
          }),
        };
      }),
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

    const jobs = await fetchAllLonzaJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Process Engineer', canton: 'VS' });
    expect(page.goto).toHaveBeenCalledWith(
      'https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(browser.close).toHaveBeenCalledOnce();
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

  it('does not send a retry-exhausted 429 through an injected browser transport', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const browserFallback = vi.fn().mockResolvedValue({
      jobPostingInfo: { jobDescription: '<p>Recovered detail</p>' },
    });
    vi.stubGlobal('fetch', directFetch);

    await expect(fetchWorkdayJobDetail(API_BASE, '/job/Zurich/Swiss_R1', {
      browserFallback,
      fallbackCooldownMs: 0,
    })).rejects.toBeInstanceOf(WorkdayRateLimitError);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(browserFallback).not.toHaveBeenCalled();
  });

  it('fails a no-context listing instead of returning a partial board after a later-page 429', async () => {
    const directFetch = vi.fn(async (_url: string, options: RequestInit) => {
      const offset = JSON.parse(String(options.body)).offset;
      if (offset === 0) {
        return new Response(JSON.stringify({
          total: 2,
          jobPostings: [{ title: 'First role', externalPath: '/job/Zurich/First_R1' }],
        }), { status: 200 });
      }
      return new Response('', { status: 429 });
    });
    vi.stubGlobal('fetch', directFetch);
    const iterator = fetchWorkdayJobs(API_BASE, {
      pageSize: 1,
      minDelayMs: 0,
      browserFallback: null,
      fallbackCooldownMs: 0,
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { title: 'First role' },
    });
    await expect(iterator.next()).rejects.toBeInstanceOf(WorkdayRateLimitError);
    expect(directFetch).toHaveBeenCalledTimes(3);
  });

  it('shares a no-context Retry-After cooldown across successive tenant requests', async () => {
    vi.useFakeTimers();
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    const directFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '5' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ recovered: true }), { status: 200 }));
    vi.stubGlobal('fetch', directFetch);

    try {
      await expect(fetchWorkdayJsonWithRetry(API_BASE, `${API_BASE}/job/Zurich/First_R1`, {
        browserFallback: null,
      })).rejects.toBeInstanceOf(WorkdayRateLimitError);
      const second = fetchWorkdayJsonWithRetry(API_BASE, `${API_BASE}/job/Zurich/Second_R2`, {
        browserFallback: null,
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(directFetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toEqual({ recovered: true });
      expect(directFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a terminal rate limit from the Lonza listing without a partial result', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', directFetch);

    await expect(fetchAllLonzaJobs()).rejects.toMatchObject({
      name: 'WorkdayRateLimitError',
      statusCode: 429,
      consecutiveFailures: 1,
    });
    expect(directFetch).toHaveBeenCalledOnce();
    expect(launchStealthOrChromiumMock).not.toHaveBeenCalled();
  });

  it('uses the lazy default browser transport for a retry-exhausted 503 detail', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const { page, browser } = browserTransport({
      jobPostingInfo: { jobDescription: '<p>Recovered detail</p>' },
    });

    const detail = await fetchWorkdayJobDetail(API_BASE, '/job/Zurich/Swiss_R1');

    expect(detail?.jobPostingInfo?.jobDescription).toBe('<p>Recovered detail</p>');
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('uses one browser session to recover parser detail after transient HTTP failures', async () => {
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
      return new Response('', { status: 503 });
    });
    vi.stubGlobal('fetch', directFetch);
    const { page, browser } = browserTransport(detailPayload);

    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      careerUrl: 'https://testco.wd3.myworkdayjobs.com/en-US/Test_Careers',
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

  it('does not let a shared parser swallow a terminal detail rate limit', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    const directFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/jobs')) {
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Swiss role',
            externalPath: '/job/Zurich/Swiss_R1',
            locationsText: 'Zurich, Switzerland',
            bulletFields: ['R1'],
          }],
        }), { status: 200 });
      }
      return new Response('', { status: 429 });
    });
    vi.stubGlobal('fetch', directFetch);
    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      careerUrl: 'https://testco.wd3.myworkdayjobs.com/en-US/Test_Careers',
      defaultCanton: 'ZH',
      defaultCity: 'Zurich',
    });

    await expect(parser.fetchAllJobs()).rejects.toBeInstanceOf(WorkdayRateLimitError);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(launchStealthOrChromiumMock).not.toHaveBeenCalled();
  });

  it('serializes tenant requests and carries Retry-After to the next direct request', async () => {
    vi.useFakeTimers();
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    const directFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '5' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ recovered: true }), { status: 200 }));
    vi.stubGlobal('fetch', directFetch);
    const browserFallback = vi.fn().mockResolvedValue({ browser: true });
    const context = createWorkdayRequestContext(API_BASE, { browserFallback });

    try {
      await expect(context.request(`${API_BASE}/job/Zurich/Swiss_R1`)).rejects.toBeInstanceOf(
        WorkdayRateLimitError,
      );
      const second = context.request(`${API_BASE}/job/Zurich/Swiss_R2`);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(directFetch).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toEqual({ recovered: true });
      expect(directFetch).toHaveBeenCalledTimes(2);
      expect(browserFallback).not.toHaveBeenCalled();
    } finally {
      await context.close();
      vi.useRealTimers();
    }
  });

  it('keeps paginating a rate-limited listing through the browser after the first page recovered (otis)', async () => {
    // Otis regression (run 45924044578): the first POST was rescued, the next
    // POST of the same listing went direct again, hit two 429s and aborted.
    vi.useFakeTimers();
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const browserFallback = vi.fn()
      .mockResolvedValueOnce({ total: 40, jobPostings: [{ externalPath: '/job/a' }] })
      .mockResolvedValueOnce({ total: 40, jobPostings: [{ externalPath: '/job/b' }] });
    vi.stubGlobal('fetch', directFetch);
    const context = createWorkdayRequestContext(API_BASE, {
      browserFallback,
      fallbackCooldownMs: 1_000,
      rateLimitCircuitThreshold: 2,
      browserBackoffMs: 0,
    });
    const listing = (offset: number) => ({
      method: 'POST', body: JSON.stringify({ offset }), retries: 3, retryBaseMs: 0,
    });

    try {
      const first = context.request(`${API_BASE}/jobs`, listing(0));
      await vi.runAllTimersAsync();
      await expect(first).resolves.toMatchObject({ jobPostings: [{ externalPath: '/job/a' }] });
      expect(directFetch).toHaveBeenCalledTimes(2);
      expect(browserFallback).toHaveBeenCalledWith(expect.objectContaining({
        url: `${API_BASE}/jobs`,
        method: 'POST',
        body: JSON.stringify({ offset: 0 }),
      }));

      const second = context.request(`${API_BASE}/jobs`, listing(20));
      await vi.runAllTimersAsync();
      await expect(second).resolves.toMatchObject({ jobPostings: [{ externalPath: '/job/b' }] });
      expect(browserFallback).toHaveBeenCalledTimes(2);
      // The known-throttled direct stack is not hammered again.
      expect(directFetch).toHaveBeenCalledTimes(2);
    } finally {
      await context.close();
      vi.useRealTimers();
    }
  });

  it('never exceeds the listing page budget of the browser rescue', async () => {
    vi.useFakeTimers();
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const browserFallback = vi.fn().mockResolvedValue({ total: 99, jobPostings: [] });
    vi.stubGlobal('fetch', directFetch);
    const context = createWorkdayRequestContext(API_BASE, {
      browserFallback,
      fallbackCooldownMs: 1_000,
      rateLimitCircuitThreshold: 2,
      listingBrowserBudget: 2,
      browserBackoffMs: 0,
    });
    const listing = { method: 'POST', body: '{}', retries: 3, retryBaseMs: 0 };

    try {
      for (let page = 0; page < 2; page += 1) {
        const ok = context.request(`${API_BASE}/jobs`, listing);
        await vi.runAllTimersAsync();
        await expect(ok).resolves.toBeTruthy();
      }
      const third = context.request(`${API_BASE}/jobs`, listing);
      const rejection = expect(third).rejects.toMatchObject({
        name: 'WorkdayRateLimitError',
        circuitOpen: true,
      });
      await vi.runAllTimersAsync();
      await rejection;
      expect(browserFallback).toHaveBeenCalledTimes(2);
      expect(directFetch).toHaveBeenCalledTimes(2);
    } finally {
      await context.close();
      vi.useRealTimers();
    }
  });

  it('keeps the typed rate-limit error when the browser cannot recover the listing', async () => {
    vi.useFakeTimers();
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const browserFallback = vi.fn().mockRejectedValue(new Error('browser blocked'));
    vi.stubGlobal('fetch', directFetch);
    const context = createWorkdayRequestContext(API_BASE, {
      browserFallback,
      fallbackCooldownMs: 1_000,
      rateLimitCircuitThreshold: 2,
    });

    try {
      const pending = context.request(`${API_BASE}/jobs`, {
        method: 'POST', body: '{}', retries: 3, retryBaseMs: 0,
      });
      const rejection = expect(pending).rejects.toMatchObject({
        name: 'WorkdayRateLimitError',
        statusCode: 429,
        circuitOpen: true,
      });
      await vi.runAllTimersAsync();
      await rejection;
      expect(browserFallback).toHaveBeenCalledTimes(1);
    } finally {
      await context.close();
      vi.useRealTimers();
    }
  });

  it('opens a bounded circuit for 429 without Retry-After and gives a caller-supplied transport no unbounded or implicit detail rescue (#19723 amended: no unbounded 429 repetition)', async () => {
    vi.useFakeTimers();
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const browserFallback = vi.fn().mockResolvedValue({ recovered: true });
    vi.stubGlobal('fetch', directFetch);
    const context = createWorkdayRequestContext(API_BASE, {
      browserFallback,
      fallbackCooldownMs: 60_000,
      rateLimitCircuitThreshold: 2,
    });

    try {
      const pending = context.request(`${API_BASE}/job/Zurich/Swiss_R1`, {
        retries: 3,
        retryBaseMs: 0,
      });
      const rejection = expect(pending).rejects.toMatchObject({
        name: 'WorkdayRateLimitError',
        statusCode: 429,
        consecutiveFailures: 2,
        circuitOpen: true,
        retryExhausted: true,
      });
      await vi.runAllTimersAsync();
      await rejection;
      expect(directFetch).toHaveBeenCalledTimes(2);
      expect(browserFallback).not.toHaveBeenCalled();
    } finally {
      await context.close();
      vi.useRealTimers();
    }
  });

  describe('budgeted browser rescue of detail requests after the 429 circuit opened', () => {
    const detailUrl = (n: number) => `${API_BASE}/job/Zurich/Swiss_R${n}`;
    const detailOptions = { retries: 3, retryBaseMs: 0 };

    function rescueContext(browserFallback: unknown, extra: Record<string, unknown> = {}) {
      return createWorkdayRequestContext(API_BASE, {
        browserFallback: browserFallback as never,
        fallbackCooldownMs: 1_000,
        rateLimitCircuitThreshold: 2,
        browserBackoffMs: 0,
        detailBrowserBudget: 2,
        ...extra,
      });
    }

    it('serves details sequentially through the browser, with a backoff, and never beyond the budget', async () => {
      vi.useFakeTimers();
      const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
      vi.stubGlobal('fetch', directFetch);
      const startedAt: number[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const browserFallback = vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        startedAt.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return { jobPostingInfo: { jobDescription: '<p>ok</p>' } };
      });
      const context = rescueContext(browserFallback, { browserBackoffMs: 2_500 });

      try {
        const results = [1, 2, 3].map((n) => context.request(detailUrl(n), detailOptions));
        const settled = Promise.allSettled(results);
        await vi.runAllTimersAsync();
        const outcome = await settled;
        expect(outcome[0].status).toBe('fulfilled');
        expect(outcome[1].status).toBe('fulfilled');
        expect(outcome[2]).toMatchObject({
          status: 'rejected',
          reason: expect.objectContaining({ name: 'WorkdayRateLimitError', circuitOpen: true }),
        });
        expect(browserFallback).toHaveBeenCalledTimes(2);
        expect(maxInFlight).toBe(1);
        expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(2_500);
        // Only the two requests that opened the circuit were sent direct.
        expect(directFetch).toHaveBeenCalledTimes(2);
      } finally {
        await context.close();
        vi.useRealTimers();
      }
    });

    it('stops at the first 429 the browser itself receives and propagates it as the IP throttle', async () => {
      vi.useFakeTimers();
      const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
      vi.stubGlobal('fetch', directFetch);
      const browserFallback = vi.fn().mockRejectedValue(
        new WorkdayApiError('Workday browser API error HTTP 429', 429, detailUrl(1)),
      );
      const context = rescueContext(browserFallback, { detailBrowserBudget: 10 });

      try {
        const first = context.request(detailUrl(1), detailOptions);
        const firstRejection = expect(first).rejects.toBeInstanceOf(WorkdayRateLimitError);
        await vi.runAllTimersAsync();
        await firstRejection;
        expect(browserFallback).toHaveBeenCalledTimes(1);

        const second = context.request(detailUrl(2), detailOptions);
        const secondRejection = expect(second).rejects.toMatchObject({
          name: 'WorkdayRateLimitError',
          circuitOpen: true,
        });
        await vi.runAllTimersAsync();
        await secondRejection;
        expect(browserFallback).toHaveBeenCalledTimes(1);
      } finally {
        await context.close();
        vi.useRealTimers();
      }
    });

    it('does not call the browser while the 429 circuit is closed', async () => {
      vi.useFakeTimers();
      const directFetch = vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal('fetch', directFetch);
      const browserFallback = vi.fn().mockResolvedValue({ browser: true });
      const context = rescueContext(browserFallback);

      try {
        const recovered = context.request(detailUrl(1), detailOptions);
        await vi.runAllTimersAsync();
        await expect(recovered).resolves.toEqual({ ok: true });

        // A single terminal 429 (retry budget 0) does not open the circuit.
        directFetch.mockResolvedValueOnce(new Response('', { status: 429 }));
        const single = context.request(detailUrl(2), { retries: 0 });
        const rejection = expect(single).rejects.toBeInstanceOf(WorkdayRateLimitError);
        await vi.runAllTimersAsync();
        await rejection;
        expect(browserFallback).not.toHaveBeenCalled();
      } finally {
        await context.close();
        vi.useRealTimers();
      }
    });

    it('counts the budget per tenant for the whole process, not per request context', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
      const browserFallback = vi.fn().mockResolvedValue({ browser: true });
      const first = rescueContext(browserFallback, { detailBrowserBudget: 1 });
      const second = rescueContext(browserFallback, { detailBrowserBudget: 1 });

      try {
        const ok = first.request(detailUrl(1), detailOptions);
        await vi.runAllTimersAsync();
        await expect(ok).resolves.toEqual({ browser: true });

        const over = second.request(detailUrl(2), detailOptions);
        const rejection = expect(over).rejects.toBeInstanceOf(WorkdayRateLimitError);
        await vi.runAllTimersAsync();
        await rejection;
        expect(browserFallback).toHaveBeenCalledTimes(1);
      } finally {
        await first.close();
        await second.close();
        vi.useRealTimers();
      }
    });

    it('serializes browser rescues of two contexts of the same tenant behind the backoff', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
      const events: Array<[string, number]> = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const browserFallback = vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(['start', Date.now()]);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        events.push(['end', Date.now()]);
        inFlight -= 1;
        return { browser: true };
      });
      const opts = { browserBackoffMs: 2_500, detailBrowserBudget: 5, egressStateDir: null };
      const first = rescueContext(browserFallback, opts);
      const second = rescueContext(browserFallback, opts);

      try {
        const settled = Promise.all([
          first.request(detailUrl(1), detailOptions),
          second.request(detailUrl(2), detailOptions),
        ]);
        await vi.runAllTimersAsync();
        await settled;
        expect(browserFallback).toHaveBeenCalledTimes(2);
        expect(maxInFlight).toBe(1);
        const firstEnd = events.find(([k]) => k === 'end')![1];
        const secondStart = events.filter(([k]) => k === 'start')[1][1];
        expect(secondStart - firstEnd).toBeGreaterThanOrEqual(2_500);
      } finally {
        await first.close();
        await second.close();
        vi.useRealTimers();
      }
    });

    it('shares one ledger between URL-equivalent spellings of the tenant base', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
      const browserFallback = vi.fn().mockResolvedValue({ total: 0, jobPostings: [] });
      const first = rescueContext(browserFallback, { listingBrowserBudget: 1 });
      const second = createWorkdayRequestContext(`${API_BASE.replace('everestre.wd5', 'EVERESTRE.WD5')}/`, {
        browserFallback,
        fallbackCooldownMs: 1_000,
        rateLimitCircuitThreshold: 2,
        browserBackoffMs: 0,
        listingBrowserBudget: 1,
      });
      const listing = { method: 'POST', body: '{}', retries: 3, retryBaseMs: 0 };

      try {
        const ok = first.request(`${API_BASE}/jobs`, listing);
        await vi.runAllTimersAsync();
        await expect(ok).resolves.toBeTruthy();

        const over = second.request(`${API_BASE}/jobs`, listing);
        const rejection = expect(over).rejects.toBeInstanceOf(WorkdayRateLimitError);
        await vi.runAllTimersAsync();
        await rejection;
        expect(browserFallback).toHaveBeenCalledTimes(1);
      } finally {
        await first.close();
        await second.close();
        vi.useRealTimers();
      }
    });

    it.each([Infinity, Number.NaN, -1, '9e999'])('rejects the non-finite or invalid budget %s before any browser request', (bad) => {
      const browserFallback = vi.fn().mockResolvedValue({ browser: true });
      expect(() => rescueContext(browserFallback, { listingBrowserBudget: bad })).toThrow(TypeError);
      expect(() => rescueContext(browserFallback, { detailBrowserBudget: bad })).toThrow(TypeError);
      expect(() => rescueContext(browserFallback, { browserBackoffMs: bad })).toThrow(TypeError);
      expect(browserFallback).not.toHaveBeenCalled();
    });

    it('rejects a browser backoff above the documented ceiling before any browser request', () => {
      const browserFallback = vi.fn().mockResolvedValue({ browser: true });
      expect(() => rescueContext(browserFallback, { browserBackoffMs: 1_000_000_000_000 })).toThrow(TypeError);
      expect(() => rescueContext(browserFallback, { browserBackoffMs: 30_001 })).toThrow(TypeError);
      expect(() => rescueContext(browserFallback, { browserBackoffMs: 30_000 })).not.toThrow();
      expect(browserFallback).not.toHaveBeenCalled();
    });

    it('caps an explicit oversized budget at the hard ceiling', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
      const browserFallback = vi.fn().mockResolvedValue({ total: 0, jobPostings: [] });
      const context = rescueContext(browserFallback, { listingBrowserBudget: 1_000_000 });

      try {
        const listing = { method: 'POST', body: '{}', retries: 3, retryBaseMs: 0 };
        for (let i = 0; i < 130; i += 1) {
          const req = context.request(`${API_BASE}/jobs`, listing).catch(() => {});
          await vi.runAllTimersAsync();
          await req;
        }
        expect(browserFallback.mock.calls.length).toBe(100);
      } finally {
        await context.close();
        vi.useRealTimers();
      }
    });

    it('uses the built-in browser transport for details by default, but not a caller-supplied one', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
      const { page, browser } = browserTransport({ jobPostingInfo: { jobDescription: '<p>browser</p>' } });
      const context = createWorkdayRequestContext(API_BASE, {
        fallbackCooldownMs: 1_000,
        rateLimitCircuitThreshold: 2,
        browserBackoffMs: 0,
      });

      try {
        const pending = context.request(detailUrl(1), detailOptions);
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toEqual({ jobPostingInfo: { jobDescription: '<p>browser</p>' } });
        expect(page.evaluate).toHaveBeenCalledTimes(1);
      } finally {
        await context.close();
        vi.useRealTimers();
      }
      expect(browser.close).toHaveBeenCalledOnce();
    });
  });

  it('does not treat a connection failure as a consecutive rate limit', async () => {
    const directFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', directFetch);
    const context = createWorkdayRequestContext(API_BASE, {
      browserFallback: null,
      fallbackCooldownMs: 0,
      rateLimitCircuitThreshold: 2,
    });

    try {
      await expect(context.request(`${API_BASE}/job/Zurich/First_R1`, { retries: 0 }))
        .rejects.toMatchObject({
          name: 'WorkdayRateLimitError',
          consecutiveFailures: 1,
          circuitOpen: false,
        });
      await expect(context.request(`${API_BASE}/job/Zurich/Second_R2`, { retries: 0 }))
        .rejects.toBeInstanceOf(WorkdayApiError);
      await expect(context.request(`${API_BASE}/job/Zurich/Third_R3`, { retries: 0 }))
        .rejects.toMatchObject({
          name: 'WorkdayRateLimitError',
          consecutiveFailures: 1,
          circuitOpen: false,
        });
    } finally {
      await context.close();
    }
  });

  it('evicts a rate-limited sidebar promise before retrying after cooldown', async () => {
    vi.useFakeTimers();
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    const sidebarBase = `${API_BASE}/sidebar-cache-retry`;
    const directFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { type: 'TEXT', title: 'About', text: 'Recovered' },
      ]), { status: 200 }));
    vi.stubGlobal('fetch', directFetch);
    const options = { browserFallback: null, fallbackCooldownMs: 5 };

    try {
      await expect(fetchWorkdaySidebarText(sidebarBase, (html) => html, options))
        .rejects.toBeInstanceOf(WorkdayRateLimitError);
      const second = fetchWorkdaySidebarText(sidebarBase, (html) => html, options);
      await vi.advanceTimersByTimeAsync(4);
      expect(directFetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toBe('About\n\nRecovered');
      expect(directFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries browser Retry-After to the next queued tenant request', async () => {
    vi.useFakeTimers();
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    const directFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', directFetch);
    const { page, browser } = browserTransport({ recovered: true });
    page.evaluate
      .mockResolvedValueOnce({ status: 429, retryAfter: '30', body: '' })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ recovered: true }) });
    const context = createWorkdayRequestContext(API_BASE);

    try {
      const first = context.request(`${API_BASE}/job/Zurich/Swiss_R1`);
      await expect(first).rejects.toMatchObject({
        name: 'WorkdayRateLimitError',
        statusCode: 429,
      });
      expect(page.evaluate).toHaveBeenCalledOnce();

      const second = context.request(`${API_BASE}/job/Zurich/Swiss_R2`);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(page.evaluate).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toEqual({ recovered: true });
      expect(page.evaluate).toHaveBeenCalledTimes(2);
    } finally {
      await context.close();
      expect(browser.close).toHaveBeenCalledOnce();
      vi.useRealTimers();
    }
  });

  it('preserves browser 429 metadata after direct retry exhaustion', async () => {
    vi.useFakeTimers();
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', directFetch);
    const { page, browser } = browserTransport({ recovered: true });
    page.evaluate
      .mockResolvedValueOnce({ status: 429, retryAfter: '30', body: '' })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ recovered: true }) });
    const context = createWorkdayRequestContext(API_BASE);

    try {
      const first = context.request(`${API_BASE}/job/Zurich/Swiss_R1`);
      await expect(first).rejects.toMatchObject({
        name: 'WorkdayRateLimitError',
        statusCode: 429,
        status: 429,
        retryAfterMs: 30_000,
      });
      expect(page.evaluate).toHaveBeenCalledOnce();

      const second = context.request(`${API_BASE}/job/Zurich/Swiss_R2`);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(directFetch).toHaveBeenCalledOnce();
      expect(page.evaluate).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toEqual({ recovered: true });
      expect(directFetch).toHaveBeenCalledTimes(2);
      expect(page.evaluate).toHaveBeenCalledTimes(2);
    } finally {
      await context.close();
      expect(browser.close).toHaveBeenCalledOnce();
      vi.useRealTimers();
    }
  });

  it('uses one browser session for two KSB detail requests after transient HTTP failures', async () => {
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
      return new Response('', { status: 503 });
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

  it('boots the KSB fallback on its German public Workday site after a listing failure', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const vacancy = '<p>Für unsere Intensivstation suchen wir eine engagierte Pflegefachperson. Sie arbeiten eng mit Kolleginnen und Kollegen aus mehreren Bereichen zusammen, dokumentieren Ihre Arbeit sorgfältig, bringen Ideen zur Verbesserung der Abläufe ein und erhalten flexible Arbeitszeiten, Weiterbildungen sowie ein kollegiales Team in einem modernen Umfeld. Gute Deutschkenntnisse und eine strukturierte Arbeitsweise runden Ihr Profil ab.</p>';
    const { page } = browserTransport(null);
    page.evaluate.mockImplementation(async (_fn, args) => {
      const url = String(args.requestUrl);
      if (url.endsWith('/jobs')) {
        return {
          status: 200,
          body: JSON.stringify({
            total: 1,
            jobPostings: [{
              title: 'Pflegefachperson Intensivpflege',
              externalPath: '/job/Baden/Pflegefachperson_R-10001',
              locationsText: 'Baden, Switzerland',
            }],
          }),
        };
      }
      if (url.endsWith('/sidebar')) return { status: 200, body: '[]' };
      return {
        status: 200,
        body: JSON.stringify({
          jobPostingInfo: {
            title: 'Pflegefachperson Intensivpflege',
            location: 'Baden, Switzerland',
            jobDescription: vacancy,
            timeType: 'Full time',
          },
        }),
      };
    });

    const jobs = await fetchAllKsbJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Pflegefachperson Intensivpflege', canton: 'AG' });
    expect(page.goto).toHaveBeenCalledWith(
      'https://kantonsspitalbaden.wd3.myworkdayjobs.com/de-DE/ksb-careers',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
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

  it('preserves the portal path when deriving a TRUMPF browser fallback page', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const { page } = browserTransport({
      total: 0,
      jobPostings: [],
    });

    const jobs = [];
    for await (const posting of fetchWorkdayJobs(
      'https://trumpf.wd3.myworkdayjobs.com/wday/cxs/trumpf/TRUMPF_Graduates_and_Professionals',
      { minDelayMs: 0 },
    )) jobs.push(posting);

    expect(jobs).toHaveLength(0);
    expect(page.goto).toHaveBeenCalledWith(
      'https://trumpf.wd3.myworkdayjobs.com/en-US/TRUMPF_Graduates_and_Professionals',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
  });

  it('derives the recruiting path for a shared Workday site browser fallback page', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const { page } = browserTransport({
      total: 0,
      jobPostings: [],
    });

    const jobs = [];
    for await (const posting of fetchWorkdayJobs(
      'https://wd3.myworkdaysite.com/wday/cxs/hamilton/hamilton_jobs',
      { minDelayMs: 0 },
    )) jobs.push(posting);

    expect(jobs).toHaveLength(0);
    expect(page.goto).toHaveBeenCalledWith(
      'https://wd3.myworkdaysite.com/recruiting/hamilton/hamilton_jobs',
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
