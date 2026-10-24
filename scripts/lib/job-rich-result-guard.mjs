/**
 * Anti-regression rules for job rich results (pure, no network).
 *
 * Two independent signals, both read by scripts/monitor-gsc-job-indexation.mjs:
 *
 *   1. JOB_LISTING clicks (Search Console searchAppearance, dataState "all"):
 *      the evaluated day is compared with the MEDIAN of the same weekday in the
 *      4 preceding weeks. A drop above 30% alerts. Same-weekday because job
 *      search is strongly weekly (Monday ~2x Saturday): a day-over-day or
 *      7-day-mean comparison would alert every weekend.
 *      Backtest on seo-data/daily-by-appearance.json (2026-08..10): the
 *      4-22 October outage (JobPosting not emitted, PR 11394) crosses the
 *      threshold from 2026-10-06, the first full weekday after it began.
 *
 *   2. Share of sampled live job pages that Google reports with a
 *      "Job Postings" rich result (URL Inspection, richResultsResult). Below
 *      80% alerts. The verdict alone is NOT enough: a page with only
 *      Breadcrumbs reports richResultsResult.verdict = PASS, which is exactly
 *      how 13 of 60 inspected job pages looked healthy on 2026-10-23 while
 *      carrying no Jobs result (jp/insp60-out.json).
 *
 * @module scripts/lib/job-rich-result-guard
 */

export const CLICK_DROP_THRESHOLD = 0.3;
export const RICH_SHARE_THRESHOLD = 0.8;
export const BASELINE_WEEKS = 4;
/** Below this many eligible pages the share is reported but cannot alert. */
export const MIN_RICH_SAMPLE = 10;
/**
 * Search Console "all" (fresh) data for the newest days is provisional and
 * Google documents it as subject to change. Evaluating a day at least 3 days
 * old costs one day of detection latency and keeps a still-filling day from
 * passing for a drop.
 */
export const SETTLE_DAYS = 3;

const DAY_MS = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** True when URL Inspection reports a "Job Postings" rich result item. */
export function hasJobPostingRichResult(richResultsResult) {
  const items = richResultsResult?.detectedItems;
  if (!Array.isArray(items)) return false;
  return items.some((d) => /job\s*posting/i.test(String(d?.richResultType || '')) && (d.items?.length ?? 1) > 0);
}

/**
 * Latest date in the series that is at least SETTLE_DAYS before `today`.
 * @param {Array<{date: string, clicks: number}>} series
 * @param {string} today YYYY-MM-DD (UTC)
 */
export function pickEvaluationDay(series, today) {
  const limit = iso(Date.parse(`${today}T00:00:00Z`) - SETTLE_DAYS * DAY_MS);
  // Search Console omits a day when the dimension has no rows. The latest
  // settled calendar day is still the day we must judge: a zero-click day is
  // the strongest regression, not permission to silently fall back to an
  // earlier healthy day. An empty series has no evidence at all.
  return series.length ? limit : null;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Same-weekday median comparison. Missing dates count as 0 clicks: the
 * Search Console API omits days without rows, and a day with no JOB_LISTING
 * click at all is the strongest regression, not missing data.
 *
 * @param {Array<{date: string, clicks: number}>} series
 * @param {{day: string, threshold?: number, weeks?: number}} opts
 */
export function evaluateWeekdayDrop(series, { day, threshold = CLICK_DROP_THRESHOLD, weeks = BASELINE_WEEKS }) {
  const byDate = new Map(series.map((r) => [r.date, Number(r.clicks) || 0]));
  const base = Date.parse(`${day}T00:00:00Z`);
  const earliest = series.map((r) => r.date).sort()[0];
  const baselineDates = Array.from({ length: weeks }, (_, k) => iso(base - 7 * (k + 1) * DAY_MS));
  if (!earliest || baselineDates.some((d) => d < earliest)) {
    return { day, clicks: byDate.get(day) ?? 0, baseline: null, drop: null, alert: false, reason: 'insufficient-history' };
  }
  const baseline = median(baselineDates.map((d) => byDate.get(d) ?? 0));
  const clicks = byDate.get(day) ?? 0;
  if (baseline <= 0) return { day, clicks, baseline, drop: null, alert: false, reason: 'zero-baseline' };
  const drop = (baseline - clicks) / baseline;
  return { day, clicks, baseline, drop, alert: drop > threshold, reason: drop > threshold ? 'drop' : 'ok', baselineDates };
}

/**
 * Share of eligible (live job, inspected) pages that carry a Jobs rich result.
 * @param {Array<{liveJob: boolean, inspected: boolean, hasJobs: boolean}>} rows
 */
export function evaluateRichShare(rows, { threshold = RICH_SHARE_THRESHOLD, minSample = MIN_RICH_SAMPLE } = {}) {
  const eligible = rows.filter((r) => r.liveJob && r.inspected);
  const withJobs = eligible.filter((r) => r.hasJobs).length;
  const share = eligible.length ? withJobs / eligible.length : null;
  const alert = eligible.length >= minSample && share < threshold;
  return { eligible: eligible.length, withJobs, share, alert, reason: eligible.length < minSample ? 'small-sample' : (alert ? 'below-threshold' : 'ok') };
}

/**
 * Deterministic pick of `n` items: same seed (the UTC date) → same sample, so
 * a re-run of the same day inspects the same pages.
 * @template T
 * @param {T[]} list
 * @param {number} n
 * @param {string} seed
 * @returns {T[]}
 */
export function seededSample(list, n, seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rand = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  const a = [...list];
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}
