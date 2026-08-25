import { afterEach, describe, expect, it, vi } from 'vitest';

// The script is pure ESM (.mjs); main() is gated on process.argv[1], so
// importing it is side-effect-free — same pattern as
// tests/scripts/revenue-monitor.test.ts.
import * as reportModule from '../../scripts/adsense-format-ab-report.mjs';
const {
  ADSENSE_ACCOUNT,
  CANTON_PAGE_PATHS,
  CONTROL_CHANNEL,
  TREATMENT_CHANNEL,
  CWV_METRICS,
  POSTHOG_CWV_WINDOW_DAYS,
  SMALL_SAMPLE_PAGEVIEWS,
  parseCellNumber,
  pctDelta,
  computeDeltas,
  computeEngagementDeltas,
  postHogTrickleHasAnyData,
  fetchChannelReport,
  fetchCruxRecord,
  fetchGa4WebVitalsRatings,
  buildMarkdown,
  buildHistoryEntry,
} = reportModule as unknown as {
  ADSENSE_ACCOUNT: string;
  CANTON_PAGE_PATHS: { control: string; treatment: string };
  CONTROL_CHANNEL: string;
  TREATMENT_CHANNEL: string;
  CWV_METRICS: readonly string[];
  POSTHOG_CWV_WINDOW_DAYS: number;
  SMALL_SAMPLE_PAGEVIEWS: number;
  parseCellNumber: (v: unknown) => number | null;
  pctDelta: (treatment: number | null, control: number | null) => number | null;
  computeDeltas: (control: any, treatment: any) => { rpmPct: number | null; coveragePct: number | null; earningsPerPageviewPct: number | null };
  computeEngagementDeltas: (control: any, treatment: any) => Record<string, number | null>;
  postHogTrickleHasAnyData: (posthog: any) => boolean;
  fetchChannelReport: (token: string) => Promise<any>;
  fetchCruxRecord: (url: string, apiKey?: string | null) => Promise<any>;
  fetchGa4WebVitalsRatings: (token: string) => Promise<any>;
  buildMarkdown: (report: any, history?: any) => string;
  buildHistoryEntry: (report: any) => Record<string, unknown>;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('adsense-format-ab-report / identifiers', () => {
  it('derives the AdSense account resource name from AD_CLIENT (no second hardcoded literal)', () => {
    expect(ADSENSE_ACCOUNT).toBe('accounts/pub-8628054934855353');
  });

  it('scopes the two AdSense URL channels and the two page paths to the IT canton pages under test', () => {
    expect(CONTROL_CHANNEL).toBe('frontaliereticino.ch/cerca-lavoro-basilea');
    expect(TREATMENT_CHANNEL).toBe('frontaliereticino.ch/cerca-lavoro-lucerna');
    expect(CANTON_PAGE_PATHS).toEqual({ control: '/cerca-lavoro-basilea/', treatment: '/cerca-lavoro-lucerna/' });
  });
});

describe('adsense-format-ab-report / parseCellNumber()', () => {
  it('parses a bare numeric string', () => {
    expect(parseCellNumber('18.34')).toBe(18.34);
  });

  it('strips a trailing percent sign (AdSense percentage-metric format observed either way)', () => {
    expect(parseCellNumber('18.34%')).toBe(18.34);
  });

  it('returns null for null/undefined/non-numeric input', () => {
    expect(parseCellNumber(null)).toBeNull();
    expect(parseCellNumber(undefined)).toBeNull();
    expect(parseCellNumber('n/a')).toBeNull();
  });
});

describe('adsense-format-ab-report / pctDelta()', () => {
  it('computes a signed percent delta of treatment vs control', () => {
    expect(pctDelta(1.5, 1.0)).toBe(50);
    expect(pctDelta(0.5, 1.0)).toBe(-50);
  });

  it('returns null when either side is null/undefined, or control is zero (no division by zero)', () => {
    expect(pctDelta(null, 1)).toBeNull();
    expect(pctDelta(1, null)).toBeNull();
    expect(pctDelta(1, 0)).toBeNull();
  });
});

describe('adsense-format-ab-report / computeDeltas() + computeEngagementDeltas()', () => {
  it('returns all-null deltas when either side of the AdSense comparison is missing (never throws)', () => {
    expect(computeDeltas(null, { rpmCHF: 1 })).toEqual({ rpmPct: null, coveragePct: null, earningsPerPageviewPct: null });
    expect(computeDeltas({ rpmCHF: 1 }, null)).toEqual({ rpmPct: null, coveragePct: null, earningsPerPageviewPct: null });
  });

  it('computes rpm/coverage/earnings-per-pageview deltas from two channel rows', () => {
    const control = { rpmCHF: 1.0, coveragePct: 15, earningsPerPageviewCHF: 0.002 };
    const treatment = { rpmCHF: 2.0, coveragePct: 18, earningsPerPageviewCHF: 0.003 };
    const d = computeDeltas(control, treatment);
    expect(d.rpmPct).toBe(100);
    expect(d.coveragePct).toBe(20);
    expect(d.earningsPerPageviewPct).toBe(50);
  });

  it('returns all-null engagement deltas when either side is missing', () => {
    expect(computeEngagementDeltas(null, {})).toEqual({
      avgSessionDurationPct: null,
      engagementRatePct: null,
      bounceRatePct: null,
      pageViewsPerSessionPct: null,
    });
  });
});

describe('adsense-format-ab-report / postHogTrickleHasAnyData()', () => {
  it('is false when every metric/side has n=0 (and when posthog itself is missing)', () => {
    const empty = { control: { LCP: { n: 0 }, INP: { n: 0 }, CLS: { n: 0 } }, treatment: { LCP: { n: 0 }, INP: { n: 0 }, CLS: { n: 0 } } };
    expect(postHogTrickleHasAnyData(empty)).toBe(false);
    expect(postHogTrickleHasAnyData(null)).toBe(false);
  });

  it('is true as soon as ONE metric on ONE side has a sample', () => {
    const trickle = { control: { LCP: { n: 0 }, INP: { n: 0 }, CLS: { n: 0 } }, treatment: { LCP: { n: 1, p75: 1200 }, INP: { n: 0 }, CLS: { n: 0 } } };
    expect(postHogTrickleHasAnyData(trickle)).toBe(true);
  });
});

describe('adsense-format-ab-report / fetchChannelReport()', () => {
  it('picks the control and treatment rows by channel name and computes earnings-per-pageview', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          rows: [
            { cells: [{ value: CONTROL_CHANNEL }, { value: '420' }, { value: '0.48' }, { value: '0.20' }, { value: '15.00%' }, { value: '72' }] },
            { cells: [{ value: TREATMENT_CHANNEL }, { value: '255' }, { value: '1.01' }, { value: '0.26' }, { value: '18.00%' }, { value: '54' }] },
            { cells: [{ value: 'frontaliereticino.ch/cerca-lavoro-zurigo' }, { value: '9999' }, { value: '9.9' }, { value: '9.9' }, { value: '99%' }, { value: '9999' }] },
          ],
        };
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await fetchChannelReport('test-token');

    expect(report.control?.impressions).toBe(420);
    expect(report.control?.earningsPerPageviewCHF).toBe(Number((0.20 / 72).toFixed(4)));
    expect(report.treatment?.rpmCHF).toBe(1.01);
    expect(report.treatment?.coveragePct).toBe(18);

    // Only one request — both channels picked out of the SAME broad
    // dimensioned response, never two separate filtered requests.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain(ADSENSE_ACCOUNT);
    expect(url).toContain('dimensions=URL_CHANNEL_NAME');
  });

  it('returns null (not throw) for a channel absent from the report (e.g. zero impressions this week)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, async json() { return { rows: [] }; } }));
    const report = await fetchChannelReport('test-token');
    expect(report.control).toBeNull();
    expect(report.treatment).toBeNull();
  });

  it('throws on a non-ok AdSense response (caught by main() and surfaced as a warning)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, async text() { return 'forbidden'; } }));
    await expect(fetchChannelReport('bad-token')).rejects.toThrow(/adsense reports:generate 403/);
  });
});

