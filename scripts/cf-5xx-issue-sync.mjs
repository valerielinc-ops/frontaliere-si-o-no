#!/usr/bin/env node
/**
 * cf-5xx-issue-sync.mjs — zone-wide Cloudflare 5xx watchdog.
 *
 * Shells out to the existing scripts/cf-status-report.mjs (--json --class=5
 * --by-hour) instead of re-implementing the GraphQL query (AGENTS.md #6 — no
 * duplicated CF-analytics construct; the query already lives in
 * scripts/lib/cf-analytics.mjs and cf-status-report.mjs), then opens/dedupes
 * GitHub issues for paths that are STILL failing.
 *
 * ─── Why "still" is load-bearing (#5231 / #5232) ───────────────────────────
 * This feeder used to select on one number: a path's 5xx TOTAL over a trailing
 * 23h window, `>= MIN_COUNT`. That window has no time resolution, so it cannot
 * distinguish an ongoing outage from a blip that ended yesterday afternoon —
 * and the docblock's own claim of "sustained 5xx volume" was never actually
 * tested by anything.
 *
 * Measured on 2026-08-06: issues #5231 (`vendor-fdb-auth.js`, 24) and #5232
 * (`borderWaitFormat.js`, 21) were filed at 06:18Z. Re-queried at minute
 * resolution, all 24 fell inside the single minute 2026-08-05T16:03Z and all
 * 21 inside 2026-08-05T15:41Z. Zero 5xx in every one of the ~14 hours between
 * the burst and the issue; both URLs served 200/HIT on inspection; each URL's
 * own 5xx rate over the window was ~0.1% (24/22,387 and 21/22,577).
 *
 * The threshold also selected the WRONG thing. `i18n.js` failed by the same
 * mechanism in the same window (18:00Z) but only 2 requests happened to land in
 * its bad minute, so it stayed silent. What crossed MIN_COUNT was not severity
 * — it was how popular the asset happened to be during its unlucky minute.
 *
 * So the feeder now reads `detailByHour` and drops entries whose most recent
 * 5xx is older than CF_5XX_MAX_AGE_HOURS. This is the same call
 * `isSelfHealedPage404` already makes for stale GA4 404s in
 * scripts/lib/error-issue-sync.mjs — a URL that is not failing now is not a
 * live defect — and it cannot mask a real outage, because an outage that is
 * still happening has an age of 0 hours.
 *
 * FAILS OPEN, LOUDLY: if the hourly rows are missing (older report build, CF
 * dropping the dimension), every entry is kept and a warning is printed. A
 * silent fail-open would restore the old behaviour with no way to notice.
 *
 * Env:
 *   CF_5XX_HOURS          trailing window, hours (default 23)
 *   CF_5XX_MIN_COUNT      minimum 5xx in the window to consider (default 20)
 *   CF_5XX_MAX_AGE_HOURS  drop entries whose last 5xx is older than this
 *                         (default 2; set 0 to disable the recency gate)
 *   CF_5XX_MAX_ISSUES     cap on issues opened per run (default 5)
 *
 * Complements production-canary.yml, which probes a FIXED list of known URLs
 * every 15min — this catches 5xx on ANY path across the whole zone (unknown
 * routes, CDN asset paths, locale-router shards) that the fixed probe list
 * doesn't cover.
 *
 * Report-only source: a CF API failure logs and exits 0 rather than failing
 * the workflow — this is a backlog feeder, not a gate.
 *
 * Low-traffic-URL isolated 5xx blips correlated with deploy-run churn are a
 * KNOWN, now-mitigated class (9 issues #3446→#4834, root-caused + fixed
 * 2026-07-28 by enabling the zone's `always_online` setting — see
 * docs/AGENTS-HISTORY.md#cloudflare-5xx-deploy-churn). Don't re-diagnose a
 * new occurrence as the same unfixable noise — check `always_online` is
 * still `on` first; a recurrence with it on is a genuinely new signal.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sanitizeUrlLikeText } from './lib/sanitizeTrackedDiagnostics.mjs';
import { syncErrorIssues } from './lib/error-issue-sync.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';

const HOURS = process.env.CF_5XX_HOURS || '23';
const MIN_COUNT = intFromEnv('CF_5XX_MIN_COUNT', 20);
const MAX_ISSUES = intFromEnv('CF_5XX_MAX_ISSUES', 5);
/**
 * How recent a URL's last 5xx must be for it to still count as a live defect.
 * 2h, not 0h, so an incident that stopped minutes before the daily run is still
 * reported — the gate is aimed at yesterday's blips, not at rounding.
 */
const MAX_AGE_HOURS = Number(process.env.CF_5XX_MAX_AGE_HOURS ?? 2);

/**
 * Collapse `detailByHour` rows into one burst shape per URL.
 *
 * `hoursSinceLast` is the field the recency gate turns on; `activeHours` and
 * `peakShare` are carried into the issue body so the next reader does not have
 * to re-derive the shape from Cloudflare by hand (which is exactly what
 * triaging #5231/#5232 cost).
 *
 * @param {Array<{url:string,hour:string,count:number}>} rows
 * @param {Date} [now]
 * @returns {Map<string,{lastHour:string,hoursSinceLast:number,activeHours:number,total:number,peakHour:string,peakCount:number,peakShare:number}>}
 */
