#!/usr/bin/env node
/**
 * Frontaliere Ticino — Weekly Revenue Monitoring
 *
 * Compares the last 7 days of key revenue & SEO metrics against the
 * Apr 6-19 baseline captured after the 8 revenue optimizations shipped
 * in commit 6532f7063. Flags metrics that have regressed and surfaces
 * wins worth doubling down on.
 *
 * Metrics tracked:
 *   - AdSense:  revenue/day, RPM, desktop RPM, auth-gate impressions
 *   - GSC:      clicks/day, avg position, CTR by page bucket
 *   - PostHog:  CLS p75 (mobile / desktop) from $web_vitals events
 *
 * Auth (env, loaded via scripts/load-rc-env.mjs):
 *   GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN     (required for GSC)
 *   ADSENSE_REFRESH_TOKEN                                     (required for AdSense)
 *   ADSENSE_CLIENT_ID / ADSENSE_CLIENT_SECRET                 (optional; defaults to GSC_*)
 *   POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID             (optional; CLS section)
 *   POSTHOG_HOST                                              (optional; defaults to https://eu.posthog.com)
 *
 * Usage:
 *   node scripts/revenue-monitor.mjs                 # human table
 *   node scripts/revenue-monitor.mjs --json          # JSON payload
 *   node scripts/revenue-monitor.mjs --markdown      # GitHub-flavored markdown
 *   node scripts/revenue-monitor.mjs --save          # write reports/revenue-YYYY-MM-DD.{md,json}
 *
 * Exits 0 always — this is a monitor, not a gate. Regressions are flagged
 * with ⚠️ / 🔴 in the output so the weekly digest draws attention without
 * blocking CI.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_URL = 'https://frontaliereticino.ch';
const REPORTS_DIR = resolve(__dirname, '..', 'reports');

// ── Baseline captured Apr 6-19 2026 (see docs/revenue-optimization-remaining.md) ──
// CTR baselines by URL bucket derived from GSC 28-day query bucketed by path prefix
// on 2026-04-20 (see docs/seo-action-plan-apr20-parallel.md "SEO audit").
export const BASELINE = {
  period: '2026-04-06 → 2026-04-19',
  adsense: {
    revenuePerDayCHF: 0.87,
    rpmCHF: 0.91,
    desktopRpmCHF: 1.10,
    authGateImpressions14d: 1235,
  },
  gsc: {
    clicksPerDay: 323,
    avgPosition: 5.7,
    // CTR percentages per bucket (mean over Apr 6-19)
    ctrByBucket: {
      '/job-board/':             6.2,
      '/calcola-stipendio/':     4.8,
      '/articoli-frontaliere/':  3.1,
      '/fisco/':                 3.9,
      '/guida-frontaliere/':     3.5,
    },
  },
  posthog: {
    // CLS p75 baseline from PostHog $web_vitals (14d window 2026-04-06..19)
    clsP75Mobile:  0.51,
    clsP75Desktop: 0.18,
  },
};

// URL buckets for GSC CTR tracking. Matched as URL-contains on the page dimension.
export const GSC_BUCKETS = [
  '/job-board/',
  '/calcola-stipendio/',
  '/articoli-frontaliere/',
  '/fisco/',
  '/guida-frontaliere/',
];

// ── CLI ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  json: args.includes('--json'),
  markdown: args.includes('--markdown'),
  save: args.includes('--save'),
  debug: args.includes('--debug'),
};

const log = (emoji, msg) => {
  const line = emoji ? `${emoji} ${msg}` : msg;
  // Write status to stderr so --json / --markdown stdout stays machine-readable.
  if (flags.json || flags.markdown) console.error(line);
  else console.log(line);
};

// ── OAuth helpers ───────────────────────────────────────────
async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
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
  if (!res.ok) throw new Error(`token refresh ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function getGscToken() {
  const { GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN } = process.env;
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REFRESH_TOKEN) return null;
  return refreshAccessToken({
    clientId: GSC_CLIENT_ID,
    clientSecret: GSC_CLIENT_SECRET,
    refreshToken: GSC_REFRESH_TOKEN,
  });
}

async function getAdSenseToken() {
  const refreshToken = process.env.ADSENSE_REFRESH_TOKEN;
  if (!refreshToken) return null;
  const clientId = process.env.ADSENSE_CLIENT_ID || process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.ADSENSE_CLIENT_SECRET || process.env.GSC_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return refreshAccessToken({ clientId, clientSecret, refreshToken });
}

// ── Date helpers ────────────────────────────────────────────
const fmtDate = (d) => d.toISOString().slice(0, 10);
function last7Days() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // leave 2-day lag for late-arriving data
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { start: fmtDate(start), end: fmtDate(end) };
}

// ── AdSense (reports:generate) ──────────────────────────────
async function fetchAdSenseReport(token) {
  // 1. Discover the first AdSense account.
  const acctRes = await fetch('https://adsense.googleapis.com/v2/accounts', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!acctRes.ok) throw new Error(`adsense accounts ${acctRes.status}: ${await acctRes.text()}`);
  const acctData = await acctRes.json();
  const account = acctData.accounts?.[0]?.name;
  if (!account) throw new Error('No AdSense account available');

  const { start, end } = last7Days();

  // 2. Top-line totals (revenue, RPM, impressions) for the last 7 days.
  const params = new URLSearchParams();
  params.append('dateRange', 'CUSTOM');
  params.append('startDate.year', start.slice(0, 4));
  params.append('startDate.month', String(Number(start.slice(5, 7))));
  params.append('startDate.day', String(Number(start.slice(8, 10))));
  params.append('endDate.year', end.slice(0, 4));
  params.append('endDate.month', String(Number(end.slice(5, 7))));
  params.append('endDate.day', String(Number(end.slice(8, 10))));
  for (const m of ['ESTIMATED_EARNINGS', 'PAGE_VIEWS_RPM', 'IMPRESSIONS']) {
    params.append('metrics', m);
  }

  const totalsUrl = `https://adsense.googleapis.com/v2/${account}/reports:generate?${params}`;
  const totalsRes = await fetch(totalsUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!totalsRes.ok) throw new Error(`adsense totals ${totalsRes.status}: ${await totalsRes.text()}`);
  const totals = await totalsRes.json();
  const row = totals.rows?.[0]?.cells || [];
  const revenue = Number(row[0]?.value ?? 0);
  const rpm = Number(row[1]?.value ?? 0);
  const impressions = Number(row[2]?.value ?? 0);

  // 3. Desktop-only RPM via PLATFORM_TYPE_NAME dimension.
  const dtParams = new URLSearchParams(params);
  dtParams.append('dimensions', 'PLATFORM_TYPE_NAME');
  const dtUrl = `https://adsense.googleapis.com/v2/${account}/reports:generate?${dtParams}`;
  const dtRes = await fetch(dtUrl, { headers: { Authorization: `Bearer ${token}` } });
  let desktopRpm = null;
  if (dtRes.ok) {
    const dt = await dtRes.json();
    const desktop = (dt.rows || []).find((r) => {
      const dim = r.cells?.[0]?.value?.toLowerCase() || '';
      return dim.includes('desktop') || dim.includes('high-end');
    });
    if (desktop) desktopRpm = Number(desktop.cells?.[2]?.value ?? 0);
  }

  // 4. Auth-gate unit impressions via AD_UNIT_NAME dimension.
  const auParams = new URLSearchParams(params);
  auParams.append('dimensions', 'AD_UNIT_NAME');
  const auUrl = `https://adsense.googleapis.com/v2/${account}/reports:generate?${auParams}`;
  const auRes = await fetch(auUrl, { headers: { Authorization: `Bearer ${token}` } });
  let authGateImpressions = null;
  if (auRes.ok) {
    const au = await auRes.json();
    const gateRow = (au.rows || []).find((r) => {
      const name = r.cells?.[0]?.value?.toLowerCase() || '';
      return name.includes('authgate') || name.includes('auth_gate') || name.includes('jobdetail_auth');
    });
    if (gateRow) authGateImpressions = Number(gateRow.cells?.[3]?.value ?? 0);
  }

  return {
    account,
    window: { start, end },
    revenue7dCHF: Number(revenue.toFixed(2)),
    revenuePerDayCHF: Number((revenue / 7).toFixed(2)),
    rpmCHF: Number(rpm.toFixed(2)),
    desktopRpmCHF: desktopRpm !== null ? Number(desktopRpm.toFixed(2)) : null,
    impressions7d: impressions,
    authGateImpressions7d: authGateImpressions,
  };
}

// ── GSC (searchanalytics:query) ─────────────────────────────
async function gscQuery(token, body) {
  const site = `sc-domain:${new URL(SITE_URL).hostname}`;
  const encoded = encodeURIComponent(site);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return await res.json();
  // Fall back to URL-prefix property.
  const fallbackEncoded = encodeURIComponent(SITE_URL + '/');
  const fallbackUrl = `https://www.googleapis.com/webmasters/v3/sites/${fallbackEncoded}/searchAnalytics/query`;
  const r2 = await fetch(fallbackUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r2.ok) throw new Error(`gsc ${r2.status}: ${await r2.text()}`);
  return await r2.json();
}

async function fetchGscMetrics(token) {
  const { start, end } = last7Days();

  // Top-line totals
  const totals = await gscQuery(token, {
    startDate: start,
    endDate: end,
    dimensions: [],
    rowLimit: 1,
  });
  const totalsRow = totals.rows?.[0];
  const clicks = totalsRow?.clicks ?? 0;
  const position = totalsRow?.position ?? null;

  // CTR by page bucket — pull top 5000 pages and aggregate client-side.
  const byPage = await gscQuery(token, {
    startDate: start,
    endDate: end,
    dimensions: ['page'],
    rowLimit: 5000,
  });

  const ctrByBucket = bucketCtrFromRows(byPage.rows || [], GSC_BUCKETS);

  return {
    window: { start, end },
    clicks7d: clicks,
    clicksPerDay: Number((clicks / 7).toFixed(1)),
    avgPosition: position !== null ? Number(position.toFixed(2)) : null,
    ctrByBucket,
  };
}

/**
 * Bucket GSC rows (dimension=page) into CTR % per URL prefix.
 * Pure function — exported for unit testing.
 */
