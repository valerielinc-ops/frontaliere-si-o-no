#!/usr/bin/env node
/**
 * canary-rpm.mjs — AdSense RPM crash detector.
 *
 * Pulls daily AdSense PAGE_VIEWS_RPM for the last 14 days, computes a
 * trailing 7-day baseline (days T-9..T-3), compares the latest fully-closed
 * day against it, and exits non-zero only when BOTH hold:
 *   - the RPM signal fires — RPM below `--ratio-floor` × baseline
 *     (default 0.65) OR below `--absolute-floor` CHF (default 1.0), AND
 *   - earnings confirm it — current-day earnings below `--earnings-floor`
 *     × baseline earnings (default 0.65).
 *
 * The earnings gate exists because RPM is a ratio (earnings ÷ page views):
 * a page-view spike with healthy earnings halves RPM without losing a
 * cent (issue #2176, 2026-06-15..17 — earnings ~5.5 CHF/day while PV
 * spiked to 3625, so RPM "crashed" to 1.51 with zero lost revenue). A
 * REAL incident collapses earnings, so gating on earnings keeps the catch
 * while silencing benign traffic spikes. The classification (and the
 * "never measure the still-open current UTC day" rule) lives in the
 * unit-tested lib scripts/lib/canaryRpmClassify.mjs.
 *
 * Why exists: incident 2026-05-28 — AdSense RPM crashed 3.04 → 1.74
 * CHF/day in 48h because ~2,540 of ~2,607 articles started serving a
 * 1.7 KB infinite-redirect stub (no SPA bundle, no ad slots) — earnings
 * cratered alongside RPM, so the earnings gate still fires. The
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
 *   node scripts/canary-rpm.mjs --ratio-floor=0.7 --absolute-floor=1.5 --earnings-floor=0.6
 */

import process from "node:process";
import { classifyRpm } from "./lib/canaryRpmClassify.mjs";

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
const EARNINGS_FLOOR = parseFlag("earnings-floor", 0.65);

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

async function main() {
  let result;
  try {
    const { account, rows } = await fetchDailyRpm();
    log(`[canary-rpm] account=${account}, ${rows.length} daily rows`);
    result = classifyRpm(rows, {
      ratioFloor: RATIO_FLOOR,
      absoluteFloor: ABSOLUTE_FLOOR,
      earningsFloor: EARNINGS_FLOOR,
      todayUtc: fmtDate(new Date()),
    });
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
      log(`RPM ratio=${(result.ratio * 100).toFixed(0)}%   earnings ratio=${((result.earningsRatio || 0) * 100).toFixed(0)}%   floors: rpm=${(RATIO_FLOOR * 100).toFixed(0)}%, absolute=${ABSOLUTE_FLOOR.toFixed(2)} CHF, earnings=${(EARNINGS_FLOOR * 100).toFixed(0)}%`);
    }
    for (const r of result.reasons || []) log(`  ALERT: ${r}`);
    if (result.note) log(`  NOTE: ${result.note}`);
  }
  if (result.verdict === "regression") {
    console.error(`\x1b[31m[canary-rpm]\x1b[0m FAIL — RPM regression (RPM + earnings both below floor)`);
    process.exit(1);
  }
  if (result.verdict === "insufficient-data") {
    console.error(`\x1b[33m[canary-rpm]\x1b[0m SKIP — ${result.reason}`);
    process.exit(0);
  }
  // Use stderr so --json keeps stdout as pure parseable JSON.
  console.error(
    result.note
      ? `\x1b[32m[canary-rpm]\x1b[0m PASS — RPM dip is benign (earnings healthy)`
      : `\x1b[32m[canary-rpm]\x1b[0m PASS — RPM healthy`,
  );
  process.exit(0);
}

main();
