#!/usr/bin/env node
// Pulls PostHog events for /calcola-stipendio funnel last 7d.
// Output: data/recovery-2026-05-18/calc-funnel.{json,md}
//
// Auth pattern: requires POSTHOG_PERSONAL_API_KEY in env (loaded via load-rc-env).
// PostHog project: EU 157802.
import { writeFileSync, mkdirSync } from 'node:fs';

const PROJECT_ID = '157802';
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
if (!API_KEY) throw new Error('POSTHOG_PERSONAL_API_KEY missing — run eval load-rc-env first');

const HQL = (q) => fetch(`https://eu.posthog.com/api/projects/${PROJECT_ID}/query/`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }),
}).then(r => r.json());

const sevenDaysAgo = "now() - INTERVAL 7 DAY";

// Q1: drop-off per session — entry without input_start
const q1 = await HQL(`
  SELECT
    countIf(event = 'funnel_step' AND properties.step = 'entry') AS entries,
    countIf(event = 'funnel_step' AND properties.step = 'input_start') AS starts,
    countIf(event = 'funnel_step' AND properties.step = 'calculate') AS calcs
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND properties.$current_url ILIKE '%/calcola-stipendio%'
`);

// Q2: what was the LAST event before users left without input_start
const q2 = await HQL(`
  WITH entry_sessions AS (
    SELECT DISTINCT $session_id
    FROM events
    WHERE timestamp >= ${sevenDaysAgo}
      AND event = 'funnel_step'
      AND properties.step = 'entry'
      AND properties.$current_url ILIKE '%/calcola-stipendio%'
  ),
  start_sessions AS (
    SELECT DISTINCT $session_id
    FROM events
    WHERE timestamp >= ${sevenDaysAgo}
      AND event = 'funnel_step'
      AND properties.step = 'input_start'
      AND properties.$current_url ILIKE '%/calcola-stipendio%'
  ),
  abandoners AS (
    SELECT $session_id FROM entry_sessions
    WHERE $session_id NOT IN (SELECT $session_id FROM start_sessions)
  )
  SELECT
    event,
    properties.$current_url AS url,
    count() AS n
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND $session_id IN (SELECT $session_id FROM abandoners)
  GROUP BY event, url
  ORDER BY n DESC
  LIMIT 30
`);

// Q3: scroll depth on /calcola-stipendio for abandoners
const q3 = await HQL(`
  SELECT
    quantile(0.5)(toFloat(properties.percent)) AS p50_scroll,
    quantile(0.75)(toFloat(properties.percent)) AS p75_scroll,
    quantile(0.95)(toFloat(properties.percent)) AS p95_scroll,
    count() AS n
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND event = '$pageleave'
    AND properties.$current_url ILIKE '%/calcola-stipendio%'
`);

// Q4: CLS shift per device on calc page
const q4 = await HQL(`
  SELECT
    properties.$device_type AS device,
    quantile(0.75)(toFloat(properties.web_vital_value)) AS cls_p75,
    count() AS n
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND event = '$web_vitals'
    AND properties.web_vital_name = 'CLS'
    AND properties.$current_url ILIKE '%/calcola-stipendio%'
  GROUP BY device
`);

// Q5: $exception events on calc page (which JS errors block input)
// NOTE: PostHog stores exception details as JSON arrays under $exception_types/values/sources (plural).
// Use JSONExtract* to read the first element.
const q5 = await HQL(`
  SELECT
    JSONExtractString(properties.$exception_types, 1) AS type,
    JSONExtractString(properties.$exception_values, 1) AS msg,
    JSONExtractString(properties.$exception_sources, 1) AS source,
    count() AS n
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND event = '$exception'
    AND properties.$current_url ILIKE '%/calcola-stipendio%'
  GROUP BY type, msg, source
  ORDER BY n DESC
  LIMIT 20
`);

const out = {
  generated: new Date().toISOString(),
  window_days: 7,
  funnel_counts: q1.results?.[0] ?? q1,
  abandoner_last_events: q2.results ?? q2,
  scroll_depth: q3.results?.[0] ?? q3,
  cls_on_calc: q4.results ?? q4,
  exceptions_on_calc: q5.results ?? q5,
};

mkdirSync('data/recovery-2026-05-18', { recursive: true });
writeFileSync('data/recovery-2026-05-18/calc-funnel.json', JSON.stringify(out, null, 2));

// Markdown summary
const md = [];
md.push('# Calculator funnel diagnosis — 7d');
md.push('');
md.push('## Funnel counts');
const fc = out.funnel_counts;
md.push(`- entries: ${fc?.[0] ?? fc?.entries}`);
md.push(`- input_start: ${fc?.[1] ?? fc?.starts}`);
md.push(`- calculate: ${fc?.[2] ?? fc?.calcs}`);
md.push('');
md.push('## Top 30 events from abandoners (entry without input_start)');
md.push('| event | url | count |');
md.push('|---|---|---|');
for (const r of out.abandoner_last_events?.slice?.(0, 30) ?? []) {
  md.push(`| ${r[0]} | ${(r[1] ?? '').slice(0,80)} | ${r[2]} |`);
}
md.push('');
md.push('## Scroll depth on calc page (pageleave)');
const sd = out.scroll_depth;
md.push(`- p50: ${sd?.[0]} · p75: ${sd?.[1]} · p95: ${sd?.[2]} · n: ${sd?.[3]}`);
md.push('');
md.push('## CLS p75 on calc page by device');
for (const r of out.cls_on_calc ?? []) md.push(`- ${r[0]}: p75=${r[1]} (n=${r[2]})`);
md.push('');
md.push('## Top JS exceptions on calc page');
md.push('| type | message | count |');
md.push('|---|---|---|');
for (const r of out.exceptions_on_calc?.slice?.(0, 20) ?? []) {
  md.push(`| ${r[0]} | ${(r[1] ?? '').slice(0,80)} | ${r[3]} |`);
}
writeFileSync('data/recovery-2026-05-18/calc-funnel.md', md.join('\n'));
console.log('Wrote data/recovery-2026-05-18/calc-funnel.{json,md}');