export function summarizeBursts(rows, now = new Date()) {
  const byUrl = new Map();
  for (const r of rows || []) {
    const n = Number(r?.count) || 0;
    if (n <= 0) continue;
    const url = String(r?.url ?? '');
    const hour = String(r?.hour ?? '');
    if (!url || !hour || Number.isNaN(Date.parse(hour))) continue;
    const b = byUrl.get(url) || { hours: new Map(), total: 0 };
    b.hours.set(hour, (b.hours.get(hour) || 0) + n);
    b.total += n;
    byUrl.set(url, b);
  }

  const out = new Map();
  for (const [url, b] of byUrl) {
    const hours = [...b.hours.entries()].sort((a, z) => a[0].localeCompare(z[0]));
    const lastHour = hours[hours.length - 1][0];
    const [peakHour, peakCount] = hours.reduce((a, z) => (z[1] > a[1] ? z : a));
    out.set(url, {
      lastHour,
      // Hour buckets are floors, so an error inside the current hour reads 0.
      hoursSinceLast: Math.max(0, (now.getTime() - Date.parse(lastHour)) / 3_600_000),
      activeHours: hours.length,
      total: b.total,
      peakHour,
      peakCount,
      peakShare: b.total ? peakCount / b.total : 0,
    });
  }
  return out;
}

/**
 * A burst is stale when its most recent 5xx is older than `maxAgeHours`.
 *
 * Returns FALSE (i.e. keep the issue) whenever the shape is unknown: no hourly
 * data means no evidence the burst is over, and this gate must never invent
 * that evidence. `maxAgeHours <= 0` disables the gate entirely.
 */
export function isStaleBurst(shape, maxAgeHours = MAX_AGE_HOURS) {
  if (!shape || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return false;
  return shape.hoursSinceLast > maxAgeHours;
}

/** One-line burst description for the issue body. */
function describeBurst(shape, hours) {
  if (!shape) return `**Burst shape:** unavailable (no hourly rows in this report run)`;
  const pct = (shape.peakShare * 100).toFixed(0);
  return [
    `**Last 5xx:** ${shape.lastHour} (${shape.hoursSinceLast.toFixed(1)}h ago)`,
    `**Spread:** ${shape.activeHours} of ${hours} hours had 5xx; peak hour ${shape.peakHour} carried ${shape.peakCount} (${pct}%)`,
  ].join('\n');
}

export async function main() {
  if (!process.env.CF_API_TOKEN) {
    console.log('[cf-5xx-issue-sync] CF_API_TOKEN missing — skip');
    return;
  }

  let data;
  try {
    const out = execFileSync(
      'node',
      ['scripts/cf-status-report.mjs', '--json', '--class=5', `--hours=${HOURS}`, '--limit=50', '--by-hour'],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
    data = JSON.parse(out);
  } catch (e) {
    console.error(`[cf-5xx-issue-sync] cf-status-report.mjs failed: ${e.message}`);
    return;
  }

  const overThreshold = (data.detail || [])
    .filter((r) => r.count >= MIN_COUNT)
    .sort((a, b) => b.count - a.count);

  if (!overThreshold.length) {
    console.log(`[cf-5xx-issue-sync] no path with >= ${MIN_COUNT} 5xx in last ${HOURS}h — nothing to sync`);
    return;
  }

  // Recency gate. See the docblock: without it a 60-second blip from yesterday
  // afternoon is indistinguishable from an outage happening right now.
  const hourly = data.detailByHour;
  if (!Array.isArray(hourly)) {
    console.log(
      '::warning title=cf-5xx recency gate inactive::cf-status-report.mjs returned no `detailByHour` ' +
        '(is --by-hour still wired?) — filing on the flat 23h total, so a burst that already ended ' +
        'can be reported as a live defect. This is the #5231/#5232 failure mode.',
    );
  }
  const shapes = Array.isArray(hourly) ? summarizeBursts(hourly) : new Map();

  const entries = [];
  for (const e of overThreshold) {
    const shape = shapes.get(e.url);
    if (isStaleBurst(shape)) {
      console.log(
        `[cf-5xx-issue-sync] skip ${e.url}: ${e.count} 5xx in ${HOURS}h but last one ` +
          `${shape.hoursSinceLast.toFixed(1)}h ago (${shape.activeHours} active hour(s), ` +
          `peak ${shape.peakCount}) — burst is over, not a live defect`,
      );
      continue;
    }
    entries.push({ ...e, shape });
  }

  if (!entries.length) {
    console.log(
      `[cf-5xx-issue-sync] ${overThreshold.length} path(s) over threshold, all with no 5xx in the ` +
        `last ${MAX_AGE_HOURS}h — nothing live to sync`,
    );
    return;
  }

  return syncErrorIssues({
    entries,
    maxIssues: MAX_ISSUES,
    labels: ['stability', 'cloudflare-5xx'],
    source: `Cloudflare 5xx Monitor — last ${HOURS}h (zone-wide)`,
    priorityFor: (e) => (e.count >= MIN_COUNT * 5 ? 2 : 3),
    titleFor: (e) => `CF 5xx: ${sanitizeUrlLikeText(e.url).slice(0, 80)}`,
    bodyFor: (e) => [
      `**Status:** ${e.status}`,
      `**URL:** ${sanitizeUrlLikeText(e.url)}`,
      `**5xx responses (last ${HOURS}h):** ${e.count}`,
      describeBurst(e.shape, HOURS),
      '',
      '_Source: Cloudflare GraphQL Analytics (`httpRequestsAdaptiveGroups`), zone-wide eyeball 5xx — see scripts/cf-status-report.mjs._',
    ].join('\n'),
  });
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main() never triggers a live CF/gh call — same guard as
// scripts/dmarc-monitor.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main();
  if (results) {
    console.log(`[cf-5xx-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  }
}
