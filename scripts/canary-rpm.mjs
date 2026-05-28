#!/usr/bin/env node
/**
 * canary-rpm.mjs — AdSense RPM crash detector.
 *
 * Pulls daily AdSense PAGE_VIEWS_RPM for the last 14 days, computes a
 * trailing 7-day baseline (days T-10..T-4), compares yesterday (T-1)
 * against it, and exits non-zero if yesterday's RPM is below either of:
 *   - `--ratio-floor` × baseline (default 0.65 → alert when RPM < 65% of baseline)
 *   - `--absolute-floor` CHF (default 1.0 CHF, regardless of baseline)
 *
 * Why exists: incident 2026-05-28 — AdSense RPM crashed 3.04 → 1.74
 * CHF/day in 48h because ~2,540 of ~2,607 articles started serving a
 * 1.7 KB infinite-redirect stub (no SPA bundle, no ad slots). The
 * upstream cause is caught at dist-time by `audit:no-dotfile-html` and
 * at content-time by `article-content-canary.yml`. This RPM canary is
 * the LAST line of defense: catches ANY revenue-affecting regression
 * (article stubs, AdSense policy hit, ad slot misconfig, ads.txt
 * issues, demand-side market drops) within ~24h of impact by watching
 * the EFFECT (revenue) rather than any particular CAUSE.
 *
 * Auth: same as scripts/revenue-monitor.mjs — uses ADSENSE_REFRESH_TOKEN
 * + GSC_CLIENT_ID/SECRET (the OAuth client is shared with GSC), loaded
 * from Firebase Remote Config via scripts/load-rc-env.mjs.
 *
 * Exit codes:
 *   0 — RPM is healthy (above all thresholds, or insufficient data)
 *   1 — RPM regression detected; details on stdout (JSON when --json)
 *   2 — Auth / API failure (do not treat as a real regression)
 *
 * Usage:
 *   node scripts/canary-rpm.mjs
 *   node scripts/canary-rpm.mjs --json
 *   node scripts/canary-rpm.mjs --ratio-floor=0.7 --absolute-floor=1.5
 */

import process from "node:process";

const args = process.argv.slice(2);
const wantsJson = args.includes("--json");
const parseFlag = (name, fallback) => {
  const f = args.find((a) => a.startsWith(`--${name}=`));
  if (!f) return fallback;
  const n = Number.parseFloat(f.slice(`--${name}=`.length));
  return Number.isFinite(n) ? n : fallback;
};

const RATIO_FLOOR = parseFlag("ratio-floor", 0.65);
const ABSOLUTE_FLOOR = parseFlag("absolute-floor", 1.0);
const BASELINE_DAYS = 7;
const BASELINE_LAG_DAYS = 3; // baseline ends at T-4 (skips noisy last 3 days)
const REQUIRED_BASELINE_SAMPLES = 5; // need at least 5 days of baseline data

const log = (line) => {
  if (wantsJson) console.error(line);
  else console.log(line);
};

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchDailyRpm() {
  const refreshToken = process.env.ADSENSE_REFRESH_TOKEN;
  const clientId = process.env.ADSENSE_CLIENT_ID || process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.ADSENSE_CLIENT_SECRET || process.env.GSC_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("missing AdSense OAuth credentials (ADSENSE_REFRESH_TOKEN / *_CLIENT_ID / *_CLIENT_SECRET)");
  }
  const token = await refreshAccessToken({ clientId, clientSecret, refreshToken });
  const acctRes = await fetch("https://adsense.googleapis.com/v2/accounts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!acctRes.ok) throw new Error(`adsense accounts ${acctRes.status}: ${await acctRes.text()}`);
  const acctData = await acctRes.json();
  const account = acctData.accounts?.[0]?.name;
  if (!account) throw new Error("no AdSense account on this token");

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 14);
  const startStr = fmtDate(start);
  const endStr = fmtDate(end);

  const params = new URLSearchParams();
  params.append("dateRange", "CUSTOM");
  params.append("startDate.year", startStr.slice(0, 4));
  params.append("startDate.month", String(Number(startStr.slice(5, 7))));
  params.append("startDate.day", String(Number(startStr.slice(8, 10))));
  params.append("endDate.year", endStr.slice(0, 4));
  params.append("endDate.month", String(Number(endStr.slice(5, 7))));
  params.append("endDate.day", String(Number(endStr.slice(8, 10))));
  params.append("metrics", "PAGE_VIEWS_RPM");
  params.append("metrics", "ESTIMATED_EARNINGS");
  params.append("metrics", "PAGE_VIEWS");
  params.append("dimensions", "DATE");

  const url = `https://adsense.googleapis.com/v2/${account}/reports:generate?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`adsense daily ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = (data.rows || []).map((r) => ({
    date: r.cells[0]?.value || "",
    rpm: Number(r.cells[1]?.value ?? 0),
    earnings: Number(r.cells[2]?.value ?? 0),
    pageViews: Number(r.cells[3]?.value ?? 0),
  }));
  // Defensive sort by date ascending (the API does this but don't assume).
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { account, rows };
}

