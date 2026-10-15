#!/usr/bin/env node
/**
 * detect-cannibalization.mjs — A.5 Weekly cannibalization detector
 *
 * Scans SEMrush `domain_organic` data for `frontaliereticino.ch` and flags
 * every query that ranks on more than one URL. This signals keyword
 * cannibalization, where two or more pages split link equity and SERP
 * visibility for the same term.
 *
 * Writes:
 *   • reports/cannibalization-YYYY-MM-DD.json   (dated)
 *   • reports/cannibalization-latest.json       (copy of dated file)
 *
 * Usage:
 *   node scripts/seo/detect-cannibalization.mjs              # calls SEMrush API
 *   node scripts/seo/detect-cannibalization.mjs --dry-run    # no HTTP, stub output
 *
 * Environment:
 *   SEMRUSH_API_KEY   — required for non-dry-run mode. If missing the script
 *                       writes an empty schema-valid report and exits 0 (CI-safe).
 *
 * Integrated with .github/workflows/semrush-weekly-snapshot.yml. The file
 * is idempotent: re-running on the same UTC date overwrites that day's JSON.
 *
 * Refs docs/seo-semrush-growth-plan.md Workstream A task A.5.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const REPORT_DIR = join(ROOT, 'reports');

const DOMAIN = 'frontaliereticino.ch';
const DATABASES = ['it', 'ch'];
// Pull a generous sample so we see the long tail where cannibalization
// typically lives (positions 15–50 where competing URLs trade rank).
const ORGANIC_LIMIT = 500;

const SEMRUSH_BASE = 'https://api.semrush.com/';

function isoDate(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
  };
}

function emptyReport(date, reason) {
  return {
    version: 1,
    domain: DOMAIN,
    capturedAt: new Date().toISOString(),
    date,
    reason,
    totalConflicts: 0,
    conflicts: [],
    byDatabase: {},
  };
}

/**
 * SEMrush CSV parser (semicolon-separated, first row header). Throws on
 * `ERROR ...` responses so callers can surface them as warnings.
 */
function parseSemrushCsv(text) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('ERROR')) {
    throw new Error(`SEMrush API error: ${trimmed}`);
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(';').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(';');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] !== undefined ? cols[i] : '';
    });
    return row;
  });
}

