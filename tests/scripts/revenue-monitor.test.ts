import { describe, expect, it, vi } from 'vitest';

// The script is pure ESM (.mjs). Its JSDoc-inferred exported types are too
// strict for the mock-driven tests below (fetchPostHogCls's options are typed
// from a positional call that did not include apiKey/projectId), so we coerce
// via `as any` at the import boundary. main() is gated on process.argv[1],
// so importing is side-effect-free.
import * as revenueMonitorModule from '../../scripts/revenue-monitor.mjs';
const {
  BASELINE,
  GSC_BUCKETS,
  bucketCtrFromRows,
  buildComparisonRows,
  compare,
  fetchPostHogCls,
  renderMarkdown,
} = revenueMonitorModule as unknown as {
  BASELINE: { period: string };
  GSC_BUCKETS: readonly string[];
  bucketCtrFromRows: (rows: any[], buckets: string[]) => Record<string, number | null>;
  buildComparisonRows: (current: any, baseline?: any) => Array<{ metric: string; verdict: string; baseline: unknown; current: unknown }>;
  compare: (current: number | null, baseline: number | null, opts?: { higherIsBetter?: boolean }) => { delta: number | null; deltaPct: number | null; verdict: string };
  fetchPostHogCls: (opts: { apiKey: string | null; projectId: string | null; host?: string; fetchImpl?: unknown }) => Promise<{ clsP75Mobile: number | null; clsP75Desktop: number | null } | null>;
  renderMarkdown: (rows: unknown[], current: any, baseline?: any) => string;
};

describe('revenue-monitor / compare()', () => {
  it('flags 🔴 regressed hard when metric drops more than 20%', () => {
    const r = compare(70, 100);
    expect(r.deltaPct).toBe(-30);
    expect(r.verdict).toBe('🔴 regressed hard');
  });

  it('flags ⚠️ regressed between 10% and 20% drop', () => {
    const r = compare(85, 100);
    expect(r.deltaPct).toBe(-15);
    expect(r.verdict).toBe('⚠️ regressed');
  });

  it('flags ✅ flat within ±10%', () => {
    const r = compare(95, 100);
    expect(r.verdict).toBe('✅ flat');
  });

  it('flags 📈 improved when >10% up', () => {
    const r = compare(120, 100);
    expect(r.verdict).toBe('📈 improved');
  });

  it('inverts semantics when higherIsBetter=false (CLS, position)', () => {
    // CLS regressed: went UP by 40% — this is bad.
    const r = compare(0.70, 0.50, { higherIsBetter: false });
    expect(r.verdict).toBe('🔴 regressed hard');
  });

  it('returns ⚪ n/a when either value is null', () => {
    expect(compare(null, 100).verdict).toBe('⚪ n/a');
    expect(compare(100, null).verdict).toBe('⚪ n/a');
  });
});

describe('revenue-monitor / bucketCtrFromRows()', () => {
  it('aggregates clicks and impressions into CTR % per bucket', () => {
    const rows = [
      { keys: ['https://frontaliereticino.ch/job-board/abc/'], clicks: 10, impressions: 100 },
      { keys: ['https://frontaliereticino.ch/job-board/def/'], clicks: 5, impressions: 200 },
      { keys: ['https://frontaliereticino.ch/fisco/x/'], clicks: 3, impressions: 50 },
      { keys: ['https://frontaliereticino.ch/unmatched/'], clicks: 999, impressions: 999 },
    ];
    const buckets = ['/job-board/', '/fisco/'];
    const out = bucketCtrFromRows(rows, buckets);
    expect(out['/job-board/']).toBe(5); // 15 / 300 = 5%
    expect(out['/fisco/']).toBe(6); // 3 / 50
  });

  it('returns null for buckets with zero impressions', () => {
    const out = bucketCtrFromRows([], ['/a/', '/b/']);
    expect(out['/a/']).toBeNull();
    expect(out['/b/']).toBeNull();
  });

  it('attributes each row to at most one bucket (first match)', () => {
    const rows = [
      { keys: ['/articoli-frontaliere/guida-frontaliere/'], clicks: 10, impressions: 100 },
    ];
    const out = bucketCtrFromRows(rows, ['/articoli-frontaliere/', '/guida-frontaliere/']);
    expect(out['/articoli-frontaliere/']).toBe(10);
    expect(out['/guida-frontaliere/']).toBeNull();
  });
});