function classify(rows) {
  if (rows.length < BASELINE_LAG_DAYS + REQUIRED_BASELINE_SAMPLES) {
    return {
      verdict: "insufficient-data",
      reason: `need ≥${BASELINE_LAG_DAYS + REQUIRED_BASELINE_SAMPLES} days of data, got ${rows.length}`,
    };
  }
  // Latest fully-closed day = the most recent row whose pageViews looks
  // "complete" (≥ 60% of the prior day's PV). AdSense daily data is
  // sometimes truncated for the current UTC day until ~10am UTC the next
  // day, so we drop trailing rows whose PV looks incomplete.
  let latestClosedIdx = rows.length - 1;
  if (rows.length >= 2) {
    const prior = rows[rows.length - 2].pageViews;
    const last = rows[rows.length - 1].pageViews;
    if (prior > 0 && last < prior * 0.5) {
      // The last row is probably still being collected — skip it.
      latestClosedIdx = rows.length - 2;
    }
  }
  const currentRow = rows[latestClosedIdx];
  const baselineEnd = latestClosedIdx - (BASELINE_LAG_DAYS - 1);
  const baselineStart = baselineEnd - BASELINE_DAYS;
  if (baselineStart < 0 || baselineEnd <= baselineStart) {
    return { verdict: "insufficient-data", reason: "baseline window underflowed" };
  }
  const baselineRows = rows.slice(baselineStart, baselineEnd);
  if (baselineRows.length < REQUIRED_BASELINE_SAMPLES) {
    return {
      verdict: "insufficient-data",
      reason: `baseline window has ${baselineRows.length} samples, need ${REQUIRED_BASELINE_SAMPLES}`,
    };
  }
  const baselineRpm =
    baselineRows.reduce((s, r) => s + (r.rpm || 0), 0) / baselineRows.length;
  const baselineEarnings =
    baselineRows.reduce((s, r) => s + (r.earnings || 0), 0) / baselineRows.length;
  const ratio = baselineRpm > 0 ? currentRow.rpm / baselineRpm : 1;

  const reasons = [];
  if (currentRow.rpm < ABSOLUTE_FLOOR) {
    reasons.push(`RPM ${currentRow.rpm.toFixed(2)} < absolute floor ${ABSOLUTE_FLOOR.toFixed(2)}`);
  }
  if (baselineRpm > 0 && ratio < RATIO_FLOOR) {
    reasons.push(
      `RPM ${currentRow.rpm.toFixed(2)} = ${(ratio * 100).toFixed(0)}% of baseline ${baselineRpm.toFixed(2)} (floor ${(RATIO_FLOOR * 100).toFixed(0)}%)`,
    );
  }
  return {
    verdict: reasons.length > 0 ? "regression" : "healthy",
    current: { date: currentRow.date, rpm: currentRow.rpm, earnings: currentRow.earnings, pageViews: currentRow.pageViews },
    baseline: {
      from: baselineRows[0].date,
      to: baselineRows[baselineRows.length - 1].date,
      rpm: Number(baselineRpm.toFixed(3)),
      earnings: Number(baselineEarnings.toFixed(2)),
      samples: baselineRows.length,
    },
    ratio: Number((ratio || 0).toFixed(3)),
    floors: { ratio: RATIO_FLOOR, absoluteCHF: ABSOLUTE_FLOOR },
    reasons,
  };
}

async function main() {
  let result;
  try {
    const { account, rows } = await fetchDailyRpm();
    log(`[canary-rpm] account=${account}, ${rows.length} daily rows`);
    result = classify(rows);
    result.account = account;
    result.rows = rows;
  } catch (err) {
    console.error(`[canary-rpm] auth/API failure: ${err.message || err}`);
    process.exit(2);
  }
  result.timestamp = new Date().toISOString();
  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log("");
    log(`verdict=${result.verdict}`);
    if (result.current) {
      log(`current: ${result.current.date} RPM=${result.current.rpm.toFixed(2)} earnings=${result.current.earnings.toFixed(2)} pv=${result.current.pageViews}`);
    }
    if (result.baseline) {
      log(`baseline ${result.baseline.from}..${result.baseline.to}: RPM=${result.baseline.rpm.toFixed(2)} earnings=${result.baseline.earnings.toFixed(2)} (${result.baseline.samples} samples)`);
      log(`ratio=${(result.ratio * 100).toFixed(0)}%   floors: ratio=${(RATIO_FLOOR * 100).toFixed(0)}%, absolute=${ABSOLUTE_FLOOR.toFixed(2)} CHF`);
    }
    for (const r of result.reasons || []) log(`  ALERT: ${r}`);
  }
  if (result.verdict === "regression") {
    console.error(`\x1b[31m[canary-rpm]\x1b[0m FAIL — RPM regression`);
    process.exit(1);
  }
  if (result.verdict === "insufficient-data") {
    console.error(`\x1b[33m[canary-rpm]\x1b[0m SKIP — ${result.reason}`);
    process.exit(0);
  }
  console.log(`\x1b[32m[canary-rpm]\x1b[0m PASS — RPM healthy`);
  process.exit(0);
}

main();
