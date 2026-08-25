#!/usr/bin/env node
/**
 * AdSense format A/B report — Basilea (controllo) vs Lucerna (trattamento)
 *
 * Weekly companion to the canton in-feed-ad A/B test wired in
 * services/adsenseSlots.ts (INFEED_AD_AB_TEST_SUPPRESSED_CANTONS): on the
 * canton job-search listing pages (/cerca-lavoro-{canton}/), Lucerna has the
 * manual In-page in-feed slot (JOBLIST_INFEED_DESKTOP/MOBILE) removed —
 * Auto Ads (Anchor/Vignette/in-page automatic) fill that placement instead —
 * while Basilea is left untouched as the control. Basilea and Lucerna were
 * picked (2026-08-25 AdSense Reporting API v2 query) as the closest-matched
 * canton pair in the whole IT canton set (July: €0.44/1498 impr/15% coverage
 * vs €0.43/1536 impr/18% coverage), on deliberately low-volume pages so a
 * bad outcome costs little.
 *
 * Three independent signals, all scoped to the same two IT-locale page paths
 * (`/cerca-lavoro-basilea/`, `/cerca-lavoro-lucerna/` — the paths the
 * router resolves for these two canton job-search pages; see
 * `services/router.ts` `parseJobBoardSlug` / `resolveCantonGroup` and
 * `build-plugins/jobsSeoPagesPlugin.ts` `buildCantonAwareSection`, the same
 * spots read while wiring the A/B test itself):
 *
 * 1. AdSense (the test's primary metric — RPM/coverage/earnings-per-pageview,
 *    via the two AdSense URL channels already registered for these pages).
 * 2. GA4 engagement guardrail (`averageSessionDuration`, `engagementRate`,
 *    `bounceRate`, `screenPageViewsPerSession`, property 524485296) — the
 *    hypothesis under test is that removing the in-page ad must NOT make
 *    Lucerna's engagement worse than Basilea's; a higher RPM paired with a
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
 *         filtered by `$pathname`. VERIFIED LIVE 2026-08-25: some data exists
 *         (n=1..19 samples over the last 180 days per metric/path) but at a
 *         trickle far below what a 7-day window would catch — PostHog ingest
 *         has been down to ~6-30 events/day site-wide since 2026-07-23 (was
 *         ~100k/day). This script therefore queries a POSTHOG_CWV_WINDOW_DAYS
 *         rolling window (30d, not 7d) for this section ONLY, and reports the
 *         sample count `n` next to every number so a 1-sample "p75" is never
 *         mistaken for a real distribution.
 *      c. CrUX API (`chromeuxreport.googleapis.com`, per-URL PHONE record).
 *         VERIFIED LIVE 2026-08-25: `404 NOT_FOUND` for both URLs — these
 *         pages are below CrUX's minimum real-Chrome-traffic threshold for a
 *         per-URL record.
 *    When none of the three yields data, the report says so explicitly
 *    ("CWV non misurabile") instead of omitting the section or inventing a
 *    number.
 *
 * At the declared volume for these two pages (~1500-2000 pageviews/month
 * each), a single week carries only a few hundred pageviews per side — nowhere
 * near enough for a real significance test on ANY of the three signals above.
 * This script does NOT compute one; it reports raw numbers plus an explicit
 * small-sample disclaimer every run, and leaves the "is this real yet"
 * judgment to the owner reading the accumulating weekly history.
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
 *   node scripts/adsense-format-ab-report.mjs --json       # JSON payload
 *   node scripts/adsense-format-ab-report.mjs --markdown   # GitHub-flavored markdown
 *   node scripts/adsense-format-ab-report.mjs --save       # write reports/adsense-format-ab-YYYY-MM-DD.{md,json}
 *                                                           # + append data/adsense-format-ab-history.jsonl
 *
 * Exits 0 always — this is a report, not a gate (mirrors revenue-monitor.mjs
 * "monitor, not gate"). A fetch failure on any of the three signals is
 * recorded as a warning IN the report (so the weekly GitHub issue update
 * surfaces it) rather than failing the workflow; the history line's AdSense
 * fields are only populated when real data for both channels was fetched, so
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

// The two AdSense URL channels this test compares. Both already exist in
// AdSense (registered against these exact canton job-search listing pages)
// — this script only reads them, it never creates/modifies AdSense config.
export const CONTROL_CHANNEL = 'frontaliereticino.ch/cerca-lavoro-basilea';
export const TREATMENT_CHANNEL = 'frontaliereticino.ch/cerca-lavoro-lucerna';

// Same two pages, as GA4/PostHog/CrUX identify them: an absolute pathname
// (GA4 `pagePath` / PostHog `$pathname`) or a full URL (CrUX). IT locale only
// (no /en//de//fr/ prefix) — matches the AdSense URL channels above, which
// are registered against the IT paths specifically; mixing locale variants
// in would compare a different population than the AdSense side.
export const CANTON_PAGE_PATHS = {
  control: '/cerca-lavoro-basilea/',
  treatment: '/cerca-lavoro-lucerna/',
};
const SITE_ORIGIN = 'https://frontaliereticino.ch';

// Metrics pulled per channel. Order here is also the `cells[]` order AdSense
// returns for a `dimensions=URL_CHANNEL_NAME` report — cells[0] is always the
// dimension value, cells[1..] follow this list positionally (same contract
// revenue-monitor.mjs's fetchAdSenseReport relies on for its own dimensioned
// queries).
const METRICS = ['IMPRESSIONS', 'IMPRESSIONS_RPM', 'ESTIMATED_EARNINGS', 'AD_REQUESTS_COVERAGE', 'PAGE_VIEWS'];

// Rows returned per query. The account has one URL channel per canton
// job-search page (~26); 200 leaves comfortable headroom without risking a
// slow/huge response.
const CHANNEL_ROW_LIMIT = 200;

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

/**
 * Fetch the URL_CHANNEL_NAME-dimensioned report for the last 7 full days and
 * pick out the control + treatment rows client-side (same "fetch broad, find
 * the row you want" pattern as revenue-monitor.mjs's AD_UNIT_NAME lookup —
 * more robust than trusting AdSense `filters` query syntax for an OR across
 * two channel names).
 */
