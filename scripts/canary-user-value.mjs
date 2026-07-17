#!/usr/bin/env node
/**
 * canary-user-value.mjs — user-value (ARPU) crash detector.
 *
 * Pulls daily GA4 `totalAdRevenue`/`activeUsers` for the last 17 days,
 * computes ARPU = revenue / activeUsers per day, and compares the latest
 * fully-closed day against a trailing 7-day baseline (days T-9..T-3).
 * Exits non-zero only when BOTH hold:
 *   - ARPU signal fires — ARPU below `--ratio-floor` × baseline (default
 *     0.65) OR below `--absolute-floor` EUR (default 0, i.e. disabled —
 *     see scripts/lib/arpuCanaryClassify.mjs for why), AND
 *   - revenue confirms — current-day revenue below `--revenue-floor` ×
 *     baseline revenue (default 0.65).
 *
 * The revenue gate exists because ARPU is a ratio (revenue ÷ activeUsers):
 * an active-user spike with healthy revenue halves ARPU without losing a
 * cent — the same false-alarm shape the AdSense RPM canary's earnings gate
 * was built to silence (scripts/canary-rpm.mjs, issue #2176). Classification
 * (and the "never measure the still-open current UTC day" rule) lives in
 * the unit-tested lib scripts/lib/arpuCanaryClassify.mjs, itself a thin
 * wrapper over the same shared core the RPM canary uses
 * (scripts/lib/canaryRegressionClassify.mjs).
 *
 * Auth: same 3-legged OAuth2 pattern as scripts/user-value-report.mjs and
 * scripts/canary-rpm.mjs (load via scripts/load-rc-env.mjs in CI, or:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs)"
 * ):
 *   GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN — OAuth2,
 *   analytics.readonly scope (same token scripts/user-value-report.mjs uses).
 *   GA4_PROPERTY_ID — GA4 property to query.
 *
 * Usage:
 *   node scripts/canary-user-value.mjs
 *   node scripts/canary-user-value.mjs --json
 *   node scripts/canary-user-value.mjs --ratio-floor=0.7 --absolute-floor=0.005 --revenue-floor=0.6
 */
import process from 'node:process';
import { classifyArpu } from './lib/arpuCanaryClassify.mjs';
import { DEFAULT_GA4_PROPERTY_ID } from './lib/ga4-service-account.mjs';

const args = process.argv.slice(2);
const wantsJson = args.includes('--json');

const parseFlag = (name, fallback) => {
  const f = args.find((a) => a.startsWith(`--${name}=`));
  if (!f) return fallback;
  const n = Number.parseFloat(f.slice(`--${name}=`.length));
  return Number.isFinite(n) ? n : fallback;
};

const RATIO_FLOOR = parseFlag('ratio-floor', 0.65);
const ABSOLUTE_FLOOR = parseFlag('absolute-floor', 0);
const REVENUE_FLOOR = parseFlag('revenue-floor', 0.65);
const LOOKBACK_DAYS = Math.round(parseFlag('lookback-days', 17));

const log = (line) => {
  if (wantsJson) console.error(line);
  else console.log(line);
};

// ── Auth (same pattern as scripts/user-value-report.mjs / scripts/canary-rpm.mjs) ──
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

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// GA4's `date` dimension returns YYYYMMDD with no separators.
function toIsoDate(ga4Date) {
  return `${ga4Date.slice(0, 4)}-${ga4Date.slice(4, 6)}-${ga4Date.slice(6, 8)}`;
}

async function fetchDailyArpu() {
  const propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  const token = await getAccessToken();
  if (!token) throw new Error('GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN not configured');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      dateRanges: [{ startDate: `${LOOKBACK_DAYS}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'totalAdRevenue' }, { name: 'activeUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: LOOKBACK_DAYS + 2,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GA4 runReport ${res.status}: ${body?.error?.message || res.statusText}`);
  }
  const data = await res.json();
  const rows = (data.rows || [])
    .map((r) => {
      const revenue = Number(r.metricValues?.[0]?.value || 0);
      const activeUsers = Number(r.metricValues?.[1]?.value || 0);
      return {
        date: toIsoDate(r.dimensionValues?.[0]?.value || ''),
        revenue,
        activeUsers,
        arpu: activeUsers > 0 ? revenue / activeUsers : 0,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return { propertyId, rows };
}

async function main() {
  let result;
  try {
    const { propertyId, rows } = await fetchDailyArpu();
    log(`[canary-user-value] property=${propertyId}, ${rows.length} daily rows`);
    result = classifyArpu(rows, {
      ratioFloor: RATIO_FLOOR,
      absoluteFloor: ABSOLUTE_FLOOR,
      revenueFloor: REVENUE_FLOOR,
      todayUtc: fmtDate(new Date()),
    });
    result.propertyId = propertyId;
    result.rows = rows;
  } catch (err) {
    console.error(`[canary-user-value] auth/API failure: ${err.message || err}`);
    process.exit(2);
  }
  result.timestamp = new Date().toISOString();

  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log('');
    log(`verdict=${result.verdict}`);
    if (result.current) {
      log(
        `current: ${result.current.date} ARPU=${result.current.arpu.toFixed(4)} revenue=${result.current.revenue.toFixed(2)} activeUsers=${result.current.activeUsers}`,
      );
    }
    if (result.baseline) {
      log(
        `baseline ${result.baseline.from}..${result.baseline.to}: ARPU=${result.baseline.arpu.toFixed(4)} revenue=${result.baseline.revenue.toFixed(2)} (${result.baseline.samples} samples)`,
      );
      log(
        `ARPU ratio=${(result.ratio * 100).toFixed(0)}% revenue ratio=${((result.revenueRatio || 0) * 100).toFixed(0)}% floors: ratio=${(RATIO_FLOOR * 100).toFixed(0)}%, absolute=${ABSOLUTE_FLOOR.toFixed(4)} EUR, revenue=${(REVENUE_FLOOR * 100).toFixed(0)}%`,
      );
      for (const r of result.reasons || []) log(`  ALERT: ${r}`);
      if (result.note) log(`  NOTE: ${result.note}`);
    }
    if (result.verdict === 'insufficient-data') log(`reason: ${result.reason}`);
  }

  process.exit(result.verdict === 'regression' ? 1 : 0);
}

main();
