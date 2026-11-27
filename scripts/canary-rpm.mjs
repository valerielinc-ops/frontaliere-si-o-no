#!/usr/bin/env node
/**
 * canary-rpm.mjs — AdSense RPM and ad-request coverage canary.
 *
 * Reads settled daily data, compares RPM and earnings with a moving baseline,
 * and checks ad-request coverage against a fixed floor. The ratio check catches
 * sudden changes; the coverage check can detect a sustained decline. The
 * classifier is in scripts/lib/canaryRpmClassify.mjs.
 *
 * Authentication uses AdSense and Search Console OAuth credentials from
 * Firebase Remote Config. The current UTC day is excluded until its data settles.
 */

import process from "node:process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveAdSenseAccount } from "./lib/adsense-account.mjs";
import {
  classifyRpm,
  classifyCoverage,
  DEFAULT_COVERAGE_FLOOR,
  COVERAGE_SUSTAIN_DAYS,
} from "./lib/canaryRpmClassify.mjs";

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
const COVERAGE_FLOOR = parseFlag("coverage-floor", DEFAULT_COVERAGE_FLOOR);
const COVERAGE_SUSTAIN = parseFlag("coverage-sustain-days", COVERAGE_SUSTAIN_DAYS);

const log = (line) => {
  if (wantsJson) console.error(line);
  else console.log(line);
};

async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
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

export async function fetchDailyRpm({ fetchImpl = fetch, now = new Date() } = {}) {
  const refreshToken = process.env.ADSENSE_REFRESH_TOKEN;
  const clientId = process.env.ADSENSE_CLIENT_ID || process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.ADSENSE_CLIENT_SECRET || process.env.GSC_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("missing AdSense OAuth credentials (ADSENSE_REFRESH_TOKEN / *_CLIENT_ID / *_CLIENT_SECRET)");
  }
  const token = await refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl });
  const account = resolveAdSenseAccount();

  const end = new Date(now);
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
  // AD_REQUESTS_COVERAGE — fraction (0..1) of ad requests AdSense actually
  // filled. Feeds classifyCoverage(), the sustained-degradation check
  // (issue #4610) that is independent of the RPM/earnings moving baseline.
  params.append("metrics", "AD_REQUESTS_COVERAGE");
  params.append("dimensions", "DATE");

  const url = `https://adsense.googleapis.com/v2/${account}/reports:generate?${params}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`adsense daily ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = (data.rows || []).map((r) => ({
    date: r.cells[0]?.value || "",
    rpm: Number(r.cells[1]?.value ?? 0),
    earnings: Number(r.cells[2]?.value ?? 0),
    pageViews: Number(r.cells[3]?.value ?? 0),
    coverage: Number(r.cells[4]?.value ?? NaN),
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

    // Second, complementary check (issue #4610) — sustained coverage
    // degradation the moving RPM/earnings baseline can no longer see once
    // it has adapted to it. Additive: can flip a "healthy" RPM verdict to
    // failing, never silences a real RPM+earnings regression.
    const coverageResult = classifyCoverage(rows, {
      coverageFloor: COVERAGE_FLOOR,
      sustainDays: COVERAGE_SUSTAIN,
      todayUtc: fmtDate(new Date()),
    });
    result.coverage = coverageResult;
    if (coverageResult.verdict === "coverage-regression") {
      result.reasons = [...(result.reasons || []), ...coverageResult.reasons];
      if (result.verdict !== "regression") {
        result.verdict = "coverage-regression";
      }
    }
  } catch {
    console.error('[canary-rpm] auth/API failure; details withheld');
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
    if (result.coverage?.window) {
      log(`coverage ${result.coverage.window.from}..${result.coverage.window.to} (${result.coverage.window.days}d avg)=${(result.coverage.avgCoverage * 100).toFixed(0)}%   floor=${(COVERAGE_FLOOR * 100).toFixed(0)}%   verdict=${result.coverage.verdict}`);
    } else if (result.coverage?.verdict === "insufficient-data") {
      log(`  NOTE: coverage check skipped — ${result.coverage.reason}`);
    }
    for (const r of result.reasons || []) log(`  ALERT: ${r}`);
    if (result.note) log(`  NOTE: ${result.note}`);
  }
  if (result.verdict === "regression" || result.verdict === "coverage-regression") {
    const label =
      result.verdict === "regression"
        ? "RPM regression (RPM + earnings both below floor)"
        : `sustained low ad-request coverage (AD_REQUESTS_COVERAGE averaged below ${(COVERAGE_FLOOR * 100).toFixed(0)}% floor over the last ${COVERAGE_SUSTAIN} closed days)`;
    console.error(`\x1b[31m[canary-rpm]\x1b[0m FAIL — ${label}`);
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

if (process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})()) {
  main();
}