describe('revenue-monitor / buildComparisonRows() CLS + CTR', () => {
  it('includes PostHog CLS rows when posthog data present', () => {
    const current = {
      adsense: null,
      gsc: null,
      posthog: { clsP75Mobile: 0.62, clsP75Desktop: 0.20, window: {} },
    };
    const rows = buildComparisonRows(current);
    const clsMobile = rows.find((r: any) => r.metric === 'CLS p75 mobile');
    const clsDesktop = rows.find((r: any) => r.metric === 'CLS p75 desktop');
    expect(clsMobile).toBeDefined();
    expect(clsDesktop).toBeDefined();
    // 0.62 vs baseline 0.51 → +21.6% with higherIsBetter=false → 🔴
    expect(clsMobile!.verdict).toBe('🔴 regressed hard');
  });

  it('includes GSC CTR rows for every configured bucket', () => {
    const current = {
      adsense: null,
      gsc: {
        clicksPerDay: 323,
        avgPosition: 5.7,
        ctrByBucket: Object.fromEntries(GSC_BUCKETS.map((b: string) => [b, 4.0])),
        window: {},
      },
      posthog: null,
    };
    const rows = buildComparisonRows(current);
    for (const bucket of GSC_BUCKETS) {
      expect(rows.some((r: any) => r.metric === `GSC CTR ${bucket} (%)`)).toBe(true);
    }
  });

  it('emits ⚪ auth missing when PostHog data is null', () => {
    const current = { adsense: null, gsc: null, posthog: null };
    const rows = buildComparisonRows(current);
    expect(rows.some((r: any) => r.metric === 'PostHog CLS' && r.verdict === '⚪ auth missing')).toBe(true);
  });
});

describe('revenue-monitor / fetchPostHogCls()', () => {
  it('returns null when credentials missing', async () => {
    const out = await fetchPostHogCls({ apiKey: null, projectId: null });
    expect(out).toBeNull();
  });

  it('posts HogQL queries for Mobile and Desktop and parses results', async () => {
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      // Return different CLS values based on device type in the query.
      const device = body.query.query.includes("'Mobile'") ? 0.42 : 0.11;
      return {
        ok: true,
        status: 200,
        async json() {
          return { results: [[device]] };
        },
      };
    });

    const out = await fetchPostHogCls({
      apiKey: 'phx_test',
      projectId: '1234',
      host: 'https://eu.posthog.com',
      fetchImpl: fetchImpl as any,
    });

    expect(out).not.toBeNull();
    expect(out!.clsP75Mobile).toBe(0.42);
    expect(out!.clsP75Desktop).toBe(0.11);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstCallUrl, firstCallInit] = fetchImpl.mock.calls[0];
    expect(firstCallUrl).toBe('https://eu.posthog.com/api/projects/1234/query/');
    expect(firstCallInit.headers.Authorization).toBe('Bearer phx_test');
  });

  it('throws on PostHog API error (caught by main() and surfaced as warning)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      async text() {
        return 'unauthorized';
      },
    }));
    await expect(
      fetchPostHogCls({
        apiKey: 'bad',
        projectId: '1',
        host: 'https://eu.posthog.com',
        fetchImpl: fetchImpl as any,
      }),
    ).rejects.toThrow(/posthog 401/);
  });
});

describe('revenue-monitor / renderMarkdown()', () => {
  it('surfaces new CLS + CTR rows in markdown output', () => {
    const current = {
      adsense: null,
      gsc: {
        clicksPerDay: 320,
        avgPosition: 5.7,
        ctrByBucket: { '/job-board/': 6.0 },
        window: { start: '2026-04-13', end: '2026-04-19' },
      },
      posthog: { clsP75Mobile: 0.50, clsP75Desktop: 0.17, window: {} },
      warnings: [],
    };
    const rows = buildComparisonRows(current);
    const md = renderMarkdown(rows, current);
    expect(md).toContain('CLS p75 mobile');
    expect(md).toContain('GSC CTR /job-board/ (%)');
    expect(md).toContain(BASELINE.period);
  });

  it('includes Warnings section when warnings present', () => {
    const current = { adsense: null, gsc: null, posthog: null, warnings: ['PostHog skipped'] };
    const rows = buildComparisonRows(current);
    const md = renderMarkdown(rows, current);
    expect(md).toContain('## Warnings');
    expect(md).toContain('PostHog skipped');
  });
});