export async function fetchChannelReport(token) {
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
  params.append('dimensions', 'URL_CHANNEL_NAME');
  params.append('limit', String(CHANNEL_ROW_LIMIT));

  const url = `https://adsense.googleapis.com/v2/${ADSENSE_ACCOUNT}/reports:generate?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`adsense reports:generate ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = data.rows || [];

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\/$/, '');
  const pickChannel = (channelName) => {
    const row = rows.find((r) => norm(r.cells?.[0]?.value) === norm(channelName));
    if (!row) return null;
    const cells = row.cells || [];
    const impressions = parseCellNumber(cells[1]?.value);
    const rpmCHF = parseCellNumber(cells[2]?.value);
    const earningsCHF = parseCellNumber(cells[3]?.value);
    const coverageRaw = cells[4]?.value ?? null;
    const coveragePct = parseCellNumber(cells[4]?.value);
    const pageViews = parseCellNumber(cells[5]?.value);
    const earningsPerPageviewCHF =
      earningsCHF !== null && pageViews ? Number((earningsCHF / pageViews).toFixed(4)) : null;
    return { channel: channelName, impressions, rpmCHF, earningsCHF, coverageRaw, coveragePct, pageViews, earningsPerPageviewCHF };
  };

  return {
    window: { start, end },
    control: pickChannel(CONTROL_CHANNEL),
    treatment: pickChannel(TREATMENT_CHANNEL),
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
 * Session-level engagement for the two canton pages, same 7-day window as
 * AdSense. Metric order below is also the `metricValues[]` positional order
 * GA4 returns (dimensions first, metrics in request order) — same contract
 * `fetchChannelReport` above relies on for AdSense.
 */
export async function fetchGa4Engagement(token) {
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
        inListFilter: { values: [CANTON_PAGE_PATHS.control, CANTON_PAGE_PATHS.treatment] },
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
  return { control: pick(CANTON_PAGE_PATHS.control), treatment: pick(CANTON_PAGE_PATHS.treatment) };
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
export async function fetchGa4WebVitalsRatings(token) {
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
              inListFilter: { values: [CANTON_PAGE_PATHS.control, CANTON_PAGE_PATHS.treatment] },
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
export async function fetchPostHogCwvTrickle() {
  const result = { control: {}, treatment: {} };
  for (const side of ['control', 'treatment']) {
    const path = CANTON_PAGE_PATHS[side];
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

/** CrUX per-URL PHONE record — VERIFIED 404 for both pages on 2026-08-25 (below CrUX's minimum-traffic threshold). Kept as the last-resort source in case traffic grows. */
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
  const lines = [];
  lines.push(`# AdSense format A/B: Basilea (controllo) vs Lucerna (trattamento)`);
  lines.push('');
  lines.push(`**Finestra:** ${window.start} → ${window.end} (ultimi 7 giorni pieni)`);
  lines.push('');
  lines.push('## AdSense — metrica primaria del test');
  lines.push('');

  if (!control || !treatment) {
    lines.push('⚠️ **Dati AdSense mancanti o incompleti per questa finestra** — vedi warning sotto. Nessuna riga aggiunta allo storico.');
    lines.push('');
  } else {
    lines.push('| Metrica | Basilea (controllo) | Lucerna (trattamento) | Δ% (trattamento vs controllo) |');
    lines.push('|---|---:|---:|---:|');
    lines.push(`| Impressioni | ${control.impressions ?? '—'} | ${treatment.impressions ?? '—'} | ${pctDelta(treatment.impressions, control.impressions) ?? '—'}% |`);
    lines.push(`| Page view | ${control.pageViews ?? '—'} | ${treatment.pageViews ?? '—'} | ${pctDelta(treatment.pageViews, control.pageViews) ?? '—'}% |`);
    lines.push(`| Earnings (CHF) | ${control.earningsCHF ?? '—'} | ${treatment.earningsCHF ?? '—'} | ${pctDelta(treatment.earningsCHF, control.earningsCHF) ?? '—'}% |`);
    lines.push(`| RPM (CHF/1000 impr.) | ${control.rpmCHF ?? '—'} | ${treatment.rpmCHF ?? '—'} | ${deltas.rpmPct ?? '—'}% |`);
    lines.push(`| Coverage (%) | ${control.coveragePct ?? '—'} | ${treatment.coveragePct ?? '—'} | ${deltas.coveragePct ?? '—'}% |`);
    lines.push(`| **Earnings / pageview (CHF)** | **${control.earningsPerPageviewCHF ?? '—'}** | **${treatment.earningsPerPageviewCHF ?? '—'}** | **${deltas.earningsPerPageviewPct ?? '—'}%** |`);
    lines.push('');
    lines.push('Earnings/pageview è la metrica più onesta per confrontare due format diversi (in-feed manuale vs solo Auto Ads) quando controllo e trattamento hanno pageview leggermente diversi — normalizza per il traffico invece di dividere per "impressioni", che dipende esso stesso dal format in test.');
    lines.push('');

    const smallControl = control.pageViews !== null && control.pageViews < SMALL_SAMPLE_PAGEVIEWS;
    const smallTreatment = treatment.pageViews !== null && treatment.pageViews < SMALL_SAMPLE_PAGEVIEWS;
    lines.push('### Dimensione del campione (AdSense)');
    lines.push('');
    lines.push(
      `⚠️ **Questo NON è un test di significatività statistica.** Con ~1.500-2.000 pageview/mese per canton dichiarati per queste due pagine, una singola settimana porta poche centinaia di pageview per lato (questa settimana: Basilea ${control.pageViews ?? '—'}, Lucerna ${treatment.pageViews ?? '—'}). I numeri sopra sono descrittivi, non una prova — servono a costruire uno storico settimana su settimana, non a decidere dopo una sola run. Lo stesso vale per le sezioni Engagement e Core Web Vitals sotto: stesso ordine di grandezza di traffico, stessa cautela.`,
    );
    if (smallControl || smallTreatment) {
      lines.push(`Campione sotto la soglia euristica di ${SMALL_SAMPLE_PAGEVIEWS} pageview/settimana per almeno un lato: il delta di questa settimana va letto con ancora più cautela del solito.`);
    }
    if (history && history.weeksWithData > 0) {
      lines.push('');
      lines.push(`Storico cumulativo (${history.weeksWithData} settimane con dati, incl. questa): Basilea ${history.cumulativePageViews.control} pageview totali, Lucerna ${history.cumulativePageViews.treatment} pageview totali. Anche il cumulativo resta un confronto descrittivo — non sostituisce un test statistico formale.`);
    }
    lines.push('');
  }

  // ── Engagement guardrail ──────────────────────────────────────────────
  lines.push('## Engagement (GA4) — guardrail');
  lines.push('');
  lines.push('Ipotesi da verificare: rimuovere l\'annuncio in-page a Lucerna NON deve peggiorare l\'engagement rispetto a Basilea — un RPM più alto pagato con engagement peggiore non è una vittoria.');
  lines.push('');
  if (engagement && engagement.control && engagement.treatment) {
    const e = engagement;
    lines.push('| Metrica | Basilea (controllo) | Lucerna (trattamento) | Δ% (trattamento vs controllo) |');
    lines.push('|---|---:|---:|---:|');
    lines.push(`| Sessioni (7g) | ${e.control.sessions ?? '—'} | ${e.treatment.sessions ?? '—'} | ${pctDelta(e.treatment.sessions, e.control.sessions) ?? '—'}% |`);
    lines.push(`| Durata media sessione (s) | ${e.control.avgSessionDurationSec ?? '—'} | ${e.treatment.avgSessionDurationSec ?? '—'} | ${engagementDeltas.avgSessionDurationPct ?? '—'}% |`);
    lines.push(`| Engagement rate (%) | ${e.control.engagementRatePct ?? '—'} | ${e.treatment.engagementRatePct ?? '—'} | ${engagementDeltas.engagementRatePct ?? '—'}% |`);
    lines.push(`| Bounce rate (%) | ${e.control.bounceRatePct ?? '—'} | ${e.treatment.bounceRatePct ?? '—'} | ${engagementDeltas.bounceRatePct ?? '—'}% |`);
    lines.push(`| Pageview / sessione | ${e.control.pageViewsPerSession ?? '—'} | ${e.treatment.pageViewsPerSession ?? '—'} | ${engagementDeltas.pageViewsPerSessionPct ?? '—'}% |`);
    lines.push('');
    lines.push(`⚠️ Sessioni GA4 di questa settimana nell'ordine delle decine per lato — stesso avvertimento di campione piccolo della sezione AdSense sopra, ancora più marcato qui.`);
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
    lines.push(`- PostHog: Basilea (${phNote('control')}) · Lucerna (${phNote('treatment')})`);
    lines.push(`- CrUX: Basilea ${cwv.crux?.control?.available ? '✅' : `❌ ${cwv.crux?.control?.reason ?? 'n/a'}`} · Lucerna ${cwv.crux?.treatment?.available ? '✅' : `❌ ${cwv.crux?.treatment?.reason ?? 'n/a'}`}`);
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
      const pageLabel = (p) => (p === CANTON_PAGE_PATHS.control ? 'Basilea' : p === CANTON_PAGE_PATHS.treatment ? 'Lucerna' : p);
      for (const [key, b] of buckets) {
        const [path, metric] = key.split('|');
        lines.push(`| ${pageLabel(path)} | ${metric} | ${b.good} | ${b.ni} | ${b.poor} | ${b.total} |`);
      }
      lines.push('');
    } else if (postHogTrickleHasAnyData(cwv.posthog)) {
      lines.push(`### PostHog (finestra ${POSTHOG_CWV_WINDOW_DAYS} giorni — non 7, per campione insufficiente su una settimana sola)`);
      lines.push('');
      lines.push('| Metrica | Basilea n / p75 | Lucerna n / p75 |');
      lines.push('|---|---:|---:|');
      for (const m of CWV_METRICS) {
        const c = cwv.posthog.control[m];
        const t = cwv.posthog.treatment[m];
        const unit = m === 'CLS' ? '' : 'ms';
        lines.push(`| ${m} | n=${c?.n ?? 0}, p75=${c?.p75 ?? '—'}${unit} | n=${t?.n ?? 0}, p75=${t?.p75 ?? '—'}${unit} |`);
      }
      lines.push('');
      lines.push('⚠️ Campione troppo piccolo per essere un trend affidabile (ordine di 1-20 campioni su 30 giorni, non su 7) — riportato solo come indicazione grezza, mai come prova.');
    } else if (cwv.crux?.control?.available && cwv.crux?.treatment?.available) {
      lines.push('### CrUX (p75, PHONE)');
      lines.push('');
      lines.push('| Metrica | Basilea | Lucerna |');
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
  lines.push(`Canali AdSense: \`${CONTROL_CHANNEL}\` (controllo) / \`${TREATMENT_CHANNEL}\` (trattamento). Pagine GA4/PostHog/CrUX: \`${CANTON_PAGE_PATHS.control}\` / \`${CANTON_PAGE_PATHS.treatment}\`. Storico: \`data/adsense-format-ab-history.jsonl\`. Script: \`scripts/adsense-format-ab-report.mjs\`.`);

  return lines.join('\n');
}

export function buildHistoryEntry(report) {
  const { window, control, treatment, deltas, engagement, engagementDeltas, cwv } = report;
  return {
    date: new Date().toISOString().slice(0, 10),
    window,
    control: {
      channel: CONTROL_CHANNEL,
      impressions: control.impressions,
      rpmCHF: control.rpmCHF,
      earningsCHF: control.earningsCHF,
      coveragePct: control.coveragePct,
      pageViews: control.pageViews,
      earningsPerPageviewCHF: control.earningsPerPageviewCHF,
    },
    treatment: {
      channel: TREATMENT_CHANNEL,
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

/** Reads the existing history file (if any) and sums pageviews per side, for the cumulative-sample note in the markdown. */
function readHistorySummary() {
  if (!existsSync(HISTORY_FILE)) return { weeksWithData: 0, cumulativePageViews: { control: 0, treatment: 0 } };
  const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
  let weeksWithData = 0;
  let controlPv = 0;
  let treatmentPv = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
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
  console.log(`${emoji} ${msg}`);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    json: args.includes('--json'),
    markdown: args.includes('--markdown'),
    save: args.includes('--save'),
    debug: args.includes('--debug'),
  };

  const warnings = [];
  let control = null;
  let treatment = null;
  let window = last7Days();

  // ── 1. AdSense (primary metric) ─────────────────────────────────────
  const adSenseToken = await getAdSenseToken();
  if (!adSenseToken) {
    warnings.push('AdSense credentials missing (ADSENSE_REFRESH_TOKEN not set) — AdSense section skipped this week.');
    log('⚪', warnings[warnings.length - 1]);
  } else {
    try {
      const fetched = await fetchChannelReport(adSenseToken);
      window = fetched.window;
      control = fetched.control;
      treatment = fetched.treatment;
      if (!control) warnings.push(`Canale controllo "${CONTROL_CHANNEL}" assente dal report AdSense questa settimana (probabile 0 impressioni).`);
      if (!treatment) warnings.push(`Canale trattamento "${TREATMENT_CHANNEL}" assente dal report AdSense questa settimana (probabile 0 impressioni).`);
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
      engagement = await fetchGa4Engagement(ga4Token);
    } catch (e) {
      warnings.push(`GA4 engagement fetch failed: ${e.message}`);
      log('⚠️', warnings[warnings.length - 1]);
      if (flags.debug) console.error(e.stack);
    }
    ga4WebVitals = await fetchGa4WebVitalsRatings(ga4Token);
  }
  const engagementDeltas = computeEngagementDeltas(engagement?.control, engagement?.treatment);

  // ── 3b/3c. CWV fallbacks — PostHog trickle, then CrUX ────────────────
  let posthogCwv = { control: {}, treatment: {} };
  if (process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID) {
    posthogCwv = await fetchPostHogCwvTrickle();
  } else {
    warnings.push('PostHog credentials missing (POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID not set) — CWV PostHog fallback skipped.');
    log('⚪', warnings[warnings.length - 1]);
  }
  const pagespeedKey = process.env.PAGESPEED_API_KEY;
  const [cruxControl, cruxTreatment] = await Promise.all([
    fetchCruxRecord(`${SITE_ORIGIN}${CANTON_PAGE_PATHS.control}`, pagespeedKey),
    fetchCruxRecord(`${SITE_ORIGIN}${CANTON_PAGE_PATHS.treatment}`, pagespeedKey),
  ]);
  const cwv = { ga4: ga4WebVitals, posthog: posthogCwv, crux: { control: cruxControl, treatment: cruxTreatment } };
  if (!ga4WebVitals.available && !postHogTrickleHasAnyData(posthogCwv) && !(cruxControl.available && cruxTreatment.available)) {
    warnings.push('CWV non misurabile questa settimana su nessuna delle tre fonti (GA4/PostHog/CrUX) — vedi sezione Core Web Vitals per il motivo di ciascuna.');
  }

  const report = { window, control, treatment, deltas, engagement, engagementDeltas, cwv, warnings };
  const historySummary = readHistorySummary();

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (flags.markdown) {
    console.log(buildMarkdown(report, historySummary));
  } else {
    console.log(`AdSense format A/B — ${window.start} → ${window.end}`);
    console.log(`  Basilea (controllo):   impr=${control?.impressions ?? '—'} rpm=${control?.rpmCHF ?? '—'} coverage=${control?.coveragePct ?? '—'}% pv=${control?.pageViews ?? '—'} epv=${control?.earningsPerPageviewCHF ?? '—'}`);
    console.log(`  Lucerna (trattamento): impr=${treatment?.impressions ?? '—'} rpm=${treatment?.rpmCHF ?? '—'} coverage=${treatment?.coveragePct ?? '—'}% pv=${treatment?.pageViews ?? '—'} epv=${treatment?.earningsPerPageviewCHF ?? '—'}`);
    console.log(`  Δ rpm=${deltas.rpmPct ?? '—'}% coverage=${deltas.coveragePct ?? '—'}% earnings/pageview=${deltas.earningsPerPageviewPct ?? '—'}%`);
    if (engagement?.control && engagement?.treatment) {
      console.log(`  Engagement Basilea:   sessions=${engagement.control.sessions} engRate=${engagement.control.engagementRatePct}% bounce=${engagement.control.bounceRatePct}%`);
      console.log(`  Engagement Lucerna:   sessions=${engagement.treatment.sessions} engRate=${engagement.treatment.engagementRatePct}% bounce=${engagement.treatment.bounceRatePct}%`);
    }
    console.log(`  CWV: ga4=${cwv.ga4.available ? 'available' : 'unavailable'} posthogData=${postHogTrickleHasAnyData(posthogCwv)} crux=${cruxControl.available && cruxTreatment.available ? 'available' : 'unavailable'}`);
    for (const w of warnings) console.log(`  ⚠️ ${w}`);
  }

  if (flags.save) {
    const reportsDir = resolve(__dirname, '..', 'reports');
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(resolve(reportsDir, `adsense-format-ab-${stamp}.json`), JSON.stringify(report, null, 2));
    writeFileSync(resolve(reportsDir, `adsense-format-ab-${stamp}.md`), buildMarkdown(report, historySummary));
    log('📄', `reports/adsense-format-ab-${stamp}.{json,md} written`);

    // Only persist a history line when BOTH AdSense sides produced real
    // numbers — a fabricated/partial row would silently corrupt the
    // cumulative trend (mirrors revenue-monitor.mjs's philosophy of never
    // writing a metric it could not actually measure). Engagement/CWV ride
    // along in the same line when available, null otherwise — they never
    // gate the AdSense history the way AdSense gates itself.
    if (control && treatment) {
      if (!existsSync(dirname(HISTORY_FILE))) mkdirSync(dirname(HISTORY_FILE), { recursive: true });
      appendFileSync(HISTORY_FILE, JSON.stringify(buildHistoryEntry(report)) + '\n');
      log('🗂 ', 'data/adsense-format-ab-history.jsonl appended');
    } else {
      log('⚪', 'History append skipped — incomplete AdSense data this week.');
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