describe('adsense-format-ab-report / fetchCruxRecord()', () => {
  it('reports unavailable with a clear reason when no API key is configured', async () => {
    const out = await fetchCruxRecord('https://frontaliereticino.ch/cerca-lavoro-lucerna/', undefined);
    expect(out).toEqual({ available: false, reason: 'PAGESPEED_API_KEY not set' });
  });

  it('reports unavailable (below traffic threshold) on a 404 — verified live behaviour for both canton pages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, async text() { return 'not found'; } }));
    const out = await fetchCruxRecord('https://frontaliereticino.ch/cerca-lavoro-lucerna/', 'key');
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/below the minimum/);
  });

  it('parses p75 metrics from a successful CrUX record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          record: {
            metrics: {
              largest_contentful_paint: { percentiles: { p75: 1800 } },
              interaction_to_next_paint: { percentiles: { p75: 190 } },
              cumulative_layout_shift: { percentiles: { p75: 0.05 } },
            },
          },
        };
      },
    }));
    const out = await fetchCruxRecord('https://frontaliereticino.ch/cerca-lavoro-basilea/', 'key');
    expect(out).toEqual({ available: true, lcpMs: 1800, inpMs: 190, cls: 0.05 });
  });
});

describe('adsense-format-ab-report / fetchGa4WebVitalsRatings()', () => {
  it('reports unavailable with the raw error when the metric_name/metric_rating custom dimensions are not registered (verified live 2026-08-25: 400 INVALID_ARGUMENT)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      async text() { return 'Field customEvent:metric_name is not a valid dimension.'; },
    }));
    const out = await fetchGa4WebVitalsRatings('test-token');
    expect(out.available).toBe(false);
    expect(out.reason).toContain('400');
  });

  it('reports unavailable (not a thrown error) when the query succeeds but returns zero rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, async json() { return { rows: [] }; } }));
    const out = await fetchGa4WebVitalsRatings('test-token');
    expect(out.available).toBe(false);
  });

  it('reports available with rows when the dimensions ARE registered (future-proofing: this path activates automatically if the owner registers them)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          rows: [
            {
              dimensionValues: [{ value: CANTON_PAGE_PATHS.treatment }, { value: 'LCP' }, { value: 'good' }],
              metricValues: [{ value: '10' }],
            },
          ],
        };
      },
    }));
    const out = await fetchGa4WebVitalsRatings('test-token');
    expect(out.available).toBe(true);
    expect(out.rows).toHaveLength(1);
  });
});