export function bucketCtrFromRows(rows, buckets) {
  const acc = Object.fromEntries(buckets.map((b) => [b, { clicks: 0, impressions: 0 }]));
  for (const row of rows) {
    const page = row.keys?.[0] || '';
    for (const b of buckets) {
      if (page.includes(b)) {
        acc[b].clicks += row.clicks || 0;
        acc[b].impressions += row.impressions || 0;
        break; // first matching bucket wins (buckets are disjoint by design)
      }
    }
  }
  const result = {};
  for (const b of buckets) {
    const { clicks, impressions } = acc[b];
    result[b] = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : null;
  }
  return result;
}

// ── PostHog (HogQL via REST API) ────────────────────────────
/**
 * Query PostHog CLS p75 for the last 7 days, split by device type.
 * Returns { clsP75Mobile, clsP75Desktop, window } or null if unauthenticated.
 *
 * HogQL schema: $web_vitals events with properties.$web_vitals_CLS_value
 * (numeric) and properties.$device_type ('Mobile' | 'Desktop' | 'Tablet').
 */
export async function fetchPostHogCls({ apiKey, projectId, host = 'https://eu.posthog.com', fetchImpl = fetch } = {}) {
  if (!apiKey || !projectId) return null;
  const { start, end } = last7Days();
  const url = `${host.replace(/\/$/, '')}/api/projects/${projectId}/query/`;

  const runQuery = async (deviceType) => {
    const hogql = `
      SELECT quantile(0.75)(toFloat(properties.$web_vitals_CLS_value)) AS cls_p75
      FROM events
      WHERE event = '$web_vitals'
        AND properties.$device_type = '${deviceType}'
        AND properties.$web_vitals_CLS_value IS NOT NULL
        AND timestamp >= toDateTime('${start} 00:00:00')
        AND timestamp <= toDateTime('${end} 23:59:59')
    `.trim();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    });
    if (!res.ok) {
      throw new Error(`posthog ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    // results is array-of-rows; each row is array-of-columns
    const raw = data?.results?.[0]?.[0];
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Number(n.toFixed(3)) : null;
  };

  const [mobile, desktop] = await Promise.all([runQuery('Mobile'), runQuery('Desktop')]);

  return {
    window: { start, end },
    clsP75Mobile: mobile,
    clsP75Desktop: desktop,
  };
}

// ── Comparison ──────────────────────────────────────────────
/**
 * Compare a current value against a baseline, returning delta, percentage,
 * and a verdict flag. Pure function — exported for tests.
 *
 * @param current  number|null
 * @param baseline number|null
 * @param opts.higherIsBetter boolean (default true)
 * @param opts.warnThresholdFrac fraction that triggers ⚠️ (default 0.10)
 * @param opts.failThresholdFrac fraction that triggers 🔴 (default 0.20)
 */
export function compare(current, baseline, { higherIsBetter = true, warnThresholdFrac = 0.10, failThresholdFrac = 0.20 } = {}) {
  if (current === null || current === undefined || baseline === null || baseline === undefined) {
    return { delta: null, deltaPct: null, verdict: '⚪ n/a' };
  }
  const delta = Number((current - baseline).toFixed(3));
  const deltaPct = baseline === 0 ? null : Number(((delta / baseline) * 100).toFixed(1));
  let verdict = '✅ flat';
  if (deltaPct !== null) {
    const warnPct = warnThresholdFrac * 100;
    const failPct = failThresholdFrac * 100;
    const improved = higherIsBetter ? deltaPct > warnPct : deltaPct < -warnPct;
    const regressed = higherIsBetter ? deltaPct < -warnPct : deltaPct > warnPct;
    const severeRegression = higherIsBetter ? deltaPct < -failPct : deltaPct > failPct;
    if (severeRegression) verdict = '🔴 regressed hard';
    else if (regressed) verdict = '⚠️ regressed';
    else if (improved) verdict = '📈 improved';
  }
  return { delta, deltaPct, verdict };
}

export function buildComparisonRows(current, baseline = BASELINE) {
  const rows = [];
  const adsense = current.adsense;
  const gsc = current.gsc;
  const posthog = current.posthog;
  const b = baseline;

  if (adsense) {
    rows.push({ metric: 'AdSense revenue / day (CHF)', baseline: b.adsense.revenuePerDayCHF, current: adsense.revenuePerDayCHF, ...compare(adsense.revenuePerDayCHF, b.adsense.revenuePerDayCHF) });
    rows.push({ metric: 'AdSense RPM (CHF)', baseline: b.adsense.rpmCHF, current: adsense.rpmCHF, ...compare(adsense.rpmCHF, b.adsense.rpmCHF) });
    rows.push({ metric: 'AdSense desktop RPM (CHF)', baseline: b.adsense.desktopRpmCHF, current: adsense.desktopRpmCHF, ...compare(adsense.desktopRpmCHF, b.adsense.desktopRpmCHF) });
    const gateCurrent7d = adsense.authGateImpressions7d;
    const gateBaseline7d = Math.round(b.adsense.authGateImpressions14d / 2);
    rows.push({ metric: 'Auth-gate impressions (7d)', baseline: gateBaseline7d, current: gateCurrent7d, ...compare(gateCurrent7d, gateBaseline7d) });
  } else {
    rows.push({ metric: 'AdSense metrics', baseline: '—', current: 'skipped', delta: null, deltaPct: null, verdict: '⚪ auth missing' });
  }

  if (gsc) {
    rows.push({ metric: 'GSC clicks / day', baseline: b.gsc.clicksPerDay, current: gsc.clicksPerDay, ...compare(gsc.clicksPerDay, b.gsc.clicksPerDay) });
    rows.push({ metric: 'GSC avg position', baseline: b.gsc.avgPosition, current: gsc.avgPosition, ...compare(gsc.avgPosition, b.gsc.avgPosition, { higherIsBetter: false }) });
    if (gsc.ctrByBucket) {
      for (const bucket of GSC_BUCKETS) {
        const baselineCtr = b.gsc.ctrByBucket?.[bucket] ?? null;
        const currentCtr = gsc.ctrByBucket[bucket] ?? null;
        rows.push({
          metric: `GSC CTR ${bucket} (%)`,
          baseline: baselineCtr,
          current: currentCtr,
          ...compare(currentCtr, baselineCtr),
        });
      }
    }
  } else {
    rows.push({ metric: 'GSC metrics', baseline: '—', current: 'skipped', delta: null, deltaPct: null, verdict: '⚪ auth missing' });
  }

  if (posthog) {
    // Lower is better for CLS.
    rows.push({ metric: 'CLS p75 mobile', baseline: b.posthog.clsP75Mobile, current: posthog.clsP75Mobile, ...compare(posthog.clsP75Mobile, b.posthog.clsP75Mobile, { higherIsBetter: false }) });
    rows.push({ metric: 'CLS p75 desktop', baseline: b.posthog.clsP75Desktop, current: posthog.clsP75Desktop, ...compare(posthog.clsP75Desktop, b.posthog.clsP75Desktop, { higherIsBetter: false }) });
  } else {
    rows.push({ metric: 'PostHog CLS', baseline: '—', current: 'skipped', delta: null, deltaPct: null, verdict: '⚪ auth missing' });
  }

  return rows;
}

// ── Rendering ───────────────────────────────────────────────
function renderTable(rows) {
  const data = rows.map((r) => ({
    metric: r.metric,
    baseline: r.baseline ?? '—',
    current: r.current ?? '—',
    'Δ': r.delta ?? '—',
    'Δ%': r.deltaPct !== null && r.deltaPct !== undefined ? `${r.deltaPct}%` : '—',
    verdict: r.verdict,
  }));
  console.table(data);
}

export function renderMarkdown(rows, current, baseline = BASELINE) {
  const lines = [];
  lines.push(`# Revenue monitor — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  const anyWindow = current.adsense?.window || current.gsc?.window || current.posthog?.window;
  lines.push(`Window: ${anyWindow?.start || 'n/a'} → ${anyWindow?.end || 'n/a'}`);
  lines.push(`Baseline: ${baseline.period}`);
  lines.push('');
  lines.push('| Metric | Baseline | Current | Δ | Δ% | Verdict |');
  lines.push('|--------|---------:|--------:|--:|---:|:--------|');
  for (const r of rows) {
    const d = r.delta !== null && r.delta !== undefined ? r.delta : '—';
    const p = r.deltaPct !== null && r.deltaPct !== undefined ? `${r.deltaPct}%` : '—';
    lines.push(`| ${r.metric} | ${r.baseline ?? '—'} | ${r.current ?? '—'} | ${d} | ${p} | ${r.verdict} |`);
  }
  lines.push('');
  const regressions = rows.filter((r) => r.verdict.startsWith('🔴') || r.verdict.startsWith('⚠️'));
  if (regressions.length) {
    lines.push('## Regressions');
    for (const r of regressions) lines.push(`- ${r.verdict} **${r.metric}** — ${r.current} vs baseline ${r.baseline} (${r.deltaPct}%)`);
  } else {
    lines.push('## All metrics healthy — no regressions flagged.');
  }
  if (current.warnings?.length) {
    lines.push('');
    lines.push('## Warnings');
    for (const w of current.warnings) lines.push(`- ⚠️ ${w}`);
  }
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const current = { adsense: null, gsc: null, posthog: null, errors: [], warnings: [] };

  try {
    const adsenseToken = await getAdSenseToken();
    if (adsenseToken) current.adsense = await fetchAdSenseReport(adsenseToken);
    else log('⚪', 'AdSense skipped (ADSENSE_REFRESH_TOKEN not set)');
  } catch (e) {
    current.errors.push(`adsense: ${e.message}`);
    log('⚠️', `AdSense failed: ${e.message}`);
  }

  try {
    const gscToken = await getGscToken();
    if (gscToken) current.gsc = await fetchGscMetrics(gscToken);
    else log('⚪', 'GSC skipped (GSC_REFRESH_TOKEN not set)');
  } catch (e) {
    current.errors.push(`gsc: ${e.message}`);
    log('⚠️', `GSC failed: ${e.message}`);
  }

  // PostHog CLS is optional: if credentials missing, surface a warning instead
  // of failing. Required secrets are POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID
  // (add in repo Settings → Secrets or Firebase Remote Config).
  try {
    const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
    const projectId = process.env.POSTHOG_PROJECT_ID;
    const host = process.env.POSTHOG_HOST;
    if (apiKey && projectId) {
      current.posthog = await fetchPostHogCls({ apiKey, projectId, host });
    } else {
      const msg = 'PostHog CLS skipped (POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set)';
      current.warnings.push(msg);
      log('⚪', msg);
    }
  } catch (e) {
    current.errors.push(`posthog: ${e.message}`);
    current.warnings.push(`PostHog CLS query failed: ${e.message}`);
    log('⚠️', `PostHog failed: ${e.message}`);
  }

  const rows = buildComparisonRows(current);
  const payload = { generatedAt: new Date().toISOString(), baseline: BASELINE, current, rows };

  if (flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else if (flags.markdown) {
    process.stdout.write(renderMarkdown(rows, current) + '\n');
  } else {
    log('📊', `Revenue monitor — last 7 days vs baseline ${BASELINE.period}`);
    renderTable(rows);
    const regressions = rows.filter((r) => r.verdict.startsWith('🔴') || r.verdict.startsWith('⚠️'));
    if (regressions.length) log('⚠️', `${regressions.length} metric(s) regressed — see verdict column`);
    else log('✅', 'No regressions flagged');
  }

  if (flags.save) {
    if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(resolve(REPORTS_DIR, `revenue-${stamp}.json`), JSON.stringify(payload, null, 2));
    writeFileSync(resolve(REPORTS_DIR, `revenue-${stamp}.md`), renderMarkdown(rows, current));
    log('💾', `reports/revenue-${stamp}.{json,md} written`);
  }
}

// Only run main() when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error('revenue-monitor failed:', e.message);
    if (flags.debug) console.error(e.stack);
    process.exit(0);
  });
}
