import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchViaMorssWithRetry } = vi.hoisted(() => ({
  fetchViaMorssWithRetry: vi.fn(),
}));

vi.mock('../../scripts/lib/morss-proxy.mjs', () => ({ fetchViaMorssWithRetry }));

const { __testables } = await import('../../scripts/lib/shared-jobs-crawler.mjs');
const { fetchWithTimeout } = __testables;

const TARGET_URL = "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4324";
const REAL_MORSS_BODY = `<html><head><title>Amministrazione Cantonale Ticino Jobportal</title></head><body><a href="forma-di-lavoro.html?yid=4324">job</a>${'Real Ti.CH job posting read through Morss. '.repeat(8)}</body></html>`;

describe('fetchWithTimeout — JOBS_CRAWLER_MORSS_PROXY', () => {
  const originalFetch = global.fetch;
  const originalMorssHosts = process.env.JOBS_CRAWLER_MORSS_PROXY;
  const originalJinaHosts = process.env.JOBS_CRAWLER_FETCH_PROXY;

  beforeEach(() => {
    process.env.JOBS_CRAWLER_MORSS_PROXY = 'www.concorsi.ti.ch';
    delete process.env.JOBS_CRAWLER_FETCH_PROXY;
    fetchViaMorssWithRetry.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalMorssHosts === undefined) delete process.env.JOBS_CRAWLER_MORSS_PROXY;
    else process.env.JOBS_CRAWLER_MORSS_PROXY = originalMorssHosts;
    if (originalJinaHosts === undefined) delete process.env.JOBS_CRAWLER_FETCH_PROXY;
    else process.env.JOBS_CRAWLER_FETCH_PROXY = originalJinaHosts;
    vi.restoreAllMocks();
  });

  it('returns the Morss response without attempting direct egress', async () => {
    fetchViaMorssWithRetry.mockResolvedValue(new Response(REAL_MORSS_BODY, { status: 200 }));
    global.fetch = vi.fn() as unknown as typeof fetch;

    const response = await fetchWithTimeout(TARGET_URL);

    expect(response.ok).toBe(true);
    expect(await response.text()).toBe(REAL_MORSS_BODY);
    expect(fetchViaMorssWithRetry).toHaveBeenCalledWith(TARGET_URL, expect.objectContaining({ attempts: 2 }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls back to the original URL when Morss is exhausted', async () => {
    fetchViaMorssWithRetry.mockResolvedValue(null);
    global.fetch = vi.fn(async () => new Response(REAL_MORSS_BODY, { status: 200 })) as unknown as typeof fetch;

    const response = await fetchWithTimeout(TARGET_URL);

    expect(response.ok).toBe(true);
    expect(await response.text()).toBe(REAL_MORSS_BODY);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(TARGET_URL);
  });

  it('falls back when Morss returns an interstitial instead of the requested detail page', async () => {
    fetchViaMorssWithRetry.mockResolvedValue(new Response('<html><title>Checking your browser</title></html>', { status: 200 }));
    global.fetch = vi.fn(async () => new Response(REAL_MORSS_BODY, { status: 200 })) as unknown as typeof fetch;

    const response = await fetchWithTimeout(TARGET_URL);

    expect(response.ok).toBe(true);
    expect(await response.text()).toBe(REAL_MORSS_BODY);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(TARGET_URL);
  });
});