describe('adsense-format-ab-report / buildMarkdown()', () => {
  const baseReport = {
    window: { start: '2026-08-17', end: '2026-08-23' },
    control: { impressions: 1498, rpmCHF: 0.29, earningsCHF: 0.44, coveragePct: 15, pageViews: 2028, earningsPerPageviewCHF: 0.0002 },
    treatment: { impressions: 1536, rpmCHF: 0.28, earningsCHF: 0.43, coveragePct: 18, pageViews: 1608, earningsPerPageviewCHF: 0.0003 },
    deltas: { rpmPct: -3.4, coveragePct: 20, earningsPerPageviewPct: 50 },
    engagement: { control: { sessions: 11, avgSessionDurationSec: 48, engagementRatePct: 45.5, bounceRatePct: 54.5, pageViewsPerSession: 1.6 }, treatment: { sessions: 30, avgSessionDurationSec: 20.6, engagementRatePct: 66.7, bounceRatePct: 33.3, pageViewsPerSession: 4.9 } },
    engagementDeltas: { avgSessionDurationPct: -57.1, engagementRatePct: 46.6, bounceRatePct: -38.9, pageViewsPerSessionPct: 197 },
    cwv: {
      ga4: { available: false, reason: 'GA4 web_vitals query 400: Field customEvent:metric_name is not a valid dimension.' },
      posthog: { control: { LCP: { n: 0, p75: null }, INP: { n: 0, p75: null }, CLS: { n: 0, p75: null } }, treatment: { LCP: { n: 0, p75: null }, INP: { n: 0, p75: null }, CLS: { n: 0, p75: null } } },
      crux: { control: { available: false, reason: 'no CrUX record for this URL (below the minimum real-Chrome-traffic threshold)' }, treatment: { available: false, reason: 'no CrUX record for this URL (below the minimum real-Chrome-traffic threshold)' } },
    },
    warnings: [],
  };

  it('always includes the small-sample disclaimer — this script must never claim statistical significance', () => {
    const md = buildMarkdown(baseReport, { weeksWithData: 0, cumulativePageViews: { control: 0, treatment: 0 } });
    expect(md).toContain('NON è un test di significatività statistica');
    expect(md).toMatch(new RegExp(String(SMALL_SAMPLE_PAGEVIEWS)));
  });

  it('states explicitly (never silently) when CWV is not measurable on any of the three sources', () => {
    const md = buildMarkdown(baseReport, { weeksWithData: 0, cumulativePageViews: { control: 0, treatment: 0 } });
    expect(md).toContain('CWV non misurabile per queste pagine questa settimana');
    // The reason for each of the three sources is surfaced, not just the verdict.
    expect(md).toContain('metric_name');
    expect(md).toContain('below the minimum');
  });

  it('renders the PostHog trickle table (with sample counts) instead of the "not measurable" line once ANY sample exists', () => {
    const report = {
      ...baseReport,
      cwv: {
        ...baseReport.cwv,
        posthog: { control: { LCP: { n: 3, p75: 3435 }, INP: { n: 1, p75: 1952 }, CLS: { n: 1, p75: 0.892 } }, treatment: { LCP: { n: 6, p75: 1122 }, INP: { n: 3, p75: 6372 }, CLS: { n: 1, p75: 0.005 } } },
      },
    };
    const md = buildMarkdown(report, { weeksWithData: 0, cumulativePageViews: { control: 0, treatment: 0 } });
    expect(md).not.toContain('CWV non misurabile per queste pagine questa settimana');
    expect(md).toContain(`finestra ${POSTHOG_CWV_WINDOW_DAYS} giorni`);
    for (const m of CWV_METRICS) expect(md).toContain(m);
    expect(md).toContain('n=3, p75=3435ms');
  });

  it('surfaces the engagement guardrail hypothesis and table', () => {
    const md = buildMarkdown(baseReport, { weeksWithData: 0, cumulativePageViews: { control: 0, treatment: 0 } });
    expect(md).toContain('NON deve peggiorare l\'engagement');
    expect(md).toContain('Bounce rate');
    expect(md).toContain('46.6%'); // engagementRatePct delta
  });

  it('flags missing AdSense data with a warning instead of rendering a fabricated table', () => {
    const md = buildMarkdown({ ...baseReport, control: null, treatment: null }, { weeksWithData: 0, cumulativePageViews: { control: 0, treatment: 0 } });
    expect(md).toContain('Dati AdSense mancanti o incompleti');
  });

  it('renders the Warning section when warnings are present', () => {
    const md = buildMarkdown({ ...baseReport, warnings: ['AdSense fetch failed: boom'] }, { weeksWithData: 0, cumulativePageViews: { control: 0, treatment: 0 } });
    expect(md).toContain('## Warning');
    expect(md).toContain('AdSense fetch failed: boom');
  });
});

