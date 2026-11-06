import { afterEach, describe, expect, it, vi } from 'vitest';
import { AD_CLIENT } from '../services/adsenseSlots.ts';
import * as canaryRpmModule from '../scripts/canary-rpm.mjs';

const { fetchDailyRpm } = canaryRpmModule as unknown as {
  fetchDailyRpm: (options?: { fetchImpl?: typeof fetch; now?: Date }) => Promise<{
    account: string;
    rows: Array<{ date: string; rpm: number; earnings: number; pageViews: number; coverage: number }>;
  }>;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('canary-rpm / AdSense account targeting', () => {
  it('uses the configured AD_CLIENT account and keeps the existing 14-day UTC window', async () => {
    vi.stubEnv('ADSENSE_REFRESH_TOKEN', 'refresh-token');
    vi.stubEnv('ADSENSE_CLIENT_ID', 'client-id');
    vi.stubEnv('ADSENSE_CLIENT_SECRET', 'client-secret');
    const now = new Date('2026-10-23T12:00:00.000Z');
    const account = `accounts/${AD_CLIENT.replace(/^ca-/, '')}`;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-token' });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(`/v2/${account}/reports:generate`);
      return Response.json({ rows: [{ cells: [
        { value: '2026-10-23' },
        { value: '2.5' },
        { value: '3.75' },
        { value: '1500' },
        { value: '0.7' },
      ] }] });
    });

    const result = await fetchDailyRpm({ fetchImpl: fetchImpl as typeof fetch, now });

    expect(result).toEqual({
      account,
      rows: [{ date: '2026-10-23', rpm: 2.5, earnings: 3.75, pageViews: 1500, coverage: 0.7 }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain(`/v2/${account}/reports:generate`);
    expect(calls.some((call) => call.url === 'https://adsense.googleapis.com/v2/accounts')).toBe(false);
    const params = new URL(calls[1].url).searchParams;
    expect(params.get('startDate.year')).toBe('2026');
    expect(params.get('startDate.month')).toBe('10');
    expect(params.get('startDate.day')).toBe('9');
    expect(params.get('endDate.year')).toBe('2026');
    expect(params.get('endDate.month')).toBe('10');
    expect(params.get('endDate.day')).toBe('23');
  });
});
