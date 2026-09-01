#!/usr/bin/env node
/**
 * AdSense in-feed format A/B reports
 *
 * Weekly companion to the canton in-feed-ad A/B test wired in
 * services/adsenseSlots.ts (INFEED_AD_AB_TEST_SUPPRESSED_CANTONS): on the
 * job-search listings, the treatment pages have the manual In-page in-feed
 * slot (JOBLIST_INFEED_DESKTOP/MOBILE) removed while Auto Ads remain active.
 * Two independent comparisons are monitored:
 *   - Basilea control vs Lucerna treatment (started 2026-08-25);
 *   - Svizzera control vs Ticino treatment (owner-requested 2026-09-01).
 * See docs/ADSENSE-INFEED-AB-TEST.md for scope, URL-level attribution and
 * interpretation rules.
 *
 * Three independent signals, all scoped to the selected pair's two exact
 * IT-locale page paths (the paths the router resolves for the job listings; see
 * `services/router.ts` `parseJobBoardSlug` / `resolveCantonGroup` and
 * `build-plugins/jobsSeoPagesPlugin.ts` `buildCantonAwareSection`, the same
 * spots read while wiring the A/B test itself):
 *
 * 1. AdSense (the test's primary metric — RPM/coverage/earnings-per-pageview,
 *    via URL channels for the legacy low-volume pair and exact PAGE_URL for
 *    the high-volume Svizzera/Ticino pair, so sub-URLs are not aggregated).
 * 2. GA4 engagement guardrail (`averageSessionDuration`, `engagementRate`,
 *    `bounceRate`, `screenPageViewsPerSession`, property 524485296) — the
 *    hypothesis under test is that removing the in-page ad must NOT make
 *    the treatment's engagement worse than its control; a higher RPM with a
 *    real engagement drop is a losing trade, not a win.
 * 3. Core Web Vitals (LCP/INP/CLS) guardrail — best-effort across THREE
 *    sources, tried in this order and reported honestly when none works:
 *      a. GA4 custom events (`web_vitals`, dimensions `customEvent:metric_name`
 *         / `customEvent:metric_rating`) — VERIFIED LIVE 2026-08-25: returns
 *         `400 INVALID_ARGUMENT` on this property. `services/webVitals.ts`
 *         sends the event, but the event-scoped custom dimensions needed to
 *         QUERY it via the Data API were never registered (checked via
 *         `analyticsadmin.googleapis.com/.../customDimensions` — 37
 *         registered, none named `metric_name`/`metric_rating`/`metric_value`).
 *         This script does NOT auto-register them (an app-instrumentation
 *         change is out of scope for a reporting script, and a freshly
 *         registered dimension needs a processing window before it backfills
 *         anyway) — it just detects the 400 and falls through.
 *      b. PostHog `$web_vitals` events (project from POSTHOG_PROJECT_ID),
 *         filtered by exact `$pathname`. This section uses a
 *         POSTHOG_CWV_WINDOW_DAYS rolling window (30d, not 7d) and reports the
 *         sample count `n` next to every p75, so legacy sparse pages and the
 *         higher-volume pair remain distinguishable.
 *      c. CrUX API (`chromeuxreport.googleapis.com`, per-URL PHONE record).
 *         A per-URL record may be unavailable below CrUX's traffic threshold;
 *         availability is reported independently for each selected page.
 *    When none of the three yields data, the report says so explicitly
 *    ("CWV non misurabile") instead of omitting the section or inventing a
 *    number.
 *
 * A weekly delta is descriptive, not a significance test. The script reports
 * raw numbers, an explicit sample disclaimer and a per-experiment cumulative
 * history; it never combines the two experiments or treats a category channel
 * as if it were an exact hub URL.
 *
 * Auth (env, loaded via scripts/load-rc-env.mjs, same as revenue-monitor.mjs
 * and rpm-canary.yml):
 *   ADSENSE_REFRESH_TOKEN                                   (AdSense)
 *   ADSENSE_CLIENT_ID / ADSENSE_CLIENT_SECRET (optional; defaults to GSC_*)
 *   GOOGLE_APPLICATION_CREDENTIALS (Firebase SA, analytics.readonly grant)
 *                                                            (GA4)
 *   POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID (optional) (PostHog CWV)
 *   PAGESPEED_API_KEY (optional)                             (CrUX)
 *
 * Usage:
 *   node scripts/adsense-format-ab-report.mjs             # human table
 *   node scripts/adsense-format-ab-report.mjs --experiment svizzera-ticino
 *   node scripts/adsense-format-ab-report.mjs --json       # JSON payload
 *   node scripts/adsense-format-ab-report.mjs --markdown   # GitHub-flavored markdown
 *   node scripts/adsense-format-ab-report.mjs --save       # write reports/adsense-format-ab-<experiment>-YYYY-MM-DD.{md,json}
 *                                                           # + append data/adsense-format-ab-history.jsonl
 *
 * Exits 0 always — this is a report, not a gate (mirrors revenue-monitor.mjs
 * "monitor, not gate"). A fetch failure on any of the three signals is
 * recorded as a warning IN the report (so the weekly GitHub issue update
 * surfaces it) rather than failing the workflow; the history line's AdSense
 * fields are only populated when real data for both sides was fetched, so
 * a bad week never pollutes the trend file with fabricated zeros — the
 * engagement/CWV fields are best-effort and recorded as `null` when missing.
 */

import { writeFileSync, mkdirSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AD_CLIENT } from '../services/adsenseSlots.ts';
import { getAdSenseToken, last7Days } from './revenue-monitor.mjs';
import { getServiceAccountToken, fetchRetry, DEFAULT_GA4_PROPERTY_ID } from './lib/ga4-service-account.mjs';
import { runHogQL } from './lib/posthog-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Compact append-only history — mirrors data/revenue-monitor-history.jsonl
// (see buildHistoryEntry in revenue-monitor.mjs for the exact same pattern):
// one JSON object per line, committed by the workflow so the trend survives
// across weekly Actions runs (full reports/ output is gitignored, artifact
// only).
const HISTORY_FILE = resolve(__dirname, '..', 'data', 'adsense-format-ab-history.jsonl');