async function callSemrush(params) {
  const url = new URL(SEMRUSH_BASE);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${params.type}`);
  }
  return await res.text();
}

async function fetchOrganic(apiKey, database) {
  const text = await callSemrush({
    type: 'domain_organic',
    key: apiKey,
    domain: DOMAIN,
    database,
    display_limit: ORGANIC_LIMIT,
    display_sort: 'tr_desc',
    export_columns: 'Ph,Po,Pp,Nq,Cp,Ur,Tr,Tc,Co,Nr,Td',
  });
  return parseSemrushCsv(text);
}

/**
 * Group SEMrush `domain_organic` rows by query. A query with more than
 * one distinct URL is flagged as a cannibalization conflict.
 *
 * @param {Array<Record<string, string>>} rows
 * @returns {Array<{ keyword: string, volume: number, urls: Array<{ url: string, position: number, traffic: number }> }>}
 */
function groupConflicts(rows) {
  /** @type {Map<string, { keyword: string, volume: number, urls: Map<string, { url: string, position: number, traffic: number }> }>} */
  const byKeyword = new Map();

  for (const r of rows) {
    const keyword = (r.Ph || '').trim();
    const url = (r.Ur || '').trim();
    if (!keyword || !url) continue;
    const position = Number.parseInt(r.Po || '0', 10) || 0;
    const traffic = Number.parseFloat(r.Tr || '0') || 0;
    const volume = Number.parseInt(r.Nq || '0', 10) || 0;

    if (!byKeyword.has(keyword)) {
      byKeyword.set(keyword, { keyword, volume, urls: new Map() });
    }
    const entry = byKeyword.get(keyword);
    // Keep the highest-ranking (lowest position) snapshot when SEMrush
    // returns duplicate (query, URL) pairs across pagination buckets.
    const existing = entry.urls.get(url);
    if (!existing || position < existing.position) {
      entry.urls.set(url, { url, position, traffic });
    }
  }

  const conflicts = [];
  for (const entry of byKeyword.values()) {
    if (entry.urls.size < 2) continue;
    const urls = [...entry.urls.values()].sort((a, b) => a.position - b.position);
    conflicts.push({
      keyword: entry.keyword,
      volume: entry.volume,
      urls,
    });
  }
  conflicts.sort((a, b) => {
    // Prioritise high-volume conflicts with more competing URLs.
    if (b.urls.length !== a.urls.length) return b.urls.length - a.urls.length;
    return b.volume - a.volume;
  });
  return conflicts;
}

async function collectForDatabase(apiKey, database, warnings) {
  try {
    const rows = await fetchOrganic(apiKey, database);
    return { rows, conflicts: groupConflicts(rows) };
  } catch (err) {
    warnings.push(`[${database}] domain_organic: ${err.message}`);
    return { rows: [], conflicts: [] };
  }
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const today = isoDate();
  mkdirSync(REPORT_DIR, { recursive: true });
  const datedPath = join(REPORT_DIR, `cannibalization-${today}.json`);
  const latestPath = join(REPORT_DIR, 'cannibalization-latest.json');

  const apiKey = process.env.SEMRUSH_API_KEY;

  if (dryRun) {
    console.log('[detect-cannibalization] --dry-run: skipping API calls');
    const report = emptyReport(today, 'dry-run');
    writeFileSync(datedPath, JSON.stringify(report, null, 2));
    writeFileSync(latestPath, JSON.stringify(report, null, 2));
    console.log(`[detect-cannibalization] wrote stub → ${datedPath}`);
    return;
  }

  if (!apiKey) {
    console.warn('[detect-cannibalization] SEMRUSH_API_KEY not set — writing empty report');
    const report = emptyReport(today, 'no-api-key');
    writeFileSync(datedPath, JSON.stringify(report, null, 2));
    writeFileSync(latestPath, JSON.stringify(report, null, 2));
    return;
  }

  const warnings = [];
  /** @type {Record<string, ReturnType<typeof groupConflicts>>} */
  const byDatabase = {};
  let totalConflicts = 0;

  for (const db of DATABASES) {
    const { conflicts } = await collectForDatabase(apiKey, db, warnings);
    byDatabase[db] = conflicts;
    totalConflicts += conflicts.length;
  }

  // Flatten the per-DB conflicts into a single de-duped list so consumers
  // can iterate once. Keep the per-DB view too for drill-down.
  const seen = new Map();
  for (const [db, list] of Object.entries(byDatabase)) {
    for (const c of list) {
      const key = c.keyword.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, { ...c, databases: [db] });
      } else {
        const existing = seen.get(key);
        if (!existing.databases.includes(db)) existing.databases.push(db);
        // Merge URLs so the flat list shows every competing URL across DBs.
        const urlSet = new Map(existing.urls.map((u) => [u.url, u]));
        for (const u of c.urls) {
          const prev = urlSet.get(u.url);
          if (!prev || u.position < prev.position) urlSet.set(u.url, u);
        }
        existing.urls = [...urlSet.values()].sort((a, b) => a.position - b.position);
      }
    }
  }

  const conflicts = [...seen.values()].sort((a, b) => {
    if (b.urls.length !== a.urls.length) return b.urls.length - a.urls.length;
    return b.volume - a.volume;
  });

  const report = {
    version: 1,
    domain: DOMAIN,
    capturedAt: new Date().toISOString(),
    date: today,
    totalConflicts: conflicts.length,
    conflicts,
    byDatabase,
  };

  if (warnings.length > 0) {
    report.warnings = warnings;
    for (const w of warnings) console.warn(`[detect-cannibalization] ${w}`);
  }

  writeFileSync(datedPath, JSON.stringify(report, null, 2));
  writeFileSync(latestPath, JSON.stringify(report, null, 2));
  console.log(
    `[detect-cannibalization] wrote → ${datedPath} (${conflicts.length} deduped conflicts, ${totalConflicts} raw)`,
  );
}

// Entry point — graceful failure keeps CI green. Matches the pattern
// used by semrush-snapshot.mjs and semrush-site-audit.mjs.
main().catch((err) => {
  console.error('[detect-cannibalization] fatal:', err);
  try {
    const today = isoDate();
    mkdirSync(REPORT_DIR, { recursive: true });
    const report = emptyReport(today, `fatal: ${err.message}`);
    writeFileSync(join(REPORT_DIR, `cannibalization-${today}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(REPORT_DIR, 'cannibalization-latest.json'), JSON.stringify(report, null, 2));
  } catch (inner) {
    console.error('[detect-cannibalization] could not write fallback:', inner);
  }
  process.exit(0);
});

export {
  parseSemrushCsv,
  emptyReport,
  isoDate,
  groupConflicts,
  DOMAIN,
  DATABASES,
  ORGANIC_LIMIT,
};
