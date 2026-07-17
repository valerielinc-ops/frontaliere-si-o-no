#!/usr/bin/env node
/**
 * Frontaliere Ticino — User Value Report (Stage 3: AdSense revenue-per-user)
 *
 * Segments GA4's `totalAdRevenue` metric (available because this GA4 property
 * is linked to AdSense) by the 3 new USER-scoped custom dimensions
 * (`is_registered`, `is_newsletter_subscriber`, `is_job_alert_subscriber`)
 * plus device/geo/traffic-source, and computes ARPU = totalAdRevenue / activeUsers.
 * Also builds a revenue-by-days-since-acquisition curve (GA4 cohort report) for
 * a rough LTV read, sliced by the same custom dimensions where possible.
 *
 * ── Custom dimension dependency ──────────────────────────────────────────
 * The 3 dimensions above (plus the app's `locale` user property) are emitted
 * client-side and registered via the Admin API by separate, parallel work.
 * Until that lands AND has been live for a few days (GA4 does not backfill
 * history for newly-registered custom dimensions), this script's
 * `customDimensionRegistration` section will show them as unregistered and
 * the segmented/sliced sections will gracefully fall back to standard
 * dimensions only. That is expected — see the code comments below for the
 * exact, live-verified API errors this produces.
 *
 * Auth (same pattern as scripts/analytics-report.mjs; load via
 * scripts/load-rc-env.mjs in CI, or:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs)"
 * ):
 *   GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN   — OAuth2, analytics.readonly
 *                                                              scope (same token reportGA4()
 *                                                              in analytics-report.mjs uses).
 *   GA4_PROPERTY_ID                                          — e.g. "properties/524485296"
 *   GOOGLE_APPLICATION_CREDENTIALS                           — (optional) service account,
 *                                                              used read-only here to list
 *                                                              registered Admin API custom
 *                                                              dimensions. Falls back to the
 *                                                              OAuth2 token if absent.
 *
 * Usage:
 *   node scripts/user-value-report.mjs                      # last 30 days (default)
 *   node scripts/user-value-report.mjs --days 14             # override window
 *   node scripts/user-value-report.mjs --start 2026-06-01 --end 2026-06-30
 *   node scripts/user-value-report.mjs --cohort-days 14       # LTV curve length (default = --days)
 *   node scripts/user-value-report.mjs --json                 # print full JSON to stdout too
 *
 * Output: data/user-value-report.json (overwritten each run — snapshot, not
 * an append-only history; matches data/gsc-position-rolling.json's convention
 * rather than revenue-monitor.mjs's append-only data/revenue-monitor-history.jsonl,
 * since there is no rolling trend requirement here yet).
 *
 * Always exits 0 — this is a report, not a CI gate.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sleep, fetchRetry, getServiceAccountToken, DEFAULT_GA4_PROPERTY_ID } from './lib/ga4-service-account.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'data', 'user-value-report.json');

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  json: args.includes('--json'),
  debug: args.includes('--debug'),
};
const argVal = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : fallback;
};
const DAYS = parseInt(argVal('--days', '30'), 10) || 30;
const EXPLICIT_START = argVal('--start', null);
const EXPLICIT_END = argVal('--end', null);
const COHORT_DAYS = Math.min(parseInt(argVal('--cohort-days', String(DAYS)), 10) || DAYS, 90);

// ── Helpers ─────────────────────────────────────────────────
function log(emoji, msg) {
  if (!flags.json) console.log(`${emoji}  ${msg}`);
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
function computeArpu(revenue, users) {
  const r = Number(revenue) || 0;
  const u = Number(users) || 0;
  return u > 0 ? Number((r / u).toFixed(4)) : null;
}

// ── Auth (exact pattern reused from scripts/analytics-report.mjs) ───────
async function getAccessToken() {
  const clientId = process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.GSC_CLIENT_SECRET;
  const refreshToken = process.env.GSC_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

// ── GA4 Data API ────────────────────────────────────────────
async function runReport(propertyId, headers, body) {
  const res = await fetchRetry(`https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function rowsToObjects(data, dimNames, metricNames) {
  return (data.rows || []).map((r) => {
    const obj = {};
    dimNames.forEach((name, i) => { obj[name] = r.dimensionValues?.[i]?.value ?? null; });
    metricNames.forEach((name, i) => { obj[name] = Number(r.metricValues?.[i]?.value ?? 0); });
    return obj;
  });
}

// The 3 dims emitted/registered by the sibling agents (scope=USER), plus the
// app's pre-existing `locale` user property (services/analytics.ts:684,
// `navigator.language` set via `setProps`) which is queried the same way but
// was NOT part of that work — verified separately below (task requirement).
const NEW_CUSTOM_USER_DIMS = ['is_registered', 'is_newsletter_subscriber', 'is_job_alert_subscriber'];
const LOCALE_PARAM = 'locale';
const ALL_CANDIDATE_USER_DIMS = [...NEW_CUSTOM_USER_DIMS, LOCALE_PARAM];

const STANDARD_DIMS = ['deviceCategory', 'country', 'sessionSource', 'sessionMedium', 'sessionCampaignName'];

// ── 1. Custom dimension registration check (Admin API) ──────
// Deterministic check (vs. sniffing error strings from a failed runReport):
// list what's actually registered and only ask for those in later queries.
async function checkCustomDimensionRegistration(propertyId, adminHeaders) {
  const result = {};
  for (const dim of ALL_CANDIDATE_USER_DIMS) result[dim] = { registered: false, scope: null };

  const res = await fetchRetry(
    `https://analyticsadmin.googleapis.com/v1beta/${propertyId}/customDimensions?pageSize=200`,
    { headers: adminHeaders }
  );
  if (!res.ok) {
    return { result, error: `Admin API customDimensions list failed: HTTP ${res.status}` };
  }
  const data = await res.json();
  for (const dim of data.customDimensions || []) {
    if (result[dim.parameterName]) {
      result[dim.parameterName] = { registered: true, scope: dim.scope };
    }
  }
  return { result, error: null };
}

// ── 2. Locale dimension verification (task requirement) ─────
// GA4's built-in `language` dimension is the BROWSER's Accept-Language /
// navigator.language read at the request level — NOT the same thing as this
// app's `locale` user property (also navigator.language, but captured once at
// Analytics.init() and set as a GA4 USER property via setProps(), scope=USER).
// They usually correlate but are structurally different: `language` is a
// standard GA4 dimension available without registration; `customUser:locale`
// requires the same Admin API scope=USER registration as the other 3 new dims.
//
// Live-verified 2026-07-17: neither is registered yet.
//   customUser:locale -> HTTP 400 INVALID_ARGUMENT
//     "Did you mean customEvent:content_locale? Field customUser:locale is
//      not a valid dimension." (content_locale is a *different*, already-
//      registered EVENT-scoped dim for the page's content locale — not this.)
async function checkLocaleDimension(propertyId, headers, period, registration) {
  const out = {
    appLocaleProperty: {
      source: 'services/analytics.ts:684 (setProps({ locale: navigator.language || \'it-IT\' }))',
      ga4DimensionName: 'customUser:locale',
      registeredInAdmin: registration.locale.registered,
      queryable: false,
      apiError: null,
    },
    builtInLanguageDimension: {
      ga4DimensionName: 'language',
      description: 'GA4 built-in dimension — browser language at event time. NOT the app locale property.',
      queryable: false,
      sample: [],
    },
    dimensionUsedInThisReport: null,
    note: null,
  };

  // Attempt customUser:locale regardless of the Admin API check, per task
  // instruction to verify by actually attempting the query.
  const localeAttempt = await runReport(propertyId, headers, {
    dateRanges: [{ startDate: period.start, endDate: period.end }],
    dimensions: [{ name: 'customUser:locale' }],
    metrics: [{ name: 'activeUsers' }, { name: 'totalAdRevenue' }],
    limit: 10,
  });
  if (localeAttempt.ok) {
    out.appLocaleProperty.queryable = true;
  } else {
    out.appLocaleProperty.apiError = localeAttempt.data?.error?.message || `HTTP ${localeAttempt.status}`;
  }

  // Built-in `language`, for contrast — always queryable, no registration needed.
  const langAttempt = await runReport(propertyId, headers, {
    dateRanges: [{ startDate: period.start, endDate: period.end }],
    dimensions: [{ name: 'language' }],
    metrics: [{ name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
    limit: 8,
  });
  if (langAttempt.ok) {
    out.builtInLanguageDimension.queryable = true;
    out.builtInLanguageDimension.sample = rowsToObjects(langAttempt.data, ['language'], ['activeUsers']);
  }

  out.dimensionUsedInThisReport = out.appLocaleProperty.queryable ? 'customUser:locale' : 'language (fallback — see note)';
  out.note = out.appLocaleProperty.queryable
    ? 'customUser:locale is registered and queryable — used directly.'
    : `customUser:locale is NOT registered yet (needs the same Admin API scope=USER registration as ` +
      `is_registered/is_newsletter_subscriber/is_job_alert_subscriber — it was not part of that sibling ` +
      `work). Falling back to GA4's built-in "language" (browser language) as an approximate, always-` +
      `available proxy for this report's device/country/source breakdown — it is NOT a substitute for the ` +
      `app's actual locale selection and should not be treated as equivalent once customUser:locale ships.`;

  return out;
}

// ── 3. Segmented ARPU report ──────────────────────────────────
async function fetchSegmentedArpu(propertyId, headers, period, registration) {
  const requestedDims = [...NEW_CUSTOM_USER_DIMS, ...STANDARD_DIMS];
  const usableCustomDims = NEW_CUSTOM_USER_DIMS.filter((d) => registration[d].registered);
  const skipped = NEW_CUSTOM_USER_DIMS.filter((d) => !registration[d].registered).map((d) => ({
    dimension: `customUser:${d}`,
    reason: 'not registered in GA4 Admin API customDimensions yet (see customDimensionRegistration)',
  }));

  const dimNames = [...usableCustomDims.map((d) => `customUser:${d}`), ...STANDARD_DIMS];
  const dimensions = dimNames.map((name) => ({ name }));
  const metrics = [{ name: 'totalAdRevenue' }, { name: 'activeUsers' }];

  const result = await runReport(propertyId, headers, {
    dateRanges: [{ startDate: period.start, endDate: period.end }],
    dimensions,
    metrics,
    orderBys: [{ metric: { metricName: 'totalAdRevenue' }, desc: true }],
    limit: 250,
  });

  if (!result.ok) {
    return {
      dimensionsRequested: requestedDims,
      dimensionsUsed: dimNames,
      dimensionsSkipped: skipped,
      error: result.data?.error?.message || `HTTP ${result.status}`,
      rows: [],
      totals: null,
      currencyCode: null,
    };
  }

  const rows = rowsToObjects(result.data, dimNames, ['totalAdRevenue', 'activeUsers']).map((row) => ({
    ...row,
    arpu: computeArpu(row.totalAdRevenue, row.activeUsers),
  }));

  const totalRevenue = rows.reduce((s, r) => s + r.totalAdRevenue, 0);
  const totalUsers = rows.reduce((s, r) => s + r.activeUsers, 0);

  return {
    dimensionsRequested: requestedDims,
    dimensionsUsed: dimNames,
    dimensionsSkipped: skipped,
    error: null,
    rowCount: rows.length,
    rows,
    totals: {
      totalAdRevenue: Number(totalRevenue.toFixed(4)),
      activeUsers: totalUsers,
      arpu: computeArpu(totalRevenue, totalUsers),
    },
    currencyCode: result.data?.metadata?.currencyCode || null,
  };
}

// ── 4. Cohort / LTV curve (revenue by days-since-acquisition) ─
//
// Live-verified 2026-07-17 findings (see git history / PR description for
// the exact probe transcripts):
//
//  - `totalAdRevenue` IS a valid cohort-report metric — a plain
//    { dimensions: [cohort, cohortNthDay], metrics: [cohortActiveUsers,
//    totalAdRevenue], cohortSpec: {...} } request returns real per-day
//    revenue and user counts. No documented restriction against it despite
//    it not appearing in GA4's own "Cohort exploration" UI template.
//  - Cohort requests MUST NOT set the top-level `dateRanges` field (must be
//    empty/omitted) — the acquisition window instead goes on
//    `cohortSpec.cohorts[].dateRange`. Setting both throws:
//      "In a cohort request, dateRanges must be empty and cohort dateRange
//       must be specified."
//  - WEEKLY granularity caps the cohort acquisition window at 7 days
//    (`cohortSpec.cohorts[].dateRange`), REGARDLESS of which dimensions are
//    requested — a 30-day WEEKLY cohort throws:
//      "RET_CHECK failure (.../validation_utils.cc:849) cohort_end_date -
//       cohort_start_date <= 6 (30 vs. 6) Cohort periods must be of length
//       less than or equal to 7 days for weekly cohorts."
//    This is a REAL, dimension-independent constraint — confirmed by
//    reproducing it with the NOW-registered, valid `customUser:is_registered`
//    dimension (2026-07-17), which rules out the "invalid dimension" theory
//    an earlier probe round (pre-registration) had wrongly inferred from the
//    same message.
//  - DAILY granularity has a SEPARATE, also real, constraint: adding ANY
//    custom dimension (`customUser:*` — a standard dimension like
//    `deviceCategory` is unaffected, verified) as a 3rd dimension forces the
//    cohort's acquisition `dateRange` to be a SINGLE day
//    (`cohort_start_date == cohort_end_date`), regardless of how wide the
//    range is — a multi-day DAILY cohort + custom dimension throws:
//      "RET_CHECK failure (.../validation_utils.cc:842) cohort_start_date ==
//       cohort_end_date (2026-06-17 vs. 2026-07-17) Start date should be
//       equal to end date for daily cohort analysis."
//    Reproduced at both a 30-day and a 7-day window — width doesn't matter,
//    only start==end does. A genuinely single-day acquisition window (e.g.
//    "users who first-visited exactly yesterday") + a custom dimension DOES
//    succeed (verified, real data). `totalAdRevenue` itself IS a valid
//    cohort metric throughout (no restriction found).
//  - Net effect: real (non-approximated) revenue-by-days-since-acquisition
//    data sliced by a custom user dimension IS obtainable, just not as one
//    multi-day request — it requires one DAILY-granularity, single-day-
//    acquisition-window request PER acquisition day, each returning that
//    day's own decay curve. `SLICE_LOOKBACK_DAYS` below bounds how many
//    acquisition days (and therefore API calls: lookbackDays × dims) this
//    performs per run. The task's "simplified proxy" fallback (rolling
//    calendar-week `runReport` snapshots, no `cohortSpec`) is kept as a
//    secondary, single-call cross-check, clearly labeled as an approximation
//    — it is not needed as the primary path since the real thing works.
async function fetchCohortLtv(propertyId, headers, cohortPeriod, registration) {
  const baseCurve = {
    granularity: 'DAILY',
    acquisitionWindow: cohortPeriod,
    error: null,
    rows: [],
  };

  const baseResult = await runReport(propertyId, headers, {
    dimensions: [{ name: 'cohort' }, { name: 'cohortNthDay' }],
    metrics: [{ name: 'cohortActiveUsers' }, { name: 'totalAdRevenue' }],
    cohortSpec: {
      cohorts: [{ name: 'cohort0', dimension: 'firstSessionDate', dateRange: cohortPeriod }],
      cohortsRange: { granularity: 'DAILY', startOffset: 0, endOffset: COHORT_DAYS - 1 },
    },
    limit: COHORT_DAYS + 5,
  });

  if (!baseResult.ok) {
    baseCurve.error = baseResult.data?.error?.message || `HTTP ${baseResult.status}`;
  } else {
    baseCurve.rows = rowsToObjects(baseResult.data, ['cohort', 'cohortNthDay'], ['cohortActiveUsers', 'totalAdRevenue'])
      .map((r) => ({
        daysSinceAcquisition: parseInt(r.cohortNthDay, 10),
        cohortActiveUsers: r.cohortActiveUsers,
        totalAdRevenue: Number(r.totalAdRevenue.toFixed(4)),
        revenuePerActiveUser: computeArpu(r.totalAdRevenue, r.cohortActiveUsers),
      }))
      .sort((a, b) => a.daysSinceAcquisition - b.daysSinceAcquisition);
    baseCurve.currencyCode = baseResult.data?.metadata?.currencyCode || null;
  }

  // Sliced-by-custom-dim cohort curve: real (non-approximated) data, built as
  // one single-day-acquisition DAILY cohort request PER acquisition day (see
  // code comment above for why a single multi-day request 400s here).
  // Bounded to the last SLICE_LOOKBACK_DAYS acquisition days x SLICE_DECAY_DAYS
  // of observed decay per day, to keep the per-run API call count sane
  // (lookbackDays x dims calls total).
  const SLICE_LOOKBACK_DAYS = Math.min(COHORT_DAYS, 7);
  const SLICE_DECAY_DAYS = 6; // offset 0..6 => 7 data points per acquisition day
  const slicedByCustomDim = {};
  for (const dim of NEW_CUSTOM_USER_DIMS) {
    if (!registration[dim].registered) {
      slicedByCustomDim[dim] = {
        attempted: true,
        available: false,
        reason: 'not registered yet — will be retried automatically once registration.registered is true',
      };
      continue;
    }
    const dimRows = [];
    const dimErrors = [];
    for (let daysAgo = SLICE_LOOKBACK_DAYS; daysAgo >= 1; daysAgo--) {
      const acqDate = new Date();
      acqDate.setUTCDate(acqDate.getUTCDate() - daysAgo);
      const acqDateStr = fmtDate(acqDate);
      const dayResult = await runReport(propertyId, headers, {
        dimensions: [{ name: 'cohort' }, { name: 'cohortNthDay' }, { name: `customUser:${dim}` }],
        metrics: [{ name: 'cohortActiveUsers' }, { name: 'totalAdRevenue' }],
        cohortSpec: {
          cohorts: [{ name: 'cohort0', dimension: 'firstSessionDate', dateRange: { startDate: acqDateStr, endDate: acqDateStr } }],
          cohortsRange: { granularity: 'DAILY', startOffset: 0, endOffset: Math.min(SLICE_DECAY_DAYS, daysAgo - 1 >= 0 ? daysAgo : SLICE_DECAY_DAYS) },
        },
        limit: 40,
      });
      if (dayResult.ok) {
        dimRows.push(
          ...rowsToObjects(dayResult.data, ['cohort', 'cohortNthDay', dim], ['cohortActiveUsers', 'totalAdRevenue']).map((r) => ({
            acquisitionDate: acqDateStr,
            daysSinceAcquisition: parseInt(r.cohortNthDay, 10),
            [dim]: r[dim],
            cohortActiveUsers: r.cohortActiveUsers,
            totalAdRevenue: Number(r.totalAdRevenue.toFixed(4)),
            revenuePerActiveUser: computeArpu(r.totalAdRevenue, r.cohortActiveUsers),
          }))
        );
      } else {
        dimErrors.push({ acquisitionDate: acqDateStr, error: dayResult.data?.error?.message || `HTTP ${dayResult.status}` });
      }
      await sleep(120); // avoid bursting the Data API with back-to-back calls
    }
    slicedByCustomDim[dim] = {
      attempted: true,
      available: dimRows.length > 0,
      method: `${SLICE_LOOKBACK_DAYS} single-day-acquisition DAILY cohort requests (real data, not an approximation) — required because DAILY cohorts + a custom dimension need cohort_start_date == cohort_end_date`,
      acquisitionDaysCovered: SLICE_LOOKBACK_DAYS,
      rows: dimRows,
      ...(dimErrors.length ? { partialErrors: dimErrors } : {}),
    };
  }

  // Simplified proxy fallback (task requirement): NOT a true acquisition
  // cohort — just N rolling calendar-week runReport snapshots (up to 4
  // dateRanges per GA4 Data API request) sliced by each custom dim. Useful
  // once the dims exist even if the true cohort slice above is ever
  // rejected for some other reason; clearly labeled as an approximation
  // everywhere it's surfaced (console + JSON).
  const proxyFallback = { method: 'APPROXIMATION — rolling weekly runReport snapshots, not a true acquisition-cohort curve', byDim: {} };
  const weekRanges = [0, 1, 2, 3].map((weeksAgo) => {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - weeksAgo * 7);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    return { startDate: fmtDate(start), endDate: fmtDate(end), name: `week-${weeksAgo}` };
  });
  for (const dim of NEW_CUSTOM_USER_DIMS) {
    if (!registration[dim].registered) {
      proxyFallback.byDim[dim] = { attempted: false, reason: 'not registered yet — same as sliced cohort above' };
      continue;
    }
    const proxyResult = await runReport(propertyId, headers, {
      dateRanges: weekRanges.map(({ startDate, endDate, name }) => ({ startDate, endDate, name })),
      dimensions: [{ name: `customUser:${dim}` }],
      metrics: [{ name: 'totalAdRevenue' }, { name: 'activeUsers' }],
      limit: 100,
    });
    if (proxyResult.ok) {
      proxyFallback.byDim[dim] = {
        attempted: true,
        available: true,
        rows: rowsToObjects(proxyResult.data, [dim, 'dateRange'], ['totalAdRevenue', 'activeUsers']).map((r) => ({
          ...r,
          arpu: computeArpu(r.totalAdRevenue, r.activeUsers),
        })),
      };
    } else {
      proxyFallback.byDim[dim] = { attempted: true, available: false, error: proxyResult.data?.error?.message || `HTTP ${proxyResult.status}` };
    }
  }

  return { baseCurve, slicedByCustomDim, proxyFallback };
}

// ── Console rendering ───────────────────────────────────────
function renderConsoleSummary(report) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   📊  Frontaliere Ticino — User Value Report (ARPU/LTV)   ║');
  console.log(`║   📅  ${report.period.start} → ${report.period.end}                          ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  console.log('🏷️  Custom dimension registration (Admin API):');
  for (const [dim, status] of Object.entries(report.customDimensionRegistration.result)) {
    const icon = status.registered ? '✅' : '⏳';
    console.log(`   ${icon} customUser:${dim.padEnd(28)} registered=${status.registered}  scope=${status.scope ?? '—'}`);
  }
  if (report.customDimensionRegistration.error) {
    console.log(`   ⚠️  ${report.customDimensionRegistration.error}`);
  }
  console.log('');

  console.log('🌍 Locale dimension check:');
  console.log(`   customUser:locale queryable: ${report.locale.appLocaleProperty.queryable}`);
  if (report.locale.appLocaleProperty.apiError) {
    console.log(`   API error: ${report.locale.appLocaleProperty.apiError}`);
  }
  console.log(`   Used in this report: ${report.locale.dimensionUsedInThisReport}`);
  console.log('');

  console.log('💰 Segmented ARPU (top rows by totalAdRevenue):');
  if (report.segmentedArpu.error) {
    console.log(`   ⚠️  Query failed: ${report.segmentedArpu.error}`);
  } else {
    console.log(`   Dimensions used: ${report.segmentedArpu.dimensionsUsed.join(', ')}`);
    if (report.segmentedArpu.dimensionsSkipped.length) {
      console.log(`   Skipped (not registered yet): ${report.segmentedArpu.dimensionsSkipped.map((s) => s.dimension).join(', ')}`);
    }
    const top = report.segmentedArpu.rows.slice(0, 15);
    if (top.length === 0) {
      console.log('   (no rows returned for this window)');
    } else {
      console.table(top);
    }
    console.log(`   Totals: revenue=${report.segmentedArpu.totals?.totalAdRevenue} ${report.segmentedArpu.currencyCode ?? ''} | activeUsers=${report.segmentedArpu.totals?.activeUsers} | ARPU=${report.segmentedArpu.totals?.arpu}`);
  }
  console.log('');

  console.log(`📈 LTV curve (cohort report, DAILY granularity, ${COHORT_DAYS}-day acquisition window):`);
  if (report.ltv.baseCurve.error) {
    console.log(`   ⚠️  Cohort query failed: ${report.ltv.baseCurve.error}`);
  } else {
    console.table(report.ltv.baseCurve.rows.slice(0, 15));
  }
  for (const dim of Object.keys(report.ltv.slicedByCustomDim)) {
    const s = report.ltv.slicedByCustomDim[dim];
    const rowInfo = s.rows ? `, ${s.rows.length} rows over ${s.acquisitionDaysCovered ?? '?'} acquisition days` : '';
    console.log(`   Sliced by customUser:${dim} — available=${s.available}${rowInfo}${s.error ? ` (${s.error})` : ''}${s.reason ? ` (${s.reason})` : ''}`);
  }
  console.log('');

  if (report.warnings.length) {
    console.log('⚠️  Warnings:');
    for (const w of report.warnings) console.log(`   - ${w}`);
    console.log('');
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  const report = {
    generatedAt: new Date().toISOString(),
    ga4PropertyId: propertyId,
    period: null,
    customDimensionRegistration: null,
    locale: null,
    segmentedArpu: null,
    ltv: null,
    warnings: [],
    errors: [],
  };

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    report.errors.push(`OAuth2 auth failed: ${e.message}`);
  }
  if (!token) {
    report.errors.push('GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN not configured — cannot query GA4 Data API. Run scripts/load-rc-env.mjs first.');
    log('❌', report.errors[report.errors.length - 1]);
    writeOutput(report);
    process.exit(0);
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  log('🔑', 'OAuth2 authenticated (GA4 Data API)');

  const endDate = EXPLICIT_END ? new Date(EXPLICIT_END) : new Date();
  const startDate = EXPLICIT_START ? new Date(EXPLICIT_START) : (() => {
    const d = new Date(endDate);
    d.setUTCDate(d.getUTCDate() - DAYS);
    return d;
  })();
  const period = { start: fmtDate(startDate), end: fmtDate(endDate), days: DAYS };
  report.period = period;

  const cohortEnd = new Date();
  const cohortStart = new Date();
  cohortStart.setUTCDate(cohortStart.getUTCDate() - COHORT_DAYS);
  const cohortPeriod = { startDate: fmtDate(cohortStart), endDate: fmtDate(cohortEnd) };

  // 1. Custom dimension registration (read-only Admin API check).
  try {
    const adminToken = await getServiceAccountToken(
      ['https://www.googleapis.com/auth/analytics.readonly'],
      { logInfo: (msg) => log('ℹ️', msg), logError: (msg) => log('⚠️', msg) }
    );
    const adminHeaders = adminToken ? { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' } : headers;
    report.customDimensionRegistration = await checkCustomDimensionRegistration(propertyId, adminHeaders);
    log('🏷️ ', `Custom dimension registration checked (${adminToken ? 'service account' : 'OAuth2 fallback'})`);
  } catch (e) {
    report.customDimensionRegistration = { result: Object.fromEntries(ALL_CANDIDATE_USER_DIMS.map((d) => [d, { registered: false, scope: null }])), error: e.message };
    report.warnings.push(`Custom dimension registration check failed: ${e.message}`);
  }
  const registration = report.customDimensionRegistration.result;
  const anyRegistered = Object.values(registration).some((r) => r.registered);
  if (!anyRegistered) {
    report.warnings.push(
      'None of is_registered/is_newsletter_subscriber/is_job_alert_subscriber/locale are registered as GA4 ' +
      'custom dimensions yet. This is expected while the sibling emit+register work is in flight — the ' +
      'segmented ARPU and LTV sections below fall back to standard dimensions only. Re-run this script once ' +
      'that work is live to see real segmented data (and note GA4 does not backfill history for newly-' +
      'registered custom dimensions, so even then expect a few sparse days before rows appear).'
    );
  }

  // 2. Locale verification.
  try {
    report.locale = await checkLocaleDimension(propertyId, headers, period, registration);
    log('🌍', `Locale dimension check done — using: ${report.locale.dimensionUsedInThisReport}`);
  } catch (e) {
    report.errors.push(`Locale check failed: ${e.message}`);
  }

  // 3. Segmented ARPU.
  try {
    report.segmentedArpu = await fetchSegmentedArpu(propertyId, headers, period, registration);
    log('💰', `Segmented ARPU query done — ${report.segmentedArpu.rowCount ?? 0} rows`);
  } catch (e) {
    report.errors.push(`Segmented ARPU query failed: ${e.message}`);
    report.segmentedArpu = { dimensionsRequested: [], dimensionsUsed: [], dimensionsSkipped: [], error: e.message, rows: [], totals: null };
  }

  // 4. Cohort / LTV.
  try {
    report.ltv = await fetchCohortLtv(propertyId, headers, cohortPeriod, registration);
    log('📈', `LTV cohort query done — ${report.ltv.baseCurve.rows.length} day-rows`);
  } catch (e) {
    report.errors.push(`LTV cohort query failed: ${e.message}`);
    report.ltv = { baseCurve: { error: e.message, rows: [] }, slicedByCustomDim: {}, proxyFallback: {} };
  }

  // 5. Registered-but-sparse detection: distinct from "not registered at all"
  // (warned above). A dim can be live in the Admin API yet still show only
  // '(not set)' everywhere because either (a) the client-side code that
  // populates it hasn't shipped/been live long enough for GA4 to have
  // collected any events with it set, and/or (b) GA4 never backfills history
  // for a newly-registered custom dimension — pre-registration sessions stay
  // '(not set)' forever. Both are expected, transient states, not bugs.
  const registeredDimsAllNotSet = [];
  for (const dim of NEW_CUSTOM_USER_DIMS) {
    if (!registration[dim].registered) continue;
    const arpuKey = `customUser:${dim}`;
    const arpuValues = (report.segmentedArpu?.rows || []).map((r) => r[arpuKey]);
    const ltvValues = (report.ltv?.slicedByCustomDim?.[dim]?.rows || []).map((r) => r[dim]);
    const allValues = [...arpuValues, ...ltvValues];
    const hasRealValue = allValues.some((v) => v && v !== '(not set)');
    if (allValues.length > 0 && !hasRealValue) {
      registeredDimsAllNotSet.push(dim);
    }
  }
  if (registeredDimsAllNotSet.length > 0) {
    report.warnings.push(
      `Registered-but-sparse: customUser:${registeredDimsAllNotSet.join(', customUser:')} ` +
      `${registeredDimsAllNotSet.length > 1 ? 'are' : 'is'} live in the GA4 Admin API (scope=USER) but every ` +
      `row in this run's segmented ARPU and LTV sections shows '(not set)' for ${registeredDimsAllNotSet.length > 1 ? 'them' : 'it'}. ` +
      'EXPECTED, not a bug: the client-side instrumentation that actually sets these user properties on real ' +
      'sessions is separate, in-flight sibling work, and GA4 does not backfill custom-dimension history for ' +
      'sessions that occurred before registration. Re-run this script after that instrumentation has been live ' +
      'for a few days to see real segment splits.'
    );
  }

  writeOutput(report);

  if (!flags.json) {
    renderConsoleSummary(report);
    log('✅', `Report saved: data/user-value-report.json`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(0);
}

function writeOutput(report) {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('user-value-report failed:', e.message);
  if (flags.debug) console.error(e.stack);
  process.exit(0);
});