// AdSense account resource name. Derived from AD_CLIENT ('ca-pub-<id>')
// instead of a second hardcoded literal — the account and the ad client are
// the same publisher id under two different Google API naming conventions.
export const ADSENSE_ACCOUNT = `accounts/${AD_CLIENT.replace(/^ca-/, '')}`;

const SITE_ORIGIN = 'https://frontaliereticino.ch';

/**
 * One configuration per independent experiment. The legacy comparison keeps
 * URL_CHANNEL_NAME so its existing history remains comparable. The new
 * high-volume comparison deliberately uses PAGE_URL with canonical full URLs:
 * the corresponding URL-channel patterns also match sub-URLs and therefore
 * cannot measure the two hub pages alone.
 */
export const EXPERIMENTS = Object.freeze([
  Object.freeze({
    id: 'basilea-lucerna',
    firstFullTreatmentDate: '2026-08-26',
    adsenseDimension: 'URL_CHANNEL_NAME',
    control: Object.freeze({
      label: 'Basilea',
      adsenseValue: 'frontaliereticino.ch/cerca-lavoro-basilea',
      path: '/cerca-lavoro-basilea/',
    }),
    treatment: Object.freeze({
      label: 'Lucerna',
      adsenseValue: 'frontaliereticino.ch/cerca-lavoro-lucerna',
      path: '/cerca-lavoro-lucerna/',
    }),
  }),
  Object.freeze({
    id: 'svizzera-ticino',
    // Conservative clean-window boundary: the deployment may complete after
    // midnight on 2026-09-02, so the first unquestionably full day is Sep 3.
    firstFullTreatmentDate: '2026-09-03',
    adsenseDimension: 'PAGE_URL',
    control: Object.freeze({
      label: 'Svizzera',
      adsenseValue: `${SITE_ORIGIN}/cerca-lavoro-svizzera/`,
      path: '/cerca-lavoro-svizzera/',
    }),
    treatment: Object.freeze({
      label: 'Ticino',
      adsenseValue: `${SITE_ORIGIN}/cerca-lavoro-ticino/`,
      path: '/cerca-lavoro-ticino/',
    }),
  }),
]);

export const DEFAULT_EXPERIMENT = EXPERIMENTS[0];
export const CONTROL_CHANNEL = DEFAULT_EXPERIMENT.control.adsenseValue;
export const TREATMENT_CHANNEL = DEFAULT_EXPERIMENT.treatment.adsenseValue;
export const CANTON_PAGE_PATHS = Object.freeze({
  control: DEFAULT_EXPERIMENT.control.path,
  treatment: DEFAULT_EXPERIMENT.treatment.path,
});

export function findExperiment(id) {
  return EXPERIMENTS.find((experiment) => experiment.id === id) || null;
}

export function classifyWindow(experiment, window) {
  if (window.end < experiment.firstFullTreatmentDate) return 'pre-treatment';
  if (window.start < experiment.firstFullTreatmentDate) return 'mixed';
  return 'post-treatment';
}

// Metrics pulled per dimension value. Order here is also the `cells[]` order
// AdSense returns — cells[0] is always the selected dimension and
// dimension value, cells[1..] follow this list positionally (same contract
// revenue-monitor.mjs's fetchAdSenseReport relies on for its own dimensioned
// queries).
const METRICS = ['IMPRESSIONS', 'IMPRESSIONS_RPM', 'ESTIMATED_EARNINGS', 'AD_REQUESTS_COVERAGE', 'PAGE_VIEWS'];

// PAGE_URL may expose substantially more rows than the ~26 configured URL
// channels. Keep enough headroom that an exact hub cannot disappear merely
// because the account gains more monetized pages.
const REPORT_ROW_LIMIT = 10000;

/**
 * Parse an AdSense report cell value into a plain number. Handles both a
 * bare numeric string ("18.34") and one AdSense formats with a trailing
 * percent sign ("18.34%") — percentage-type metrics (AD_REQUESTS_COVERAGE)
 * have been observed to arrive either way depending on API surface/version,
 * so this is deliberately lenient rather than asserting one shape.
 */
export function parseCellNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

export function parseCoveragePct(v) {
  const parsed = parseCellNumber(v);
  if (parsed === null) return null;
  if (String(v).includes('%')) return parsed;
  return parsed >= 0 && parsed <= 1 ? Number((parsed * 100).toFixed(2)) : parsed;
}

/**
 * Fetch the selected AdSense dimension for the last 7 full days and pick the
 * control + treatment rows client-side. PAGE_URL experiments therefore match
 * full canonical hub URLs, while the legacy experiment retains its historical
 * URL_CHANNEL_NAME series.
 */
