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
 * signals (network/timeout/429/5xx), fail fast on persistent 4xx (404). Plain
 * anti-bot blocks (403/401/406) route to the Playwright fallback; a
 * SAME-ORIGIN anti-bot block that survives Playwright still fails fast, but a
 * CROSS-ORIGIN one (PastaHR/publicjobs.ch — #3255) is retried with backoff
 * because Playwright can never observe that block (browser-enforced CORS) and
 * the fence has proven transient across scheduled runs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { fetchHtml as hospitalFetchHtml } from '../scripts/lib/hospital-custom-html-helpers.mjs';
import { fetchGreenhouseJobs, GreenhouseApiError } from '../scripts/lib/ats-clients/greenhouse-client.mjs';
import { fetchLeverJobs } from '../scripts/lib/ats-clients/lever-client.mjs';
import { fetchWorkdayJobDetail } from '../scripts/lib/ats-clients/workday-client.mjs';

// The PastaHR/GZO-Wetzikon/IGS-Bern case (#3255) is cross-origin between the
// employer's career page (referer) and the widget endpoint (publicjobs.ch), so
// the Playwright fallback is structurally unable to observe a WAF-blocked
// response (browser-enforced CORS strips it to an unreadable `Failed to
// fetch`) and must be SKIPPED rather than launched. Mock `launchChromium` so
// any regression that still tries to launch a browser for that case fails the
// test loudly instead of silently spending 30-45s on a real Chromium
// install/launch in CI.
const { launchChromiumMock } = vi.hoisted(() => ({ launchChromiumMock: vi.fn() }));
vi.mock('../scripts/lib/ensure-chromium.mjs', () => ({
  launchChromium: launchChromiumMock,
}));

import {
  fetchPostWidgetWithAntiBotHardening,
  fetchPastaHrWidgetPage,
} from '../scripts/lib/pastahr-widget-client.mjs';

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
  launchChromiumMock.mockReset();
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

  // #4247 sibling: a 200 response with an HTML WAF/challenge body instead of
  // JSON (same signature as the Bucher + Suter WP REST break) previously threw
  // a GreenhouseApiError with statusCode=200, which this client's isTransient
  // predicate (statusCode===0 || statusCode>=500) did NOT retry — failing fast
  // on a transient blip. It must now self-heal via the shared backoff loop.
  it('retries a 200 response with a non-JSON (WAF challenge) body, then succeeds', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(200, '<html><head><title>Just a moment...</title></head></html>'))
      .mockResolvedValueOnce(jsonResponse(200, { jobs: [{ id: 1, title: 'Dev', location: { name: 'Zurich' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchGreenhouseJobs('acme');
    expect(jobs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws after a persistent 200-but-non-JSON (WAF challenge) body', async () => {
    withFastRetry();
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(200, '<html><head><title>Blocked</title></head></html>'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGreenhouseJobs('acme')).rejects.toBeInstanceOf(GreenhouseApiError);
    // 1 initial attempt + the shared default of 3 retries = 4 total — still
    // fails loudly (no silent empty-jobs swallow), just after self-heal attempts.
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

    const jobs = await fetchLeverJobs('acme', { companyName: 'Acme' } as any);
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

// #4247 sibling found via GitNexus impact analysis on the fetchJson rename:
// fetchWorkdayJobDetail's `return await res.json();` had no try/catch, so a
// 200-but-HTML WAF challenge body threw a bare SyntaxError that the shared
// isTransientFetchError() classifier (used as the default here — no custom
// isTransient override) does NOT recognise as transient — same root cause as
// Bucher + Suter, different ATS. Must now self-heal via backoff instead of
// degrading straight to null on one blip.
describe('workday-client.fetchWorkdayJobDetail', () => {
  it('retries a 200 response with a non-JSON (WAF challenge) body, then returns parsed detail', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(200, '<html><head><title>Just a moment...</title></head></html>'))
      .mockResolvedValueOnce(jsonResponse(200, { jobPostingInfo: { title: 'Engineer' } }));
    vi.stubGlobal('fetch', fetchMock);

    const detail = await fetchWorkdayJobDetail('https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers', '/job/123');
    expect(detail).toEqual({ jobPostingInfo: { title: 'Engineer' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('degrades to null (its designed safe-fail contract) after a persistent 200-but-non-JSON body', async () => {
    withFastRetry();
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(200, '<html><head><title>Blocked</title></head></html>'));
    vi.stubGlobal('fetch', fetchMock);

    const detail = await fetchWorkdayJobDetail('https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers', '/job/123');
    expect(detail).toBeNull();
    // 1 initial attempt + the shared default of 3 retries = 4 total — the
    // retry loop was actually exercised, not a fail-fast on attempt 1.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

// The anti-bot widget client (Phenom/Straumann #1751, PastaHR/IGS/GZO) was
// extracted off the old `fetchJson` path, which dropped its 429/5xx
// backoff-retry (#1846 follow-up of #1827). Pin that the transient retry is
// restored on BOTH exported fetchers, while anti-bot 403/429-vs-5xx routing is
// unchanged (5xx/429 retry, 4xx fail fast). The Playwright fallback only fires
// on 403/401/406, so the 5xx/4xx cases below never launch a browser.
describe('pastahr-widget-client.fetchPostWidgetWithAntiBotHardening (Phenom JSON POST)', () => {
  const OPTS = { referer: 'https://careers.straumann.com/', origin: 'https://careers.straumann.com' };

  it('retries a transient 503 then returns the parsed widget JSON', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { refineSearch: { data: { jobs: [{ jobId: 1 }] } } }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchPostWidgetWithAntiBotHardening({ from: 0 }, 'https://careers.straumann.com/widgets', OPTS);
    expect(data.refineSearch.data.jobs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient 429 (rate-limit) then succeeds', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchPostWidgetWithAntiBotHardening({ from: 0 }, 'https://careers.straumann.com/widgets', OPTS);
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast on a persistent 404 without retrying (endpoint moved)', async () => {
    withFastRetry();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchPostWidgetWithAntiBotHardening({ from: 0 }, 'https://careers.straumann.com/widgets', OPTS),
    ).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('pastahr-widget-client.fetchPastaHrWidgetPage (PastaHR URL-encoded POST)', () => {
  const OPTS = { referer: 'https://www.igsbern.ch/jobs/', origin: 'https://www.igsbern.ch' };

  it('retries a transient 502 then returns the parsed widget JSON', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502, {}))
      .mockResolvedValueOnce(jsonResponse(200, { jobs: [{ id: 1 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchPastaHrWidgetPage(new URLSearchParams({ page: '0' }), OPTS);
    expect(data.jobs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast on a persistent 404 without retrying', async () => {
    withFastRetry();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPastaHrWidgetPage(new URLSearchParams({ page: '0' }), OPTS)).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// #3255: GZO Wetzikon + IGS Bern both failed with
// `[widget-pw] Playwright fallback failed: page.evaluate: TypeError: Failed
// to fetch` after the primary Node fetch got HTTP 403. The referer
// (igsbern.ch / gzo.ch) is cross-origin to the widget endpoint
// (www.publicjobs.ch), so the in-page `fetch` inside Playwright is subject to
// browser-enforced CORS: a Cloudflare block response carries no CORS headers,
// so the browser can NEVER read a status — it always throws a generic
// "Failed to fetch", 0% observed success across every incident log checked.
// Fix: skip the (structurally futile) Playwright hop for cross-origin pairs
// and mark the anti-bot failure retryable instead, so the shared backoff loop
// gives the (empirically transient — later scheduled runs routinely succeed)
// WAF fence a few more spaced attempts within the SAME run.
describe('pastahr-widget-client — cross-origin anti-bot fence retry (#3255)', () => {
  const CROSS_ORIGIN_OPTS = { referer: 'https://www.gzo.ch/karriere/offene-stellen', origin: 'https://www.gzo.ch' };

  it('fetchPastaHrWidgetPage: skips Playwright and retries a transient cross-origin 403 until it clears', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, {}))
      .mockResolvedValueOnce(jsonResponse(403, {}))
      .mockResolvedValueOnce(jsonResponse(200, { jobs: [{ id: 1 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchPastaHrWidgetPage(new URLSearchParams({ page: '0' }), CROSS_ORIGIN_OPTS);
    expect(data.jobs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Playwright must never be launched for a cross-origin pair — it cannot
    // observe a blocked response through CORS, so it would only waste time.
    expect(launchChromiumMock).not.toHaveBeenCalled();
  });

  it('fetchPastaHrWidgetPage: exhausts backoff and throws if the cross-origin 403 never clears', async () => {
    withFastRetry();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchPastaHrWidgetPage(new URLSearchParams({ page: '0' }), CROSS_ORIGIN_OPTS),
    ).rejects.toThrow(/HTTP 403/);
    // 1 initial attempt + the shared default of 3 retries = 4 total.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(launchChromiumMock).not.toHaveBeenCalled();
  });

  it('fetchPostWidgetWithAntiBotHardening: skips Playwright and retries a transient cross-origin 403 until it clears', async () => {
    withFastRetry();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, {}))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchPostWidgetWithAntiBotHardening(
      { from: 0 },
      'https://www.publicjobs.ch/widget',
      CROSS_ORIGIN_OPTS,
    );
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(launchChromiumMock).not.toHaveBeenCalled();
  });

  it('fetchPostWidgetWithAntiBotHardening: a SAME-ORIGIN 403 still attempts Playwright (unlike the cross-origin case)', async () => {
    withFastRetry();
    // Same-origin pair (Straumann/Phenom-style): Playwright IS a genuine
    // candidate to clear the block, so launchChromium must be reached. Make
    // it reject (no real browser in this unit test) so we can assert the
    // final failure is NOT silently retried away — same-origin keeps the
    // original fail-fast contract, only the cross-origin case gets the new
    // retry behaviour.
    launchChromiumMock.mockRejectedValue(new Error('no browser in unit test'));
    const SAME_ORIGIN_OPTS = { referer: 'https://careers.straumann.com/', origin: 'https://careers.straumann.com' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchPostWidgetWithAntiBotHardening({ from: 0 }, 'https://careers.straumann.com/widgets', SAME_ORIGIN_OPTS),
    ).rejects.toThrow(/HTTP 403/);
    expect(launchChromiumMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
