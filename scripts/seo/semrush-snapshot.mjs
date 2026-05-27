#!/usr/bin/env node
/**
 * semrush-snapshot.mjs — F.1 Weekly SEMrush snapshot
 *
 * Captures a weekly SEO snapshot for `frontaliereticino.ch`:
 *   • domain_ranks      (database=it and database=ch)
 *   • top-50 organic keywords
 *   • competitor overview (top 10)
 *
 * Writes:
 *   • data/seo-snapshots/YYYY-MM-DD.json  (dated)
 *   • data/seo-snapshots/latest.json      (copy of dated file)
 *
 * Usage:
 *   node scripts/seo/semrush-snapshot.mjs              # calls SEMrush API
 *   node scripts/seo/semrush-snapshot.mjs --dry-run    # no HTTP, writes stub
 *
 * Environment:
 *   SEMRUSH_API_KEY   — required for non-dry-run mode.
 *                       If missing, the script logs a warning and writes
 *                       an empty-but-schema-valid snapshot (exit 0).
 *
 * Idempotent: re-running on the same UTC date overwrites that day's file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SNAPSHOT_DIR = join(ROOT, 'data', 'seo-snapshots');

const DOMAIN = 'frontaliereticino.ch';
const DATABASES = ['it', 'ch'];
const TOP_KW_LIMIT = 50;
const COMPETITOR_LIMIT = 10;

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

function emptySnapshot(date, reason) {
  return {
    version: 1,
    domain: DOMAIN,
    capturedAt: new Date().toISOString(),
    date,
    reason,
    domainRanks: {},
    topKeywords: {},
    competitors: {},
  };
}

/**
 * Parse SEMrush CSV-style responses (semicolon-separated, first line is header).
 * Returns array of objects keyed by header name.
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

async function fetchDomainRank(apiKey, database) {
  const text = await callSemrush({
    type: 'domain_ranks',
    key: apiKey,
    domain: DOMAIN,
    database,
    export_columns: 'Db,Dn,Rk,Or,Ot,Oc,Ad,At,Ac',
  });
  const rows = parseSemrushCsv(text);
  return rows[0] || null;
}

async function fetchTopKeywords(apiKey, database) {
  const text = await callSemrush({
    type: 'domain_organic',
    key: apiKey,
    domain: DOMAIN,
    database,
    display_limit: TOP_KW_LIMIT,
    display_sort: 'tr_desc',
    export_columns: 'Ph,Po,Pp,Nq,Cp,Ur,Tr,Tc,Co,Nr,Td',
  });
  return parseSemrushCsv(text);
}

async function fetchCompetitors(apiKey, database) {
  const text = await callSemrush({
    type: 'domain_organic_organic',
    key: apiKey,
    domain: DOMAIN,
    database,
    display_limit: COMPETITOR_LIMIT,
    export_columns: 'Dn,Cr,Np,Or,Ot,Oc,Ad',
  });
  return parseSemrushCsv(text);
}

async function collectForDatabase(apiKey, database, warnings) {
  const out = {
    domainRank: null,
    topKeywords: [],
    competitors: [],
  };
  try {
    out.domainRank = await fetchDomainRank(apiKey, database);
  } catch (err) {
    warnings.push(`[${database}] domain_rank: ${err.message}`);
  }
  try {
    out.topKeywords = await fetchTopKeywords(apiKey, database);
  } catch (err) {
    warnings.push(`[${database}] top_keywords: ${err.message}`);
  }
  try {
    out.competitors = await fetchCompetitors(apiKey, database);
  } catch (err) {
    warnings.push(`[${database}] competitors: ${err.message}`);
  }
  return out;
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const today = isoDate();
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const datedPath = join(SNAPSHOT_DIR, `${today}.json`);
  const latestPath = join(SNAPSHOT_DIR, 'latest.json');

  const apiKey = process.env.SEMRUSH_API_KEY;

  if (dryRun) {
    console.log('[semrush-snapshot] --dry-run: skipping API calls');
    const snap = emptySnapshot(today, 'dry-run');
    writeFileSync(datedPath, JSON.stringify(snap, null, 2));
    writeFileSync(latestPath, JSON.stringify(snap, null, 2));
    console.log(`[semrush-snapshot] wrote stub → ${datedPath}`);
    return;
  }

  if (!apiKey) {
    console.warn('[semrush-snapshot] SEMRUSH_API_KEY not set — writing empty snapshot');
    const snap = emptySnapshot(today, 'no-api-key');
    writeFileSync(datedPath, JSON.stringify(snap, null, 2));
    writeFileSync(latestPath, JSON.stringify(snap, null, 2));
    return;
  }

  const warnings = [];
  const snap = {
    version: 1,
    domain: DOMAIN,
    capturedAt: new Date().toISOString(),
    date: today,
    domainRanks: {},
    topKeywords: {},
    competitors: {},
  };

  for (const db of DATABASES) {
    try {
      const collected = await collectForDatabase(apiKey, db, warnings);
      snap.domainRanks[db] = collected.domainRank;
      snap.topKeywords[db] = collected.topKeywords;
      snap.competitors[db] = collected.competitors;
    } catch (err) {
      warnings.push(`[${db}] unexpected: ${err.message}`);
      snap.domainRanks[db] = null;
      snap.topKeywords[db] = [];
      snap.competitors[db] = [];
    }
  }

  if (warnings.length > 0) {
    snap.warnings = warnings;
    for (const w of warnings) console.warn(`[semrush-snapshot] ${w}`);
  }

  writeFileSync(datedPath, JSON.stringify(snap, null, 2));
  writeFileSync(latestPath, JSON.stringify(snap, null, 2));
  console.log(`[semrush-snapshot] wrote → ${datedPath} (${Object.keys(snap.topKeywords).length} databases)`);
}

// Entry point — graceful failure keeps CI green.
main().catch((err) => {
  console.error('[semrush-snapshot] fatal:', err);
  try {
    const today = isoDate();
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const snap = emptySnapshot(today, `fatal: ${err.message}`);
    writeFileSync(join(SNAPSHOT_DIR, `${today}.json`), JSON.stringify(snap, null, 2));
    writeFileSync(join(SNAPSHOT_DIR, 'latest.json'), JSON.stringify(snap, null, 2));
  } catch (inner) {
    console.error('[semrush-snapshot] could not write fallback:', inner);
  }
  process.exit(0);
});

export {
  parseSemrushCsv,
  emptySnapshot,
  isoDate,
  DOMAIN,
  DATABASES,
  TOP_KW_LIMIT,
};