export async function fetchChannelReport(token, experiment = DEFAULT_EXPERIMENT) {
  const { start, end } = last7Days();

  const params = new URLSearchParams();
  params.append('dateRange', 'CUSTOM');
  params.append('startDate.year', start.slice(0, 4));
  params.append('startDate.month', String(Number(start.slice(5, 7))));
  params.append('startDate.day', String(Number(start.slice(8, 10))));
  params.append('endDate.year', end.slice(0, 4));
  params.append('endDate.month', String(Number(end.slice(5, 7))));
  params.append('endDate.day', String(Number(end.slice(8, 10))));
  for (const m of METRICS) params.append('metrics', m);
  params.append('dimensions', experiment.adsenseDimension);
  params.append('limit', String(REPORT_ROW_LIMIT));

  const url = `https://adsense.googleapis.com/v2/${ADSENSE_ACCOUNT}/reports:generate?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`adsense reports:generate ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = data.rows || [];

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\/$/, '');
  const pickValue = (adsenseValue) => {
    const row = rows.find((r) => norm(r.cells?.[0]?.value) === norm(adsenseValue));
    if (!row) return null;
    const cells = row.cells || [];
    // The *CHF property names predate this change and are kept for JSONL
    // history compatibility. `currencyCode` from the API header is the
    // authoritative unit shown in every rendered report.
    const impressions = parseCellNumber(cells[1]?.value);
    const rpmCHF = parseCellNumber(cells[2]?.value);
    const earningsCHF = parseCellNumber(cells[3]?.value);
    const coverageRaw = cells[4]?.value ?? null;
    const coveragePct = parseCoveragePct(cells[4]?.value);
    const pageViews = parseCellNumber(cells[5]?.value);
    const earningsPerPageviewCHF =
      earningsCHF !== null && pageViews ? Number((earningsCHF / pageViews).toFixed(4)) : null;
    return { channel: adsenseValue, impressions, rpmCHF, earningsCHF, coverageRaw, coveragePct, pageViews, earningsPerPageviewCHF };
  };

  const currencyCode = data.headers?.find((header) => header.currencyCode)?.currencyCode || 'EUR';

  return {
    window: { start, end },
    currencyCode,
    control: pickValue(experiment.control.adsenseValue),
    treatment: pickValue(experiment.treatment.adsenseValue),
    rowCount: rows.length,
  };
}

/** Percent delta of `treatment` vs `control` — null when either side is missing/zero. */
export function pctDelta(treatment, control) {
  if (treatment === null || treatment === undefined || control === null || control === undefined || control === 0) {
    return null;
  }
  return Number((((treatment - control) / control) * 100).toFixed(1));
}

export function computeDeltas(control, treatment) {
  if (!control || !treatment) return { rpmPct: null, coveragePct: null, earningsPerPageviewPct: null };
  return {
    rpmPct: pctDelta(treatment.rpmCHF, control.rpmCHF),
    coveragePct: pctDelta(treatment.coveragePct, control.coveragePct),
    earningsPerPageviewPct: pctDelta(treatment.earningsPerPageviewCHF, control.earningsPerPageviewCHF),
  };
}

// ── GA4 engagement guardrail ──────────────────────────────────────────────
const GA4_SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

/**
 * Session-level engagement for the selected two pages, same 7-day window as
 * AdSense. Metric order below is also the `metricValues[]` positional order
 * GA4 returns (dimensions first, metrics in request order) — same contract
 * `fetchChannelReport` above relies on for AdSense.
 */
export async function fetchGa4Engagement(token, experiment = DEFAULT_EXPERIMENT) {
  const { start, end } = last7Days();
  const url = `https://analyticsdata.googleapis.com/v1beta/${DEFAULT_GA4_PROPERTY_ID}:runReport`;
  const body = {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [
      { name: 'sessions' },
      { name: 'screenPageViews' },
      { name: 'averageSessionDuration' },
      { name: 'engagementRate' },
      { name: 'bounceRate' },
      { name: 'screenPageViewsPerSession' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'pagePath',
        inListFilter: { values: [experiment.control.path, experiment.treatment.path] },
      },
    },
  };
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ga4 engagement ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const rows = data.rows || [];
  const pick = (path) => {
    const row = rows.find((r) => r.dimensionValues?.[0]?.value === path);
    if (!row) return null;
    const v = row.metricValues || [];
    const num = (i) => (v[i]?.value != null ? Number(v[i].value) : null);
    return {
      sessions: num(0),
      pageViews: num(1),
      avgSessionDurationSec: num(2) !== null ? Number(num(2).toFixed(1)) : null,
      engagementRatePct: num(3) !== null ? Number((num(3) * 100).toFixed(1)) : null,
      bounceRatePct: num(4) !== null ? Number((num(4) * 100).toFixed(1)) : null,
      pageViewsPerSession: num(5) !== null ? Number(num(5).toFixed(2)) : null,
    };
  };
  return { control: pick(experiment.control.path), treatment: pick(experiment.treatment.path) };
}

export function computeEngagementDeltas(control, treatment) {
  if (!control || !treatment) {
    return { avgSessionDurationPct: null, engagementRatePct: null, bounceRatePct: null, pageViewsPerSessionPct: null };
  }
  return {
    avgSessionDurationPct: pctDelta(treatment.avgSessionDurationSec, control.avgSessionDurationSec),
    engagementRatePct: pctDelta(treatment.engagementRatePct, control.engagementRatePct),
    bounceRatePct: pctDelta(treatment.bounceRatePct, control.bounceRatePct),
    pageViewsPerSessionPct: pctDelta(treatment.pageViewsPerSession, control.pageViewsPerSession),
  };
}

// ── Core Web Vitals guardrail (3 sources, best-effort) ────────────────────
export const CWV_METRICS = ['LCP', 'INP', 'CLS'];
// PostHog ingest has been at a trickle (~6-30 events/day site-wide) since
// 2026-07-23 (was ~100k/day) — a strict 7-day window on two low-traffic pages
// would almost always return n=0. 30 days is a deliberate, documented
// deviation from the rest of this report's 7-day cadence, made ONLY for this
// fallback source, and always labeled as such in the output.
export const POSTHOG_CWV_WINDOW_DAYS = 30;
// Below this sample count, a "p75" is really just showing you 1-4 raw
// samples — flagged inline rather than presented as a distribution.
export const POSTHOG_CWV_MIN_N = 5;

/**
 * Attempt GA4's own `web_vitals` custom event (services/webVitals.ts sends
 * it). Requires the event-scoped custom dimensions `metric_name` /
 * `metric_rating` to be registered on the property — verified 2026-08-25 that
 * they are NOT (see module docblock). Returns `{ available: false, reason }`
 * on ANY failure (never throws) so the caller can fall through to PostHog.
 */
