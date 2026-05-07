import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as adsenseMod from '../../../scripts/lib/perf-sources/adsense.mjs';

const { fetchAdsenseChannelRevenue } = adsenseMod as any;

// Helper: build a fetch Response-shaped object the helper consumes.
function jsonRes(body: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// AdSense report row shape: cells = [DATE, URL_CHANNEL_NAME, ESTIMATED_EARNINGS]
function row(date: string, channel: string, earnings: number | string) {
  return { cells: [{ value: date }, { value: channel }, { value: String(earnings) }] };
}

const TOKEN_BODY = { access_token: 'fake-token-xyz' };
const ACCOUNTS_BODY = { accounts: [{ name: 'accounts/pub-1234567890' }] };

/**
 * Build a sequenced mock-fetch that returns:
 *   1. token endpoint
 *   2. accounts endpoint
 *   3..N. report pages (one per call, in the order supplied)
 * Anything beyond throws.
 */
function makeFetchSequence(reportPages: any[]) {
  let i = 0;
  const calls: Array<{ url: string; init?: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init });
    if (url.includes('oauth2.googleapis.com/token')) return jsonRes(TOKEN_BODY);
    if (url.includes('/v2/accounts') && !url.includes('reports:generate')) {
      return jsonRes(ACCOUNTS_BODY);
    }
    if (url.includes('reports:generate')) {
      const page = reportPages[i++];
      if (!page) throw new Error(`unexpected extra report call (i=${i})`);
      return jsonRes(page);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fetchImpl, calls };
}

