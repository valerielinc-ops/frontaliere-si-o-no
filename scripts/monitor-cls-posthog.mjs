#!/usr/bin/env node
/**
 * monitor-cls-posthog.mjs — real-user CLS/INP monitor.
 *
 * Polls PostHog `$web_vitals` events every N minutes and emits one stdout
 * line per (window, key path) with the p75 CLS or INP computed from the last
 * `WINDOW_HOURS` of real traffic. Designed to run inside a Monitor wrapper
 * so each emission becomes a notification — useful right after a perf-fix
 * deploy when you want to see field data converge in real time without
 * staring at PostHog dashboards.
 *
 * Field data lags lab data: needs ~10-30 min of fresh post-deploy traffic
 * before the rolling p75 starts shifting. CrUX (the source PSI uses) lags
 * by 28 days, so this is the only way to see same-day field movement.
 *
 * Tracks URL families (metric selected via --metric):
 *   /                                             homepage
 *   /cerca-lavoro-ticino/*                        job board (jobs_index + leaves)
 *   /vivere-in-ticino/comuni-di-frontiera/        comuni-di-frontiera (INP target p75 944→<200ms)
 *   <origin>                                      whole-site fallback
 *
 * Usage:
 *   node scripts/monitor-cls-posthog.mjs                          # CLS, 15-min polls, 1h window
 *   node scripts/monitor-cls-posthog.mjs --metric=INP             # INP mode (ms); comuni-di-frontiera target
 *   node scripts/monitor-cls-posthog.mjs --interval=300           # 5-min polls
 *   node scripts/monitor-cls-posthog.mjs --window=2 --once        # 2h window, single emission then exit
 *
 * Env (loaded via load-rc-env.mjs):
 *   POSTHOG_PERSONAL_API_KEY  — required
 *   POSTHOG_PROJECT_ID        — required
 *   POSTHOG_HOST              — default https://eu.posthog.com
 */

const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
const PID = process.env.POSTHOG_PROJECT_ID;
const KEY = process.env.POSTHOG_PERSONAL_API_KEY;

if (!KEY || !PID) {
  console.error('monitor-cls-posthog: POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing');
  process.exit(2);
}

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const intervalArg = args.find((a) => a.startsWith('--interval='));
const windowArg = args.find((a) => a.startsWith('--window='));
const metricArg = args.find((a) => a.startsWith('--metric='));
const POLL_INTERVAL_S = intervalArg ? parseInt(intervalArg.slice('--interval='.length), 10) : 900;
const WINDOW_HOURS = windowArg ? parseFloat(windowArg.slice('--window='.length)) : 1;
const METRIC = metricArg ? metricArg.slice('--metric='.length).toUpperCase() : 'CLS';
const WEB_VITAL_PROP = `$web_vitals_${METRIC}_value`;
// INP is in ms (integer display); CLS is a unitless ratio (3 decimals)
const METRIC_DECIMALS = METRIC === 'INP' ? 0 : 3;

async function hogql(query) {
  const r = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`PH ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const QUERIES = {
  homepage: `
    SELECT count() AS n, quantile(0.75)(toFloat(properties.${WEB_VITAL_PROP})) AS p75
    FROM events
    WHERE event = '$web_vitals'
      AND timestamp > now() - INTERVAL ${WINDOW_HOURS} HOUR
      AND properties.${WEB_VITAL_PROP} IS NOT NULL
      AND properties.$pathname = '/'
  `,
  jobs_root: `
    SELECT count() AS n, quantile(0.75)(toFloat(properties.${WEB_VITAL_PROP})) AS p75
    FROM events
    WHERE event = '$web_vitals'
      AND timestamp > now() - INTERVAL ${WINDOW_HOURS} HOUR
      AND properties.${WEB_VITAL_PROP} IS NOT NULL
      AND properties.$pathname = '/cerca-lavoro-ticino/'
  `,
  jobs_leaves: `
    SELECT count() AS n, quantile(0.75)(toFloat(properties.${WEB_VITAL_PROP})) AS p75
    FROM events
    WHERE event = '$web_vitals'
      AND timestamp > now() - INTERVAL ${WINDOW_HOURS} HOUR
      AND properties.${WEB_VITAL_PROP} IS NOT NULL
      AND properties.$pathname LIKE '/cerca-lavoro-ticino/%'
  `,
  comuni_frontiera: `
    SELECT count() AS n, quantile(0.75)(toFloat(properties.${WEB_VITAL_PROP})) AS p75
    FROM events
    WHERE event = '$web_vitals'
      AND timestamp > now() - INTERVAL ${WINDOW_HOURS} HOUR
      AND properties.${WEB_VITAL_PROP} IS NOT NULL
      AND properties.$pathname = '/vivere-in-ticino/comuni-di-frontiera/'
  `,
  origin_all: `
    SELECT count() AS n, quantile(0.75)(toFloat(properties.${WEB_VITAL_PROP})) AS p75
    FROM events
    WHERE event = '$web_vitals'
      AND timestamp > now() - INTERVAL ${WINDOW_HOURS} HOUR
      AND properties.${WEB_VITAL_PROP} IS NOT NULL
  `,
};

function fmt(n, decimals = 3) {
  return n == null || Number.isNaN(n) ? 'n/a  ' : n.toFixed(decimals);
}

async function tick() {
  const ts = new Date().toISOString().slice(11, 19);
  const out = { ts, window_h: WINDOW_HOURS, results: {} };
  for (const [k, q] of Object.entries(QUERIES)) {
    try {
      const r = await hogql(q.trim());
      const row = r.results?.[0] || [0, null];
      out.results[k] = { n: row[0], p75: row[1] };
    } catch (e) {
      out.results[k] = { error: e.message.slice(0, 80) };
    }
  }
  // One concise stdout line — Monitor turns this into a notification
  const cells = Object.entries(out.results)
    .map(([k, v]) => v.error ? `${k}=ERR` : `${k}=${fmt(v.p75, METRIC_DECIMALS)}(n=${v.n})`)
    .join('  ');
  console.log(`[${out.ts}] ${METRIC}p75/${WINDOW_HOURS}h  ${cells}`);
}

await tick();
if (ONCE) process.exit(0);

console.error(`monitor-cls-posthog: polling every ${POLL_INTERVAL_S}s, ${WINDOW_HOURS}h rolling window, metric=${METRIC}`);
setInterval(tick, POLL_INTERVAL_S * 1000);