describe('adsense-format-ab-report / buildHistoryEntry()', () => {
  it('round-trips through JSON.stringify (what actually gets appended to the .jsonl file)', () => {
    const report = {
      window: { start: '2026-08-17', end: '2026-08-23' },
      control: { impressions: 1498, rpmCHF: 0.29, earningsCHF: 0.44, coveragePct: 15, pageViews: 2028, earningsPerPageviewCHF: 0.0002 },
      treatment: { impressions: 1536, rpmCHF: 0.28, earningsCHF: 0.43, coveragePct: 18, pageViews: 1608, earningsPerPageviewCHF: 0.0003 },
      deltas: { rpmPct: -3.4, coveragePct: 20, earningsPerPageviewPct: 50 },
      engagement: null,
      engagementDeltas: {},
      cwv: null,
    };
    const entry = buildHistoryEntry(report);
    const parsed = JSON.parse(JSON.stringify(entry));
    expect(parsed.control.channel).toBe(CONTROL_CHANNEL);
    expect(parsed.treatment.channel).toBe(TREATMENT_CHANNEL);
    expect(parsed.deltas.rpmPct).toBe(-3.4);
    expect(parsed.engagement).toBeNull();
    expect(parsed.cwv).toBeNull();
  });

  it('carries engagement and CWV along in the SAME history line when available, never gating on them', () => {
    const report = {
      window: { start: '2026-08-17', end: '2026-08-23' },
      control: { impressions: 1, rpmCHF: 1, earningsCHF: 1, coveragePct: 1, pageViews: 1, earningsPerPageviewCHF: 1 },
      treatment: { impressions: 1, rpmCHF: 1, earningsCHF: 1, coveragePct: 1, pageViews: 1, earningsPerPageviewCHF: 1 },
      deltas: {},
      engagement: { control: { sessions: 11 }, treatment: { sessions: 30 } },
      engagementDeltas: { engagementRatePct: 46.6 },
      cwv: {
        ga4: { available: false, reason: 'x' },
        posthog: { control: {}, treatment: {} },
        crux: { control: { available: false }, treatment: { available: false } },
      },
    };
    const entry: any = buildHistoryEntry(report);
    expect(entry.engagement.deltas.engagementRatePct).toBe(46.6);
    expect(entry.cwv.ga4Available).toBe(false);
    expect(entry.cwv.posthogWindowDays).toBe(POSTHOG_CWV_WINDOW_DAYS);
  });
});
