#!/usr/bin/env node
/**
 * investigate-calc-funnel-drop.mjs — PostHog investigation for the
 * calculator entry → input_start funnel collapse reported on 2026-05-18.
 *
 * Read-only HogQL queries against PostHog EU.
 * Auth: env via scripts/load-rc-env.mjs (POSTHOG_PERSONAL_API_KEY/PROJECT_ID/HOST).
 *
 * Outputs a markdown report to stdout — pipe to reports/funnel-drop-2026-05-18.md.
 */

const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
const PID = process.env.POSTHOG_PROJECT_ID;
const KEY = process.env.POSTHOG_PERSONAL_API_KEY;

if (!KEY || !PID) {
  console.error('investigate-calc-funnel-drop: POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing');
  process.exit(2);
}

const WINDOW = process.env.WINDOW_DAYS || '7';

async function hogql(query) {
  const r = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`PH ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();
}

function table(rows, headers) {
  if (!rows || rows.length === 0) {
    console.log('_(no rows)_\n');
    return;
  }
  console.log(`| ${headers.join(' | ')} |`);
  console.log(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    console.log(`| ${r.map((c) => (c == null ? '' : String(c).replace(/\|/g, '\\|').replace(/\n/g, ' '))).join(' | ')} |`);
  }
  console.log('');
}

console.log(`# Calculator funnel drop — PostHog investigation (last ${WINDOW}d)\n`);
console.log(`Host: ${HOST} · Project: ${PID} · Generated: ${new Date().toISOString()}\n`);
console.log(`Context: GA4 reports funnel_step:entry → input_start drop -71 % (24.216 users → 7.043).\n`);

// ── 1. Baseline counts (entry / input_start / calculate / compare) ───────────
console.log(`## 1. Step counts (last ${WINDOW}d, funnel = calculator)\n`);
const qCounts = `
  SELECT
    properties.step AS step,
    count() AS events,
    count(DISTINCT distinct_id) AS users
  FROM events
  WHERE event = 'funnel_step'
    AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
  GROUP BY step
  ORDER BY users DESC
`;
const rCounts = await hogql(qCounts.trim());
table(rCounts.results || [], ['step', 'events', 'users']);

// ── 2. Top entry landing URLs WITHOUT a subsequent input_start ───────────────
console.log(`## 2. Top entry landing URLs for users who never fired input_start (same session)\n`);
const qDropUrls = `
  SELECT properties.$current_url AS url, count(DISTINCT distinct_id) AS users
  FROM events
  WHERE event = 'funnel_step' AND properties.step = 'entry' AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
    AND distinct_id NOT IN (
      SELECT distinct_id FROM events
      WHERE event = 'funnel_step' AND properties.step = 'input_start' AND properties.funnel = 'calculator'
        AND timestamp > now() - INTERVAL ${WINDOW} DAY
    )
  GROUP BY url
  ORDER BY users DESC
  LIMIT 20
`;
const rDropUrls = await hogql(qDropUrls.trim());
table(rDropUrls.results || [], ['url', 'dropping_users']);

// ── 3. Compare: top entry landing URLs that DID convert to input_start ───────
console.log(`## 3. Top entry landing URLs that DID convert to input_start (same window)\n`);
const qConvUrls = `
  SELECT properties.$current_url AS url, count(DISTINCT distinct_id) AS users
  FROM events
  WHERE event = 'funnel_step' AND properties.step = 'entry' AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
    AND distinct_id IN (
      SELECT distinct_id FROM events
      WHERE event = 'funnel_step' AND properties.step = 'input_start' AND properties.funnel = 'calculator'
        AND timestamp > now() - INTERVAL ${WINDOW} DAY
    )
  GROUP BY url
  ORDER BY users DESC
  LIMIT 20
`;
const rConvUrls = await hogql(qConvUrls.trim());
table(rConvUrls.results || [], ['url', 'converting_users']);

// ── 4. Device split (mobile vs desktop) among dropping users ─────────────────
console.log(`## 4. Device split among dropping users (entry-only, no input_start)\n`);
const qDevice = `
  SELECT properties.$device_type AS device, count(DISTINCT distinct_id) AS users
  FROM events
  WHERE event = 'funnel_step' AND properties.step = 'entry' AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
    AND distinct_id NOT IN (
      SELECT distinct_id FROM events
      WHERE event = 'funnel_step' AND properties.step = 'input_start' AND properties.funnel = 'calculator'
        AND timestamp > now() - INTERVAL ${WINDOW} DAY
    )
  GROUP BY device
  ORDER BY users DESC
`;
const rDevice = await hogql(qDevice.trim());
table(rDevice.results || [], ['device', 'dropping_users']);

// ── 5. Device split among converting users (for ratio comparison) ────────────
console.log(`## 5. Device split among converting users (entry + input_start)\n`);
const qDeviceConv = `
  SELECT properties.$device_type AS device, count(DISTINCT distinct_id) AS users
  FROM events
  WHERE event = 'funnel_step' AND properties.step = 'entry' AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
    AND distinct_id IN (
      SELECT distinct_id FROM events
      WHERE event = 'funnel_step' AND properties.step = 'input_start' AND properties.funnel = 'calculator'
        AND timestamp > now() - INTERVAL ${WINDOW} DAY
    )
  GROUP BY device
  ORDER BY users DESC
`;
const rDeviceConv = await hogql(qDeviceConv.trim());
table(rDeviceConv.results || [], ['device', 'converting_users']);

// ── 6. Browser split among dropping users ────────────────────────────────────
console.log(`## 6. Browser split among dropping users\n`);
const qBrowser = `
  SELECT properties.$browser AS browser, count(DISTINCT distinct_id) AS users
  FROM events
  WHERE event = 'funnel_step' AND properties.step = 'entry' AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
    AND distinct_id NOT IN (
      SELECT distinct_id FROM events
      WHERE event = 'funnel_step' AND properties.step = 'input_start' AND properties.funnel = 'calculator'
        AND timestamp > now() - INTERVAL ${WINDOW} DAY
    )
  GROUP BY browser
  ORDER BY users DESC
  LIMIT 10
`;
const rBrowser = await hogql(qBrowser.trim());
table(rBrowser.results || [], ['browser', 'dropping_users']);

// ── 7. Top errors in dropping sessions ──────────────────────────────────────
console.log(`## 7. Top \`$exception\` messages in dropping sessions (same distinct_id, last ${WINDOW}d)\n`);
const qErrors = `
  SELECT
    coalesce(properties.$exception_values.1, properties.$exception_message) AS msg,
    properties.$exception_types.1 AS type,
    count() AS n,
    count(DISTINCT distinct_id) AS users
  FROM events
  WHERE event = '$exception'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
    AND distinct_id IN (
      SELECT distinct_id FROM events
      WHERE event = 'funnel_step' AND properties.step = 'entry' AND properties.funnel = 'calculator'
        AND timestamp > now() - INTERVAL ${WINDOW} DAY
        AND distinct_id NOT IN (
          SELECT distinct_id FROM events
          WHERE event = 'funnel_step' AND properties.step = 'input_start' AND properties.funnel = 'calculator'
            AND timestamp > now() - INTERVAL ${WINDOW} DAY
        )
    )
  GROUP BY msg, type
  ORDER BY users DESC
  LIMIT 15
`;
const rErrors = await hogql(qErrors.trim());
table(rErrors.results || [], ['msg', 'type', 'events', 'users']);

// ── 8. landing_path payload on entry events (what URLs are firing entry) ─────
console.log(`## 8. \`landing_path\` payload values on entry events (drop-only)\n`);
const qLandingPath = `
  SELECT properties.landing_path AS landing_path, count(DISTINCT distinct_id) AS users
  FROM events
  WHERE event = 'funnel_step' AND properties.step = 'entry' AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
    AND distinct_id NOT IN (
      SELECT distinct_id FROM events
      WHERE event = 'funnel_step' AND properties.step = 'input_start' AND properties.funnel = 'calculator'
        AND timestamp > now() - INTERVAL ${WINDOW} DAY
    )
  GROUP BY landing_path
  ORDER BY users DESC
  LIMIT 25
`;
const rLandingPath = await hogql(qLandingPath.trim());
table(rLandingPath.results || [], ['landing_path', 'dropping_users']);

// ── 9. Sample dropping session IDs (for manual session-recording inspection) ─
console.log(`## 9. Sample 15 dropping-user distinct_ids + their $session_id\n`);
const qSessions = `
  SELECT DISTINCT distinct_id, properties.$session_id AS sid, properties.$current_url AS url, timestamp
  FROM events
  WHERE event = 'funnel_step' AND properties.step = 'entry' AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
    AND properties.$session_id IS NOT NULL
    AND distinct_id NOT IN (
      SELECT distinct_id FROM events
      WHERE event = 'funnel_step' AND properties.step = 'input_start' AND properties.funnel = 'calculator'
        AND timestamp > now() - INTERVAL ${WINDOW} DAY
    )
  ORDER BY timestamp DESC
  LIMIT 15
`;
const rSessions = await hogql(qSessions.trim());
table(rSessions.results || [], ['distinct_id', 'session_id', 'url', 'timestamp']);

// ── 10. Daily trend — is the drop new or stable? ────────────────────────────
console.log(`## 10. Daily trend (last 14d) — entry vs input_start users\n`);
const qTrend = `
  SELECT
    toDate(timestamp) AS day,
    countIf(properties.step = 'entry') AS entries,
    countIf(properties.step = 'input_start') AS input_starts,
    round(100.0 * countIf(properties.step = 'input_start') / nullif(countIf(properties.step = 'entry'), 0), 1) AS conv_pct
  FROM events
  WHERE event = 'funnel_step' AND properties.funnel = 'calculator'
    AND timestamp > now() - INTERVAL 14 DAY
  GROUP BY day
  ORDER BY day DESC
`;
const rTrend = await hogql(qTrend.trim());
table(rTrend.results || [], ['day', 'entries (events)', 'input_starts (events)', 'conv %']);

console.log(`---\n_Generated by scripts/investigate-calc-funnel-drop.mjs_`);