describe('fetchAdsenseChannelRevenue', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIG_ENV,
      ADSENSE_REFRESH_TOKEN: 'rt',
      ADSENSE_CLIENT_ID: 'cid',
      ADSENSE_CLIENT_SECRET: 'sec',
    };
  });

  afterEach(() => {
    process.env = ORIG_ENV;
    vi.restoreAllMocks();
  });

  it('aggregates a single-page response into per-channel totals', async () => {
    const { fetchImpl } = makeFetchSequence([
      {
        rows: [
          row('2026-04-10', 'articoli-frontaliere', '1.50'),
          row('2026-04-11', 'articoli-frontaliere', '2.25'),
          row('2026-04-10', 'home-banner', '0.80'),
        ],
        // no nextPageToken => single page
      },
    ]);

    const log = vi.fn();
    const result = await fetchAdsenseChannelRevenue({ windowDays: 30, fetchImpl, log });

    expect(result.rows).toBe(3);
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.droppedMalformed).toBe(0);
    // matchedHints fires because 'articoli-frontaliere' contains 'articoli'
    expect(result.matchedHints).toBe(true);
    expect(result.matchedChannelNames).toEqual(['articoli-frontaliere']);
    expect(result.hintMatchedRevenue).toBe(3.75);
    expect(result.totalAcrossAllChannels).toBe(4.55);
    expect(result.totalRevenue).toBe(3.75);
    expect(result.perChannel).toEqual({
      'articoli-frontaliere': 3.75,
      'home-banner': 0.8,
    });
    // structured logging emitted at least once
    expect(log).toHaveBeenCalled();
    const allLogs = log.mock.calls.map((c) => c[0]).join('\n');
    expect(allLogs).toContain('[adsense]');
  });

  it('exhausts nextPageToken across multiple pages', async () => {
    const { fetchImpl, calls } = makeFetchSequence([
      {
        rows: [row('2026-04-10', 'articoli', '1.00')],
        nextPageToken: 'tok-2',
      },
      {
        rows: [row('2026-04-11', 'articoli', '2.00')],
        nextPageToken: 'tok-3',
      },
      {
        rows: [row('2026-04-12', 'articoli', '3.00')],
        // no nextPageToken => stop
      },
    ]);

    const result = await fetchAdsenseChannelRevenue({
      windowDays: 30,
      fetchImpl,
      log: () => {},
    });

    expect(result.pages).toBe(3);
    expect(result.rows).toBe(3);
    expect(result.totalAcrossAllChannels).toBe(6);
    expect(result.perChannel).toEqual({ articoli: 6 });

    // Verify the second + third report calls included pageToken=...
    const reportCalls = calls.filter((c) => c.url.includes('reports:generate'));
    expect(reportCalls).toHaveLength(3);
    expect(reportCalls[0]!.url).not.toContain('pageToken=');
    expect(reportCalls[1]!.url).toContain('pageToken=tok-2');
    expect(reportCalls[2]!.url).toContain('pageToken=tok-3');
  });

  it('handles an empty response gracefully', async () => {
    const { fetchImpl } = makeFetchSequence([
      {
        // The AdSense API may return no rows at all — treat as 0 revenue.
      },
    ]);

    const result = await fetchAdsenseChannelRevenue({
      windowDays: 30,
      fetchImpl,
      log: () => {},
    });

    expect(result.rows).toBe(0);
    expect(result.pages).toBe(1);
    expect(result.totalRevenue).toBe(0);
    expect(result.totalAcrossAllChannels).toBe(0);
    expect(result.hintMatchedRevenue).toBe(0);
    expect(result.matchedHints).toBe(false);
    expect(result.matchedChannelNames).toEqual([]);
    expect(result.perChannel).toEqual({});
  });

  it('skips malformed rows but keeps valid ones, counting drops', async () => {
    const { fetchImpl } = makeFetchSequence([
      {
        rows: [
          row('2026-04-10', 'articoli', '1.50'),
          { cells: [{ value: '2026-04-11' }] }, // too few cells
          { cells: [{ value: '2026-04-12' }, { value: 'articoli' }, { value: 'not-a-number' }] },
          row('2026-04-13', 'articoli', '2.50'),
          {}, // no cells at all
        ],
      },
    ]);

    const result = await fetchAdsenseChannelRevenue({
      windowDays: 30,
      fetchImpl,
      log: () => {},
    });

    expect(result.rows).toBe(5); // raw row count (post-pagination)
    expect(result.droppedMalformed).toBe(3);
    expect(result.totalAcrossAllChannels).toBe(4);
    expect(result.perChannel).toEqual({ articoli: 4 });
  });

  it('falls back to all-channel total when no hint matches', async () => {
    const { fetchImpl } = makeFetchSequence([
      {
        rows: [
          row('2026-04-10', 'home-banner', '5.00'),
          row('2026-04-11', 'sidebar-promo', '3.00'),
        ],
      },
    ]);

    const result = await fetchAdsenseChannelRevenue({
      windowDays: 30,
      fetchImpl,
      log: () => {},
    });

    // No channel name contains 'articoli' / 'blog' / 'article'
    expect(result.matchedHints).toBe(false);
    expect(result.matchedChannelNames).toEqual([]);
    expect(result.hintMatchedRevenue).toBe(0);
    expect(result.totalAcrossAllChannels).toBe(8);
    // Fallback: totalRevenue equals all-channel total when hints missed.
    expect(result.totalRevenue).toBe(8);
  });

  it('throws a clear error when the env credentials are missing', async () => {
    delete process.env.ADSENSE_REFRESH_TOKEN;
    await expect(
      fetchAdsenseChannelRevenue({ fetchImpl: vi.fn(), log: () => {} }),
    ).rejects.toThrow(/ADSENSE_REFRESH_TOKEN/);
  });

  it('propagates a clear error when the report endpoint returns non-OK', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com/token')) return jsonRes(TOKEN_BODY);
      if (url.includes('/v2/accounts') && !url.includes('reports:generate')) {
        return jsonRes(ACCOUNTS_BODY);
      }
      // 403 from the report endpoint — typical OAuth-scope mismatch.
      return jsonRes('forbidden', { ok: false, status: 403 });
    });

    await expect(
      fetchAdsenseChannelRevenue({ fetchImpl, log: () => {} }),
    ).rejects.toThrow(/adsense report 403/);
  });

  it('sends DATE × URL_CHANNEL_NAME dimensions in the report query', async () => {
    const { fetchImpl, calls } = makeFetchSequence([{ rows: [] }]);
    await fetchAdsenseChannelRevenue({ windowDays: 30, fetchImpl, log: () => {} });
    const reportCall = calls.find((c) => c.url.includes('reports:generate'));
    expect(reportCall).toBeDefined();
    // Two dimension query params, one for DATE and one for URL_CHANNEL_NAME.
    expect(reportCall!.url).toContain('dimensions=DATE');
    expect(reportCall!.url).toContain('dimensions=URL_CHANNEL_NAME');
    expect(reportCall!.url).toContain('metrics=ESTIMATED_EARNINGS');
  });
});
