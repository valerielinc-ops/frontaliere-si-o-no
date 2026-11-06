#!/usr/bin/env node
/**
 * triage-app-errors.mjs — quick triage of $exception events in PostHog.
 *
 * Pulls top error messages / URLs / browsers / 30d trend and prints a
 * markdown report to stdout. Used by the 2026-05-18 GA4 3.5%-error spike
 * triage; safe to re-run any time as a fast PostHog health check.
 */

const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
const PID = process.env.POSTHOG_PROJECT_ID;
const KEY = process.env.POSTHOG_PERSONAL_API_KEY;

if (!KEY || !PID) {
  console.error('triage-app-errors: POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing');
  process.exit(2);
}

async function hogql(query) {
  const r = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`PH ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const WINDOW = process.env.WINDOW_DAYS || '30';

function table(title, rows, headers) {
  console.log(`\n### ${title}\n`);
  console.log(`| ${headers.join(' | ')} |`);
  console.log(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    console.log(`| ${r.map((c) => (c == null ? '' : String(c).replace(/\|/g, '\\|').replace(/\n/g, ' '))).join(' | ')} |`);
  }
}

console.log(`# PostHog $exception triage — last ${WINDOW}d\n`);
console.log(`Host: ${HOST} · Project: ${PID}\n`);

const q1 = `
  SELECT
    properties.$exception_values.1 AS msg,
    properties.$exception_types.1 AS type,
    count() AS n
  FROM events
  WHERE event = '$exception'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
  GROUP BY msg, type
  ORDER BY n DESC
  LIMIT 25
`;
const r1 = await hogql(q1.trim());
table(
  'Top 20 exception messages',
  (r1.results || []).map((row) => [row[2], row[1] || '-', String(row[0] || '').slice(0, 220)]),
  ['count', 'type', 'message'],
);

const q2 = `
  SELECT properties.$current_url AS url, count() AS n
  FROM events
  WHERE event = '$exception'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
  GROUP BY url ORDER BY n DESC LIMIT 15
`;
const r2 = await hogql(q2.trim());
table('Top 15 URLs', (r2.results || []).map((row) => [row[1], row[0]]), ['count', 'url']);

const q3 = `
  SELECT properties.$browser AS b, properties.$browser_version AS v, properties.$os AS os, count() AS n
  FROM events
  WHERE event = '$exception'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
  GROUP BY b, v, os ORDER BY n DESC LIMIT 12
`;
const r3 = await hogql(q3.trim());
table('Top browsers', (r3.results || []).map((row) => [row[3], row[0], row[1], row[2]]), ['count', 'browser', 'version', 'os']);

const q4 = `
  SELECT toDate(timestamp) AS day, count() AS n
  FROM events
  WHERE event = '$exception'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
  GROUP BY day ORDER BY day DESC
`;
try {
  const r4 = await hogql(q4.trim());
  table('Daily trend', (r4.results || []).map((row) => [row[0], row[1]]), ['day', 'count']);
} catch (e) { console.log(`\n_daily trend failed: ${e.message.slice(0,200)}_\n`); }

// Top sources (file/url where the error fired)
const q5 = `
  SELECT properties.$exception_sources.1 AS src, count() AS n
  FROM events
  WHERE event = '$exception'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
  GROUP BY src ORDER BY n DESC LIMIT 15
`;
try {
  const r5 = await hogql(q5.trim());
  table('Top exception sources', (r5.results || []).map((row) => [row[1], String(row[0] || '').slice(0, 200)]), ['count', 'source']);
} catch (e) { console.log(`\n_sources query failed: ${e.message.slice(0,200)}_\n`); }

// app_error custom event (mirrors GA4 trackAppError pipeline)
const q6 = `
  SELECT properties.error_type AS t, properties.endpoint AS ep, properties.error_message AS m, count() AS n
  FROM events
  WHERE event = 'app_error'
    AND timestamp > now() - INTERVAL ${WINDOW} DAY
  GROUP BY t, ep, m ORDER BY n DESC LIMIT 30
`;
try {
  const r6 = await hogql(q6.trim());
  table('Top app_error (custom)', (r6.results || []).map((row) => [row[3], row[0], String(row[1] || '').slice(0, 80), String(row[2] || '').slice(0, 220)]), ['count', 'error_type', 'endpoint', 'message']);
} catch (e) {
  console.log(`\n_app_error query failed: ${e.message}_\n`);
}

console.error('\ntriage-app-errors: done');