export async function fetchGa4WebVitalsRatings(token, experiment = DEFAULT_EXPERIMENT) {
  const { start, end } = last7Days();
  const url = `https://analyticsdata.googleapis.com/v1beta/${DEFAULT_GA4_PROPERTY_ID}:runReport`;
  const body = {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'pagePath' }, { name: 'customEvent:metric_name' }, { name: 'customEvent:metric_rating' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'web_vitals' } } },
          {
            filter: {
              fieldName: 'pagePath',
              inListFilter: { values: [experiment.control.path, experiment.treatment.path] },
            },
          },
        ],
      },
    },
  };
  try {
    const res = await fetchRetry(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      return { available: false, reason: `GA4 web_vitals query ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    const rows = data.rows || [];
    if (rows.length === 0) return { available: false, reason: 'GA4 web_vitals query succeeded but returned zero rows for this window/pages' };
    return { available: true, rows };
  } catch (e) {
    return { available: false, reason: `GA4 web_vitals query threw: ${e.message}` };
  }
}

/**
 * PostHog `$web_vitals` fallback — one HogQL query per (canton, metric),
 * count + p75 over POSTHOG_CWV_WINDOW_DAYS. Never throws; a per-query failure
 * (e.g. missing credentials) is recorded as `{ n: 0, p75: null, error }` for
 * that cell only, so one bad query doesn't blank the whole table.
 */
export async function fetchPostHogCwvTrickle(experiment = DEFAULT_EXPERIMENT) {
  const result = { control: {}, treatment: {} };
  for (const side of ['control', 'treatment']) {
    const path = experiment[side].path;
    for (const metric of CWV_METRICS) {
      const decimals = metric === 'CLS' ? 3 : 0;
      const q = `
        SELECT count() AS n,
               quantile(0.75)(toFloat(properties.\$web_vitals_${metric}_value)) AS p75
        FROM events
        WHERE event = '\$web_vitals'
          AND properties.\$web_vitals_${metric}_value IS NOT NULL
          AND properties.\$pathname = '${path}'
          AND timestamp > now() - INTERVAL ${POSTHOG_CWV_WINDOW_DAYS} DAY
      `.trim();
      try {
        const r = await runHogQL(q);
        const row = r.results?.[0] || [0, null];
        const n = Number(row[0]) || 0;
        const p75 = row[1] != null ? Number(Number(row[1]).toFixed(decimals)) : null;
        result[side][metric] = { n, p75 };
      } catch (e) {
        result[side][metric] = { n: 0, p75: null, error: e.message.slice(0, 150) };
      }
    }
  }
  return result;
}

export function postHogTrickleHasAnyData(posthog) {
  if (!posthog) return false;
  return ['control', 'treatment'].some((side) => CWV_METRICS.some((m) => (posthog[side]?.[m]?.n || 0) > 0));
}

/** CrUX per-URL PHONE record, kept as the last-resort source. */
export async function fetchCruxRecord(url, apiKey) {
  if (!apiKey) return { available: false, reason: 'PAGESPEED_API_KEY not set' };
  try {
    const res = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        formFactor: 'PHONE',
        metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'],
      }),
    });
    if (res.status === 404) return { available: false, reason: 'no CrUX record for this URL (below the minimum real-Chrome-traffic threshold)' };
    if (!res.ok) return { available: false, reason: `crux ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const p75 = (key) => data.record?.metrics?.[key]?.percentiles?.p75 ?? null;
    return {
      available: true,
      lcpMs: p75('largest_contentful_paint'),
      inpMs: p75('interaction_to_next_paint'),
      cls: p75('cumulative_layout_shift'),
    };
  } catch (e) {
    return { available: false, reason: `crux fetch threw: ${e.message}` };
  }
}

/**
 * Sample-size disclaimer. NOT a statistical significance test — deliberately
 * so, per the task/owner's own framing: at ~1500-2000 pageviews/month for
 * either page, a single week is a few hundred pageviews per side. This is a
 * plain descriptive heuristic (below SMALL_SAMPLE_PAGEVIEWS this week's
 * numbers get an explicit "too small to read anything into yet" flag), never
 * a p-value.
 */
export const SMALL_SAMPLE_PAGEVIEWS = 500;

export function buildMarkdown(report, history) {
  const { window, control, treatment, deltas, engagement, engagementDeltas, cwv, warnings } = report;
  const experiment = report.experiment || DEFAULT_EXPERIMENT;
  const controlLabel = experiment.control.label;
  const treatmentLabel = experiment.treatment.label;
  const currencyCode = report.currencyCode || 'EUR';
  const windowPhase = report.windowPhase || classifyWindow(experiment, window);
  const lines = [];
  lines.push(`# AdSense format A/B: ${controlLabel} (controllo) vs ${treatmentLabel} (trattamento)`);
  lines.push('');
  lines.push(`**Finestra:** ${window.start} → ${window.end} (ultimi 7 giorni pieni)`);
  lines.push('');
  if (windowPhase !== 'post-treatment') {
    const phaseLabel = windowPhase === 'pre-treatment' ? 'interamente precedente' : 'mista pre/post trattamento';
    lines.push(`⚠️ **Finestra ${phaseLabel}.** Il primo giorno completo dichiarato per il trattamento è ${experiment.firstFullTreatmentDate}; questa run è una baseline e non entra nel cumulativo post-trattamento.`);
    lines.push('');
  }
  lines.push('## AdSense — metrica primaria del test');
  lines.push('');
  if (experiment.adsenseDimension === 'URL_CHANNEL_NAME') {
    lines.push('> Nota di attribuzione: questo esperimento conserva un pattern di canale URL per continuità storica; il valore può includere sotto-URL e non rappresenta necessariamente il solo hub.');
    lines.push('');
  } else {
    lines.push('> Attribuzione esatta: `PAGE_URL` confronta soltanto i due URL canonici completi; i sotto-URL sono esclusi.');
    lines.push('');
  }

  if (!control || !treatment) {
    lines.push('⚠️ **Dati AdSense mancanti o incompleti per questa finestra** — vedi warning sotto. Nessuna riga aggiunta allo storico.');
    lines.push('');
  } else {
    lines.push(`| Metrica | ${controlLabel} (controllo) | ${treatmentLabel} (trattamento) | Δ% (trattamento vs controllo) |`);
    lines.push('|---|---:|---:|---:|');
    lines.push(`| Impressioni | ${control.impressions ?? '—'} | ${treatment.impressions ?? '—'} | ${pctDelta(treatment.impressions, control.impressions) ?? '—'}% |`);
    lines.push(`| Page view | ${control.pageViews ?? '—'} | ${treatment.pageViews ?? '—'} | ${pctDelta(treatment.pageViews, control.pageViews) ?? '—'}% |`);
    lines.push(`| Earnings (${currencyCode}) | ${control.earningsCHF ?? '—'} | ${treatment.earningsCHF ?? '—'} | ${pctDelta(treatment.earningsCHF, control.earningsCHF) ?? '—'}% |`);
    lines.push(`| RPM (${currencyCode}/1000 impr.) | ${control.rpmCHF ?? '—'} | ${treatment.rpmCHF ?? '—'} | ${deltas.rpmPct ?? '—'}% |`);
    lines.push(`| Coverage (%) | ${control.coveragePct ?? '—'} | ${treatment.coveragePct ?? '—'} | ${deltas.coveragePct ?? '—'}% |`);
    lines.push(`| **Earnings / pageview (${currencyCode})** | **${control.earningsPerPageviewCHF ?? '—'}** | **${treatment.earningsPerPageviewCHF ?? '—'}** | **${deltas.earningsPerPageviewPct ?? '—'}%** |`);
    lines.push('');
    lines.push('Earnings/pageview è la metrica più onesta per confrontare due format diversi (in-feed manuale vs solo Auto Ads) quando controllo e trattamento hanno pageview leggermente diversi — normalizza per il traffico invece di dividere per "impressioni", che dipende esso stesso dal format in test.');
    lines.push('');

    const smallControl = control.pageViews !== null && control.pageViews < SMALL_SAMPLE_PAGEVIEWS;
    const smallTreatment = treatment.pageViews !== null && treatment.pageViews < SMALL_SAMPLE_PAGEVIEWS;
    lines.push('### Dimensione del campione (AdSense)');
    lines.push('');
    lines.push(
      `⚠️ **Questo NON è un test di significatività statistica.** Questa settimana: ${controlLabel} ${control.pageViews ?? '—'} pageview, ${treatmentLabel} ${treatment.pageViews ?? '—'} pageview. I numeri sopra sono descrittivi, non una prova — servono a costruire uno storico settimana su settimana, non a decidere dopo una sola run. Lo stesso vale per le sezioni Engagement e Core Web Vitals sotto.`,
    );
    if (smallControl || smallTreatment) {
      lines.push(`Campione sotto la soglia euristica di ${SMALL_SAMPLE_PAGEVIEWS} pageview/settimana per almeno un lato: il delta di questa settimana va letto con ancora più cautela del solito.`);
    }
    if (history && history.weeksWithData > 0) {
      lines.push('');
      lines.push(`Storico cumulativo (${history.weeksWithData} settimane con dati, incl. questa): ${controlLabel} ${history.cumulativePageViews.control} pageview totali, ${treatmentLabel} ${history.cumulativePageViews.treatment} pageview totali. Anche il cumulativo resta un confronto descrittivo — non sostituisce un test statistico formale.`);
    }
    lines.push('');
  }

  // ── Engagement guardrail ──────────────────────────────────────────────
  lines.push('## Engagement (GA4) — guardrail');
  lines.push('');
  lines.push(`Ipotesi da verificare: rimuovere l'annuncio in-page a ${treatmentLabel} NON deve peggiorare l'engagement rispetto a ${controlLabel} — un RPM più alto pagato con engagement peggiore non è una vittoria.`);
  lines.push('');
  if (engagement && engagement.control && engagement.treatment) {
    const e = engagement;
    lines.push(`| Metrica | ${controlLabel} (controllo) | ${treatmentLabel} (trattamento) | Δ% (trattamento vs controllo) |`);
    lines.push('|---|---:|---:|---:|');
    lines.push(`| Sessioni (7g) | ${e.control.sessions ?? '—'} | ${e.treatment.sessions ?? '—'} | ${pctDelta(e.treatment.sessions, e.control.sessions) ?? '—'}% |`);
    lines.push(`| Durata media sessione (s) | ${e.control.avgSessionDurationSec ?? '—'} | ${e.treatment.avgSessionDurationSec ?? '—'} | ${engagementDeltas.avgSessionDurationPct ?? '—'}% |`);
    lines.push(`| Engagement rate (%) | ${e.control.engagementRatePct ?? '—'} | ${e.treatment.engagementRatePct ?? '—'} | ${engagementDeltas.engagementRatePct ?? '—'}% |`);
    lines.push(`| Bounce rate (%) | ${e.control.bounceRatePct ?? '—'} | ${e.treatment.bounceRatePct ?? '—'} | ${engagementDeltas.bounceRatePct ?? '—'}% |`);
    lines.push(`| Pageview / sessione | ${e.control.pageViewsPerSession ?? '—'} | ${e.treatment.pageViewsPerSession ?? '—'} | ${engagementDeltas.pageViewsPerSessionPct ?? '—'}% |`);
    lines.push('');
    lines.push(`⚠️ Anche i dati GA4 sono descrittivi: volume e qualità del traffico possono differire tra le due pagine, quindi il delta va letto insieme allo storico di ciascun lato.`);
  } else {
    lines.push('⚠️ **Dati di engagement GA4 non disponibili questa settimana** — vedi warning sotto.');
  }
  lines.push('');

  // ── Core Web Vitals guardrail ─────────────────────────────────────────
  lines.push('## Core Web Vitals — guardrail (LCP / INP / CLS)');
  lines.push('');
  if (cwv) {
    lines.push(`Fonti tentate in ordine — GA4 custom events → PostHog (finestra ${POSTHOG_CWV_WINDOW_DAYS}gg, non 7gg: vedi motivo sotto) → CrUX per-URL:`);
    lines.push(`- GA4: ${cwv.ga4.available ? '✅ disponibile' : `❌ non disponibile — ${cwv.ga4.reason}`}`);
    const phNote = (side) =>
      CWV_METRICS.map((m) => `${m} n=${cwv.posthog?.[side]?.[m]?.n ?? 0}`).join(', ');
    lines.push(`- PostHog: ${controlLabel} (${phNote('control')}) · ${treatmentLabel} (${phNote('treatment')})`);
    lines.push(`- CrUX: ${controlLabel} ${cwv.crux?.control?.available ? '✅' : `❌ ${cwv.crux?.control?.reason ?? 'n/a'}`} · ${treatmentLabel} ${cwv.crux?.treatment?.available ? '✅' : `❌ ${cwv.crux?.treatment?.reason ?? 'n/a'}`}`);
    lines.push('');

    if (cwv.ga4.available) {
      lines.push('### GA4 (rating buckets: good / needs-improvement / poor)');
      lines.push('');
      lines.push('| Pagina | Metrica | good | needs-improvement | poor | n totale |');
      lines.push('|---|---|---:|---:|---:|---:|');
      const buckets = new Map(); // `${path}|${metric}` -> {good,ni,poor,total}
      for (const row of cwv.ga4.rows) {
        const path = row.dimensionValues?.[0]?.value;
        const metric = row.dimensionValues?.[1]?.value;
        const rating = row.dimensionValues?.[2]?.value;
        const count = Number(row.metricValues?.[0]?.value || 0);
        const key = `${path}|${metric}`;
        const b = buckets.get(key) || { good: 0, ni: 0, poor: 0, total: 0 };
        if (rating === 'good') b.good += count;
        else if (rating === 'needs-improvement') b.ni += count;
        else if (rating === 'poor') b.poor += count;
        b.total += count;
        buckets.set(key, b);
      }
      const pageLabel = (p) => (p === experiment.control.path ? controlLabel : p === experiment.treatment.path ? treatmentLabel : p);
      for (const [key, b] of buckets) {
        const [path, metric] = key.split('|');
        lines.push(`| ${pageLabel(path)} | ${metric} | ${b.good} | ${b.ni} | ${b.poor} | ${b.total} |`);
      }
      lines.push('');
    } else if (postHogTrickleHasAnyData(cwv.posthog)) {
      lines.push(`### PostHog (finestra di fallback ${POSTHOG_CWV_WINDOW_DAYS} giorni — non 7)`);
      lines.push('');
      lines.push(`| Metrica | ${controlLabel} n / p75 | ${treatmentLabel} n / p75 |`);
      lines.push('|---|---:|---:|');
      for (const m of CWV_METRICS) {
        const c = cwv.posthog.control[m];
        const t = cwv.posthog.treatment[m];
        const unit = m === 'CLS' ? '' : 'ms';
        lines.push(`| ${m} | n=${c?.n ?? 0}, p75=${c?.p75 ?? '—'}${unit} | n=${t?.n ?? 0}, p75=${t?.p75 ?? '—'}${unit} |`);
      }
      lines.push('');
      const hasSparsePostHogCell = ['control', 'treatment'].some((side) =>
        CWV_METRICS.some((metric) => (cwv.posthog?.[side]?.[metric]?.n || 0) < POSTHOG_CWV_MIN_N),
      );
      lines.push(
        hasSparsePostHogCell
          ? `⚠️ Almeno una cella ha meno di ${POSTHOG_CWV_MIN_N} campioni: il p75 è soltanto un'indicazione grezza.`
          : 'I conteggi sono mostrati accanto a ogni p75; anche con campione sufficiente per un guardrail descrittivo, questa sezione non prova causalità o significatività.',
      );
    } else if (cwv.crux?.control?.available && cwv.crux?.treatment?.available) {
      lines.push('### CrUX (p75, PHONE)');
      lines.push('');
      lines.push(`| Metrica | ${controlLabel} | ${treatmentLabel} |`);
      lines.push('|---|---:|---:|');
      lines.push(`| LCP (ms) | ${cwv.crux.control.lcpMs ?? '—'} | ${cwv.crux.treatment.lcpMs ?? '—'} |`);
      lines.push(`| INP (ms) | ${cwv.crux.control.inpMs ?? '—'} | ${cwv.crux.treatment.inpMs ?? '—'} |`);
      lines.push(`| CLS | ${cwv.crux.control.cls ?? '—'} | ${cwv.crux.treatment.cls ?? '—'} |`);
      lines.push('');
    } else {
      lines.push('**CWV non misurabile per queste pagine questa settimana: nessuna fonte con dati sufficienti** (vedi le tre righe sopra per il motivo di ciascuna). Non è stato inventato alcun numero.');
      lines.push('');
    }
  } else {
    lines.push('**CWV non misurabile — la fase di raccolta dati non è stata eseguita questa settimana** (vedi warning sotto).');
    lines.push('');
  }

  if (warnings && warnings.length) {
    lines.push('## Warning');
    for (const w of warnings) lines.push(`- ⚠️ ${w}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`AdSense \`${experiment.adsenseDimension}\`: \`${experiment.control.adsenseValue}\` (controllo) / \`${experiment.treatment.adsenseValue}\` (trattamento). Pagine GA4/PostHog/CrUX: \`${experiment.control.path}\` / \`${experiment.treatment.path}\`. Storico separato per \`${experiment.id}\` in \`data/adsense-format-ab-history.jsonl\`. Script: \`scripts/adsense-format-ab-report.mjs\`.`);

  return lines.join('\n');
}

export function buildHistoryEntry(report) {
  const { window, control, treatment, deltas, engagement, engagementDeltas, cwv } = report;
  const experiment = report.experiment || DEFAULT_EXPERIMENT;
  return {
    date: new Date().toISOString().slice(0, 10),
    experimentId: experiment.id,
    windowPhase: report.windowPhase || classifyWindow(experiment, window),
    adsenseDimension: experiment.adsenseDimension,
    currencyCode: report.currencyCode || 'EUR',
    window,
    control: {
      label: experiment.control.label,
      path: experiment.control.path,
      channel: experiment.control.adsenseValue,
      impressions: control.impressions,
      rpmCHF: control.rpmCHF,
      earningsCHF: control.earningsCHF,
      coveragePct: control.coveragePct,
      pageViews: control.pageViews,
      earningsPerPageviewCHF: control.earningsPerPageviewCHF,
    },
    treatment: {
      label: experiment.treatment.label,
      path: experiment.treatment.path,
      channel: experiment.treatment.adsenseValue,
      impressions: treatment.impressions,
      rpmCHF: treatment.rpmCHF,
      earningsCHF: treatment.earningsCHF,
      coveragePct: treatment.coveragePct,
      pageViews: treatment.pageViews,
      earningsPerPageviewCHF: treatment.earningsPerPageviewCHF,
    },
    deltas,
    // Best-effort — null when a source was unavailable that week. Kept in
    // the same history line (not a separate file) so a reader sees all three
    // signals for a given week together.
    engagement: engagement && engagement.control && engagement.treatment
      ? { control: engagement.control, treatment: engagement.treatment, deltas: engagementDeltas }
      : null,
    cwv: cwv
      ? {
          ga4Available: cwv.ga4.available,
          posthogWindowDays: POSTHOG_CWV_WINDOW_DAYS,
          posthog: cwv.posthog,
          cruxAvailable: { control: cwv.crux?.control?.available ?? false, treatment: cwv.crux?.treatment?.available ?? false },
        }
      : null,
  };
}

/** Reads one experiment's history only; legacy untagged lines belong to the original pair. */
function readHistorySummary(experiment = DEFAULT_EXPERIMENT) {
  if (!existsSync(HISTORY_FILE)) return { weeksWithData: 0, cumulativePageViews: { control: 0, treatment: 0 } };
  const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
  let weeksWithData = 0;
  let controlPv = 0;
  let treatmentPv = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const entryExperimentId = entry?.experimentId || DEFAULT_EXPERIMENT.id;
      if (entryExperimentId !== experiment.id) continue;
      if (entry?.control?.pageViews != null && entry?.treatment?.pageViews != null) {
        weeksWithData++;
        controlPv += Number(entry.control.pageViews) || 0;
        treatmentPv += Number(entry.treatment.pageViews) || 0;
      }
    } catch {
      // Skip a malformed line rather than aborting the whole read.
    }
  }
  return { weeksWithData, cumulativePageViews: { control: controlPv, treatment: treatmentPv } };
}

