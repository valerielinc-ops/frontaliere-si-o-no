import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeState = vi.hoisted(() => {
  const browser = { id: 'browser' };
  const context = {
    setDefaultNavigationTimeout: vi.fn(),
  };
  const page = {
    waitForTimeout: vi.fn(async () => {}),
    $$eval: vi.fn(async (_selector: string, mapLinks: (nodes: Array<{ getAttribute: (name: string) => string }>) => unknown) =>
      mapLinks([
        { getAttribute: () => '/careers' },
        { getAttribute: () => 'https://jobs.example.test/openings' },
        { getAttribute: () => '/about' },
      ])),
  };

  return {
    browser,
    context,
    page,
    fetchError: null as Error | null,
    createBrowser: vi.fn(async () => browser),
    createPoliteContext: vi.fn(async () => context),
    fetchWithRateLimit: vi.fn(async () => {
      if (runtimeState.fetchError) throw runtimeState.fetchError;
      return page;
    }),
    closeAll: vi.fn(async () => {}),
  };
});

vi.mock('../scripts/lib/ats-clients/playwright-runtime.mjs', () => ({
  createBrowser: runtimeState.createBrowser,
  createPoliteContext: runtimeState.createPoliteContext,
  fetchWithRateLimit: runtimeState.fetchWithRateLimit,
  closeAll: runtimeState.closeAll,
}));

process.env.JOBS_BROWSER_FALLBACK_WAIT_MS = '0';
const { __testables } = await import('../scripts/lib/shared-jobs-crawler.mjs');

afterEach(() => {
  runtimeState.fetchError = null;
  runtimeState.createBrowser.mockClear();
  runtimeState.createPoliteContext.mockClear();
  runtimeState.fetchWithRateLimit.mockClear();
  runtimeState.closeAll.mockClear();
  runtimeState.context.setDefaultNavigationTimeout.mockClear();
  runtimeState.page.waitForTimeout.mockClear();
  runtimeState.page.$$eval.mockClear();
});

describe('shared crawler browser fallback', () => {
  it('uses the shared runtime navigation path and preserves the fallback timeout', async () => {
    const website = 'https://example.test/company';
    const result = await __testables.discoverCareerUrlsWithBrowserFallback(website);

    expect(result).toEqual({
      urls: ['https://example.test/careers', 'https://jobs.example.test/openings'],
      reason: 'ok',
    });
    expect(runtimeState.createBrowser).toHaveBeenCalledWith({ userAgent: expect.any(String) });
    expect(runtimeState.createPoliteContext).toHaveBeenCalledWith(
      runtimeState.browser,
      { userAgent: expect.any(String) },
    );
    expect(runtimeState.context.setDefaultNavigationTimeout).toHaveBeenCalledWith(25_000);
    expect(runtimeState.fetchWithRateLimit).toHaveBeenCalledWith(
      runtimeState.context,
      website,
      { minDelayMs: 0, navigationTimeoutMs: 25_000 },
    );
    expect(runtimeState.closeAll).toHaveBeenCalledWith(runtimeState.browser);
  });

  it('fails closed while still closing the shared browser after navigation failure', async () => {
    runtimeState.fetchError = new Error('anti-bot block');

    const result = await __testables.discoverCareerUrlsWithBrowserFallback('https://example.test/company');

    expect(result).toMatchObject({ urls: [], reason: 'anti-bot block' });
    expect(runtimeState.closeAll).toHaveBeenCalledWith(runtimeState.browser);
  });
});
