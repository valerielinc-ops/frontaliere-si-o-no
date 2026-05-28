#!/usr/bin/env node
/**
 * Refine fallback dates in `data/url-first-seen.json` by querying GSC
 * Search Analytics for the first impression date per URL.
 *
 * Strategy (day-by-day, oldest first):
 *   For each day in the 16-month window, fetch all URLs with
 *   impressions via dimensions=['page']. For each URL still mapped to
 *   the fallback date in url-first-seen.json, the first day it
 *   appears becomes its `firstSeenAt`.
 *
 * URLs without any GSC impression in the window keep the fallback
 * date (they're not reaching users yet → no grace concern).
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS env pointing to a SA JSON with
 * Search Console read access. The Firebase SA at
 * `mcp-gsc-main/service_account_credentials.json` doubles as GSC SA.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=./mcp-gsc-main/service_account_credentials.json \
 *     node scripts/refine-url-first-seen-via-gsc.mjs [--dry-run]
 *
 * Flags:
 *   --in=PATH               input file (default data/url-first-seen.json)
 *   --out=PATH              output file (default in-place)
 *   --fallback-date=YYYY-MM-DD  date that marks "still at fallback" (default 2026-04-01)
 *   --site=sc-domain:DOMAIN GSC property (default sc-domain:frontaliereticino.ch)
 *   --window-days=N         lookback window (default 480 = 16 months)
 *   --dry-run               compute + log stats, don't write file
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULTS = {
  in: 'data/url-first-seen.json',
  out: null, // → same as --in
  fallbackDate: '2026-04-01',
  site: 'sc-domain:frontaliereticino.ch',
  windowDays: 480,
  dryRun: false,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--in=')) out.in = a.slice(5);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--fallback-date=')) out.fallbackDate = a.slice(16);
    else if (a.startsWith('--site=')) out.site = a.slice(7);
    else if (a.startsWith('--window-days=')) out.windowDays = Number(a.slice(14));
  }
  if (!out.out) out.out = out.in;
  return out;
}

// Identical to scripts/seed-url-first-seen-precise.mjs and
// services/buildPlugins/trafficEvidenceFilter.ts so JSON keys match.
function normalizePath(p) {
  if (!p) return '';
  let s = p;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try { s = new URL(s).pathname; } catch { return ''; }
  }
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  s = s.replace(/\/index\.html$/, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

function* daysFrom(startDate, endDate) {
  const d = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

async function getServiceAccountToken() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set');
  }
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const client = await auth.getClient();
  if (client.email) console.log(`[refine] using SA: ${client.email}`);
  const { token } = await client.getAccessToken();
  return token;
}

async function fetchDayPages(token, site, dayStr) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const all = [];
  let startRow = 0;
  const ROW_LIMIT = 25000;
  for (;;) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: dayStr,
        endDate: dayStr,
        dimensions: ['page'],
        rowLimit: ROW_LIMIT,
        startRow,
      }),
    });
    if (!r.ok) throw new Error(`GSC ${dayStr} → ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const rows = data.rows || [];
    all.push(...rows);
    if (rows.length < ROW_LIMIT) break;
    startRow += ROW_LIMIT;
  }
  return all;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[refine] config: ${JSON.stringify(args)}`);

  const data = JSON.parse(readFileSync(args.in, 'utf8'));
  const totalEntries = Object.keys(data).length;
  const fallback = new Set();
  for (const [u, d] of Object.entries(data)) {
    if (d === args.fallbackDate) fallback.add(u);
  }
  console.log(`[refine] total: ${totalEntries} · fallback to refine: ${fallback.size}`);

  if (fallback.size === 0) {
    console.log(`[refine] nothing to do`);
    return;
  }

  const token = await getServiceAccountToken();

  // GSC has a 2-day lag — query window ends 2 days ago.
  const today = new Date();
  const end = new Date(today); end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - args.windowDays);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  console.log(`[refine] window: ${startStr} → ${endStr} (${args.windowDays} days)`);

  const firstSeen = new Map(); // url → date
  let dayIdx = 0;
  const totalDays = args.windowDays + 1;
  for (const day of daysFrom(startStr, endStr)) {
    dayIdx++;
    let rows;
    try {
      rows = await fetchDayPages(token, args.site, day);
    } catch (err) {
      console.warn(`[refine] day ${day}: ${err.message} — skipping`);
      continue;
    }
    let newCount = 0;
    for (const row of rows) {
      const p = normalizePath(row.keys && row.keys[0]);
      if (!p) continue;
      if (!fallback.has(p)) continue;
      if (firstSeen.has(p)) continue;
      firstSeen.set(p, day);
      newCount++;
    }
    if (dayIdx % 30 === 0 || dayIdx === totalDays || newCount > 200) {
      console.log(`[refine] day ${dayIdx}/${totalDays} (${day}): ${rows.length} rows · +${newCount} mapped · total: ${firstSeen.size}/${fallback.size}`);
    }
  }

  console.log(`[refine] results:`);
  console.log(`  refined via GSC:        ${firstSeen.size}`);
  console.log(`  still at fallback:      ${fallback.size - firstSeen.size}`);

  // Apply
  for (const [u, d] of firstSeen) data[u] = d;

  if (args.dryRun) {
    console.log(`[refine] dry-run — file not written`);
    return;
  }

  const sorted = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  writeFileSync(args.out, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`[refine] wrote ${args.out}`);
}

main().catch(err => {
  console.error('[refine] fatal:', err);
  process.exit(2);
});
