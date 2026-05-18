#!/usr/bin/env node
// Pulls PostHog $exception events site-wide last 30d.
// Groups by exception_message + source URL.
// Output: data/recovery-2026-05-18/app-errors.{json,md}
import { writeFileSync, mkdirSync } from 'node:fs';

const PROJECT_ID = '157802';
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
if (!API_KEY) throw new Error('POSTHOG_PERSONAL_API_KEY missing');

const HQL = (q) => fetch(`https://eu.posthog.com/api/projects/${PROJECT_ID}/query/`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }),
}).then(r => r.json());

// NOTE: PostHog stores exception details as JSON arrays under $exception_types/values/sources (plural).
const q1 = await HQL(`
  SELECT
    JSONExtractString(properties.$exception_types, 1) AS type,
    JSONExtractString(properties.$exception_values, 1) AS msg,
    JSONExtractString(properties.$exception_sources, 1) AS source,
    count() AS n,
    count(DISTINCT $session_id) AS sessions,
    any(properties.$current_url) AS sample_url
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND event = '$exception'
  GROUP BY type, msg, source
  ORDER BY n DESC
  LIMIT 50
`);

const q2 = await HQL(`
  SELECT
    JSONExtractString(properties.$exception_values, 1) AS msg,
    properties.$current_url AS url,
    count() AS n
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND event = '$exception'
  GROUP BY msg, url
  ORDER BY n DESC
  LIMIT 100
`);

const q3 = await HQL(`
  SELECT
    toDate(timestamp) AS d,
    count() AS n
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND event = '$exception'
  GROUP BY d
  ORDER BY d
`);

const out = {
  generated: new Date().toISOString(),
  window_days: 30,
  top_exceptions: q1.results ?? q1,
  by_url: q2.results ?? q2,
  daily: q3.results ?? q3,
};
mkdirSync('data/recovery-2026-05-18', { recursive: true });
writeFileSync('data/recovery-2026-05-18/app-errors.json', JSON.stringify(out, null, 2));

const md = ['# App error diagnosis — 30d', '', '## Top 50 by frequency', '| type | message | source | count | sessions |', '|---|---|---|---|---|'];
for (const r of out.top_exceptions?.slice?.(0,50) ?? []) {
  md.push(`| ${r[0]} | ${(r[1]??'').slice(0,80)} | ${(r[2]??'').slice(0,40)} | ${r[3]} | ${r[4]} |`);
}
md.push('', '## Daily count');
for (const r of out.daily ?? []) md.push(`- ${r[0]}: ${r[1]}`);
writeFileSync('data/recovery-2026-05-18/app-errors.md', md.join('\n'));
console.log('Wrote data/recovery-2026-05-18/app-errors.{json,md}');