function log(emoji, msg) {
  // Keep stdout machine/report-clean: workflows redirect Markdown/JSON there.
  console.error(`${emoji} ${msg}`);
}

export function experimentFromArgs(args) {
  const inline = args.find((arg) => arg.startsWith('--experiment='));
  const separateIndex = args.indexOf('--experiment');
  const id = inline?.slice('--experiment='.length) || (separateIndex >= 0 ? args[separateIndex + 1] : null);
  if (!id) return DEFAULT_EXPERIMENT;
  const experiment = findExperiment(id);
  if (!experiment) {
    throw new Error(`Esperimento sconosciuto "${id}". Valori validi: ${EXPERIMENTS.map((item) => item.id).join(', ')}`);
  }
  return experiment;
}

async function main() {
  const args = process.argv.slice(2);
  const experiment = experimentFromArgs(args);
  const flags = {
    json: args.includes('--json'),
    markdown: args.includes('--markdown'),
    save: args.includes('--save'),
    debug: args.includes('--debug'),
  };

  const warnings = [];
  let control = null;
  let treatment = null;
  let currencyCode = 'EUR';
  let window = last7Days();

  // ── 1. AdSense (primary metric) ─────────────────────────────────────
  const adSenseToken = await getAdSenseToken();
  if (!adSenseToken) {
    warnings.push('AdSense credentials missing (ADSENSE_REFRESH_TOKEN not set) — AdSense section skipped this week.');
    log('⚪', warnings[warnings.length - 1]);
  } else {
    try {
      const fetched = await fetchChannelReport(adSenseToken, experiment);
      window = fetched.window;
      currencyCode = fetched.currencyCode;
      control = fetched.control;
      treatment = fetched.treatment;
      if (!control) warnings.push(`${experiment.adsenseDimension} controllo "${experiment.control.adsenseValue}" assente dal report AdSense questa settimana (probabile 0 impressioni).`);
      if (!treatment) warnings.push(`${experiment.adsenseDimension} trattamento "${experiment.treatment.adsenseValue}" assente dal report AdSense questa settimana (probabile 0 impressioni).`);
    } catch (e) {
      warnings.push(`AdSense fetch failed: ${e.message}`);
      log('⚠️', warnings[warnings.length - 1]);
      if (flags.debug) console.error(e.stack);
    }
  }
  const deltas = computeDeltas(control, treatment);

  // ── 2. GA4 engagement guardrail + 3a. GA4 web_vitals attempt ────────
  let engagement = null;
  let ga4WebVitals = { available: false, reason: 'GA4 not queried (no service-account token)' };
  const ga4Token = await getServiceAccountToken(GA4_SCOPES, { logInfo: () => {}, logError: (m) => log('⚠️', m) });
  if (!ga4Token) {
    warnings.push('GA4 service-account token unavailable (GOOGLE_APPLICATION_CREDENTIALS missing/invalid) — engagement section skipped, CWV falls through to PostHog/CrUX.');
    log('⚪', warnings[warnings.length - 1]);
  } else {
    try {
      engagement = await fetchGa4Engagement(ga4Token, experiment);
    } catch (e) {
      warnings.push(`GA4 engagement fetch failed: ${e.message}`);
      log('⚠️', warnings[warnings.length - 1]);
      if (flags.debug) console.error(e.stack);
    }
    ga4WebVitals = await fetchGa4WebVitalsRatings(ga4Token, experiment);
  }
  const engagementDeltas = computeEngagementDeltas(engagement?.control, engagement?.treatment);

  // ── 3b/3c. CWV fallbacks — PostHog trickle, then CrUX ────────────────
  let posthogCwv = { control: {}, treatment: {} };
  if (process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID) {
    posthogCwv = await fetchPostHogCwvTrickle(experiment);
  } else {
    warnings.push('PostHog credentials missing (POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID not set) — CWV PostHog fallback skipped.');
    log('⚪', warnings[warnings.length - 1]);
  }
  const pagespeedKey = process.env.PAGESPEED_API_KEY;
  const [cruxControl, cruxTreatment] = await Promise.all([
    fetchCruxRecord(`${SITE_ORIGIN}${experiment.control.path}`, pagespeedKey),
    fetchCruxRecord(`${SITE_ORIGIN}${experiment.treatment.path}`, pagespeedKey),
  ]);
  const cwv = { ga4: ga4WebVitals, posthog: posthogCwv, crux: { control: cruxControl, treatment: cruxTreatment } };
  if (!ga4WebVitals.available && !postHogTrickleHasAnyData(posthogCwv) && !(cruxControl.available && cruxTreatment.available)) {
    warnings.push('CWV non misurabile questa settimana su nessuna delle tre fonti (GA4/PostHog/CrUX) — vedi sezione Core Web Vitals per il motivo di ciascuna.');
  }

  const windowPhase = classifyWindow(experiment, window);
  const report = { experiment, windowPhase, currencyCode, window, control, treatment, deltas, engagement, engagementDeltas, cwv, warnings };
  const historySummary = readHistorySummary(experiment);

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (flags.markdown) {
    console.log(buildMarkdown(report, historySummary));
  } else {
    console.log(`AdSense format A/B ${experiment.id} — ${window.start} → ${window.end}`);
    console.log(`  ${experiment.control.label} (controllo): impr=${control?.impressions ?? '—'} rpm=${control?.rpmCHF ?? '—'} coverage=${control?.coveragePct ?? '—'}% pv=${control?.pageViews ?? '—'} epv=${control?.earningsPerPageviewCHF ?? '—'}`);
    console.log(`  ${experiment.treatment.label} (trattamento): impr=${treatment?.impressions ?? '—'} rpm=${treatment?.rpmCHF ?? '—'} coverage=${treatment?.coveragePct ?? '—'}% pv=${treatment?.pageViews ?? '—'} epv=${treatment?.earningsPerPageviewCHF ?? '—'}`);
    console.log(`  Δ rpm=${deltas.rpmPct ?? '—'}% coverage=${deltas.coveragePct ?? '—'}% earnings/pageview=${deltas.earningsPerPageviewPct ?? '—'}%`);
    if (engagement?.control && engagement?.treatment) {
      console.log(`  Engagement ${experiment.control.label}: sessions=${engagement.control.sessions} engRate=${engagement.control.engagementRatePct}% bounce=${engagement.control.bounceRatePct}%`);
      console.log(`  Engagement ${experiment.treatment.label}: sessions=${engagement.treatment.sessions} engRate=${engagement.treatment.engagementRatePct}% bounce=${engagement.treatment.bounceRatePct}%`);
    }
    console.log(`  CWV: ga4=${cwv.ga4.available ? 'available' : 'unavailable'} posthogData=${postHogTrickleHasAnyData(posthogCwv)} crux=${cruxControl.available && cruxTreatment.available ? 'available' : 'unavailable'}`);
    for (const w of warnings) console.log(`  ⚠️ ${w}`);
  }

  if (flags.save) {
    const reportsDir = resolve(__dirname, '..', 'reports');
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const reportBase = `adsense-format-ab-${experiment.id}-${stamp}`;
    writeFileSync(resolve(reportsDir, `${reportBase}.json`), JSON.stringify(report, null, 2));
    writeFileSync(resolve(reportsDir, `${reportBase}.md`), buildMarkdown(report, historySummary));
    log('📄', `reports/${reportBase}.{json,md} written`);

    // Only persist a history line for a clean post-treatment window when BOTH
    // AdSense sides produced real numbers — a mixed/partial row would corrupt the
    // cumulative trend (mirrors revenue-monitor.mjs's philosophy of never
    // writing a metric it could not actually measure). Engagement/CWV ride
    // along in the same line when available, null otherwise — they never
    // gate the AdSense history the way AdSense gates itself.
    if (control && treatment && windowPhase === 'post-treatment') {
      if (!existsSync(dirname(HISTORY_FILE))) mkdirSync(dirname(HISTORY_FILE), { recursive: true });
      appendFileSync(HISTORY_FILE, JSON.stringify(buildHistoryEntry(report)) + '\n');
      log('🗂 ', 'data/adsense-format-ab-history.jsonl appended');
    } else {
      const reason = windowPhase === 'post-treatment' ? 'incomplete AdSense data' : `${windowPhase} window`;
      log('⚪', `History append skipped — ${reason}.`);
    }
  }
}

// Only run main() when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error('adsense-format-ab-report failed:', e.message);
    if (process.argv.includes('--debug')) console.error(e.stack);
    process.exit(0);
  });
}
