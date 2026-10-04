#!/usr/bin/env node
/**
 * Read-only D18 measure: per GA4 day, how many Employer Insights evidence
 * events arrived WITHOUT `emission_id`.
 *
 * The population is the one the D18 gate judges ("Require first live GA4
 * evidence" in employer-insights-refresh.yml): the rows come from
 * `queryGa4EmissionEvidence`, the same scoped probe the builder runs, so a
 * non-zero day here is a day the forward-only predicate
 * (`findFirstCompleteGa4IdentityAt`) cannot include. The predicate wants zero:
 * this script only measures, it never relaxes anything.
 *
 * Every page_view producer in the site source carries `emission_id`
 * (tests/page-view-producer-inventory.test.ts). A missing id therefore comes
 * from code that is not the current source: a stale stable-named asset at a
 * CDN PoP (edge TTL 7 days, see scripts/lib/deploy-it-pages-prep.sh) or a
 * long-lived tab still running an older bundle.
 *
 * Usage (GA4 Data API, analytics.readonly):
 *   GOOGLE_APPLICATION_CREDENTIALS=<service account json> \
 *     node scripts/employer-insights-emission-gaps.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json] [--expect-zero]
 *
 * Defaults: the last three GA4 days through today. Days before today use the
 * settled report; today uses the live (current-date) probe up to now.
 * `--expect-zero` exits 1 when any day in range has a missing id.
 */
import { queryGa4EmissionEvidence } from './build-employer-insights.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  DEFAULT_GA4_PROPERTY_ID,
  GA4_READONLY_SCOPE,
  getServiceAccountToken,
} from './lib/ga4-service-account.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayStart(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** Inclusive list of YYYY-MM-DD days between `from` and `to`. */
export function emissionGapDays(from, to) {
  if (!DAY_RE.test(String(from)) || !DAY_RE.test(String(to))) throw new Error('--from/--to must be YYYY-MM-DD');
  const start = dayStart(from);
  const end = dayStart(to);
  if (!(start <= end)) throw new Error('--from must not be after --to');
  const days = [];
  for (let time = start; time <= end; time += DAY_MS) days.push(new Date(time).toISOString().slice(0, 10));
  return days;
}

/**
 * GA4 window for one day. A past day is read from the settled report
 * ([day, day+1) ends on `day`); today is read live up to `now`.
 */
export function emissionGapWindow(day, now = new Date()) {
  const from = new Date(dayStart(day)).toISOString();
  const today = now.toISOString().slice(0, 10);
  if (day >= today) {
    return { window: { from, to: now.toISOString(), timezone: 'UTC', inclusive: '[from,to)' }, live: true };
  }
  return { window: { from, to: new Date(dayStart(day) + DAY_MS).toISOString(), timezone: 'UTC', inclusive: '[from,to)' }, live: false };
}

/** Summarise the scoped evidence rows of `day` (rows of other days are ignored). */
export function summarizeEmissionGapDay(day, result) {
  const rows = (Array.isArray(result?.rows) ? result.rows : [])
    .filter((row) => String(row?.timestamp || '').slice(0, 10) === day);
  let observed = 0;
  let missing = 0;
  const missingRows = [];
  for (const row of rows) {
    const count = Math.max(0, Number(row?.observed) || 0);
    observed += count;
    if (String(row?.emissionId || '').trim()) continue;
    missing += count;
    missingRows.push({ event: row.event, path: row.path, observed: count });
  }
  missingRows.sort((a, b) => b.observed - a.observed || String(a.path).localeCompare(String(b.path)));
  return {
    day,
    evidenceObserved: observed,
    missingObserved: missing,
    truncated: result?.coverage?.truncated === true,
    missing: missingRows,
  };
}

function parseArgs(argv, now = new Date()) {
  const args = { json: false, expectZero: false, from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--expect-zero') args.expectZero = true;
    else if (arg === '--from') args.from = argv[++i];
    else if (arg === '--to') args.to = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  const today = now.toISOString().slice(0, 10);
  for (const value of [args.from, args.to]) {
    if (value !== null && !DAY_RE.test(String(value))) throw new Error('--from/--to must be YYYY-MM-DD');
  }
  if (!args.to || args.to > today) args.to = today;
  args.from ??= new Date(dayStart(args.to) - 2 * DAY_MS).toISOString().slice(0, 10);
  return args;
}

async function main() {
  const now = new Date();
  const args = parseArgs(process.argv.slice(2), now);
  const token = await getServiceAccountToken([GA4_READONLY_SCOPE], { logInfo: () => {} });
  if (!token) throw new Error('GA4 credentials missing: set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON');
  const propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;

  const summaries = [];
  for (const day of emissionGapDays(args.from, args.to)) {
    const { window, live } = emissionGapWindow(day, now);
    const { result } = await queryGa4EmissionEvidence(window, { token, propertyId, includeCurrentDate: live });
    summaries.push({ ...summarizeEmissionGapDay(day, result), live });
  }

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: now.toISOString(), propertyId, days: summaries }, null, 2));
  } else {
    for (const summary of summaries) {
      const flags = [summary.live ? 'live' : 'settled', summary.truncated ? 'TRUNCATED' : ''].filter(Boolean).join(', ');
      console.log(`${summary.day}  evidence=${summary.evidenceObserved}  missing_emission_id=${summary.missingObserved}  (${flags})`);
      for (const row of summary.missing) console.log(`  - ${row.event} ${row.path} x${row.observed}`);
    }
  }
  if (args.expectZero && summaries.some((summary) => summary.missingObserved > 0 || summary.truncated)) process.exitCode = 1;
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${String(error?.message || error).split('\n')[0]}`);
    process.exitCode = 2;
  });
}
