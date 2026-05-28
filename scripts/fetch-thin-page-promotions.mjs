#!/usr/bin/env node
// fetch-thin-page-promotions.mjs
//
// Hourly self-heal feedback loop for tiered emission (artifact-shrink
// Fase 1). Polls PostHog + GA4 for `thin_page_view` events emitted by
// App.tsx when window.__THIN_SHELL__ is set on a thinned static page.
// Any URL hit by a JS-enabled client (real user or render-bot) gets
// added to data/thin-page-promotions-active.json — the next build sees
// it via trafficEvidenceFilter and serves the FULL bridge HTML instead
// of the thin shell.
//
// Output files
//   data/thin-page-promotions.jsonl
//     Append-only history. One row per refresh:
//     { generatedAt, source: 'posthog'|'ga4'|'union', urls: [path,...] }
//
//   data/thin-page-promotions-active.json
//     Compact, read by build:
//     { generatedAt, windowDays: 30, urls: [path,...] }
//
// Auth
//   FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS) for GA4.
//   POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID for PostHog HogQL.
//   GA4_PROPERTY_ID for GA4.
//
// Usage
//   node scripts/fetch-thin-page-promotions.mjs [--window-hours=24]
//                                               [--active-window-days=30]
//
// Exit codes
//   0  ok, no-op (no hits, files untouched)
//   0  ok, urls promoted (active.json updated)
//   3  partial — one of the two feeds errored (promotions still committed)
//   2  fatal — both feeds errored

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ACTIVE_PATH = join(ROOT, 'data', 'thin-page-promotions-active.json');
const HISTORY_PATH = join(ROOT, 'data', 'thin-page-promotions.jsonl');

function parseArgs(argv) {
  const out = { windowHours: 24, activeWindowDays: 30 };
  for (const a of argv) {
    if (a.startsWith('--window-hours=')) out.windowHours = Number(a.slice(15));
    else if (a.startsWith('--active-window-days=')) out.activeWindowDays = Number(a.slice(21));
  }
  return out;
}

function normalizePath(p) {
  if (!p) return '';
  let s = p;
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  s = s.replace(/\/index\.html$/, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

// ─── PostHog: HogQL count by pathname ────────────────────────────────

async function fetchPosthog(windowHours) {
  const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
  const PID = process.env.POSTHOG_PROJECT_ID;
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!PID || !KEY) throw new Error('POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing');
  const query = `
    SELECT properties.$pathname AS path, count() AS hits
    FROM events
    WHERE event = 'thin_page_view'
      AND timestamp > now() - INTERVAL ${windowHours} HOUR
      AND properties.$pathname IS NOT NULL
    GROUP BY path
    LIMIT 100000
  `;
  const r = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`posthog ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const urls = new Set();
  for (const row of data.results || []) {
    const path = normalizePath(row[0]);
    if (path) urls.add(path);
  }
  return urls;
}

// ─── GA4: runReport with eventName=thin_page_view ────────────────────

async function getGa4Token() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('no service-account credentials');
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmp = path.join(os.tmpdir(), `firebase-sa-${process.pid}.json`);
    fs.writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
  }
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function fetchGa4(windowHours) {
  const propertyRaw = process.env.GA4_PROPERTY_ID;
  if (!propertyRaw) throw new Error('GA4_PROPERTY_ID missing');
  const property = propertyRaw.startsWith('properties/') ? propertyRaw : `properties/${propertyRaw}`;
  const token = await getGa4Token();
  // GA4 Data API doesn't support sub-day windows on runReport's dateRanges
  // (the smallest grain is a day). For windowHours <= 24 we query "today"
  // + "yesterday" and let the volume be a one-day approximation; the
  // active-window-days rollup on the build side absorbs the over-fetch.
  const days = Math.max(1, Math.ceil(windowHours / 24));
  const url = `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`;
  const body = {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        stringFilter: { value: 'thin_page_view', matchType: 'EXACT' },
      },
    },
    limit: 100000,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 403) {
    throw new Error(`ga4 access denied (SA needs Viewer on property): ${(await r.text()).slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`ga4 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const urls = new Set();
  for (const row of data.rows || []) {
    const path = normalizePath(row.dimensionValues?.[0]?.value || '');
    if (path) urls.add(path);
  }
  return urls;
}

// ─── Active window rollup ────────────────────────────────────────────

async function readActive() {
  if (!existsSync(ACTIVE_PATH)) return { urls: [], _seenAt: {} };
  try {
    const j = JSON.parse(await readFile(ACTIVE_PATH, 'utf8'));
    return { urls: j.urls || [], _seenAt: j._seenAt || {} };
  } catch {
    return { urls: [], _seenAt: {} };
  }
}

function rollupActive(prev, freshUrls, activeWindowDays) {
  const today = new Date().toISOString().slice(0, 10);
  const seenAt = { ...prev._seenAt };
  for (const u of freshUrls) seenAt[u] = today;
  const cutoff = Date.now() - activeWindowDays * 86400_000;
  const kept = Object.entries(seenAt).filter(([_, d]) => new Date(d).getTime() >= cutoff);
  return {
    seenAt: Object.fromEntries(kept),
    urls: kept.map(([u]) => u).sort(),
  };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[thin-promotions] window=${args.windowHours}h active=${args.activeWindowDays}d`);

  const errors = [];
  let ph = new Set();
  let ga = new Set();
  try { ph = await fetchPosthog(args.windowHours); console.log(`[thin-promotions] posthog hits: ${ph.size}`); }
  catch (e) { errors.push(`posthog: ${e.message}`); console.error(`[thin-promotions] posthog error: ${e.message}`); }
  try { ga = await fetchGa4(args.windowHours); console.log(`[thin-promotions] ga4 hits: ${ga.size}`); }
  catch (e) { errors.push(`ga4: ${e.message}`); console.error(`[thin-promotions] ga4 error: ${e.message}`); }

  if (errors.length === 2) {
    console.error('[thin-promotions] both feeds errored — leaving active.json unchanged');
    process.exit(2);
  }

  const fresh = new Set([...ph, ...ga]);
  const prev = await readActive();
  const { seenAt, urls } = rollupActive(prev, fresh, args.activeWindowDays);

  // Append history row regardless (audit trail).
  const historyRow = {
    generatedAt: new Date().toISOString(),
    windowHours: args.windowHours,
    posthogHits: ph.size,
    ga4Hits: ga.size,
    freshUnion: fresh.size,
    activeTotal: urls.length,
    errors,
  };
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  appendFileSync(HISTORY_PATH, JSON.stringify(historyRow) + '\n');

  // Commit active set only if it changed (avoid noisy commits when no
  // new hits land in a quiet hour).
  const prevSorted = [...prev.urls].sort();
  const changed =
    prevSorted.length !== urls.length ||
    prevSorted.some((u, i) => u !== urls[i]);

  if (changed) {
    await writeFile(
      ACTIVE_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          windowDays: args.activeWindowDays,
          _seenAt: seenAt,
          urls,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`[thin-promotions] active.json updated: ${urls.length} URLs (+${urls.length - prevSorted.length})`);
  } else {
    console.log(`[thin-promotions] active.json unchanged (${urls.length} URLs)`);
  }

  if (errors.length > 0) process.exit(3);
}

main().catch((e) => { console.error('[thin-promotions] fatal:', e); process.exit(2); });
