#!/usr/bin/env node
/**
 * check-gsc-frontaliere-baseline.mjs  —  Cathedral Phase 3 / T3.2
 *
 * Brand dilution monitor: pulls top-20 GSC search queries that contain
 * "frontalier" (case-insensitive — covers frontaliere/frontalieri/
 * frontaliers/frontalières/frontaliere ticino/etc.) over the last 14 days
 * for `sc-domain:frontaliereticino.ch`, then compares each query's average
 * position against `data/gsc-frontaliere-baseline.json`.
 *
 * Decision D11 (Phase 1, deferred but accepted-risk): if any baseline query
 * drops ≥3 positions, emit BRAND_DRIFT alert + non-zero exit so the weekly
 * workflow opens a GitHub issue.
 *
 * Auth: Firebase Service Account.
 *   - Local: `mcp-gsc-main/service_account_credentials.json`
 *           (memory: reference_firebase_sa_doubles_as_gsc.md).
 *   - CI:    GOOGLE_APPLICATION_CREDENTIALS env (path to SA json).
 *   The same SA has Search Console read permission, so we sign a JWT
 *   manually (no extra deps).
 *
 * Usage:
 *   node scripts/check-gsc-frontaliere-baseline.mjs
 *   node scripts/check-gsc-frontaliere-baseline.mjs --update-baseline
 *
 * Exit codes:
 *   0 — first run (baseline written), no drift, or graceful skip (SA missing).
 *   1 — at least one baseline query dropped ≥ DRIFT_THRESHOLD positions.
 *
 * Output:
 *   data/gsc-frontaliere-baseline.json        — top-20 baseline (rank per query)
 *   data/gsc-frontaliere-monitor-report.json  — current positions + delta vs baseline
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const GSC_PROPERTY = 'sc-domain:frontaliereticino.ch';
const LOOKBACK_DAYS = 14;
const TOP_N = 20;
const DRIFT_THRESHOLD = 3; // ≥3 positions worse → alert
const ROW_LIMIT = 25000;
const QUERY_FILTER_SUBSTRING = 'frontalier'; // case-insensitive containsAny

const BASELINE_PATH = path.join(ROOT, 'data', 'gsc-frontaliere-baseline.json');
const REPORT_PATH = path.join(ROOT, 'data', 'gsc-frontaliere-monitor-report.json');

const ARGS = new Set(process.argv.slice(2));
const UPDATE_BASELINE = ARGS.has('--update-baseline');

// ── Helpers ─────────────────────────────────────────────────────────────
function log(prefix, msg) {
  console.log(`${prefix} ${msg}`);
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function writeJson(p, payload) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  log('💾', `Wrote ${path.relative(ROOT, p)}`);
}
function writeReport(payload) {
  writeJson(REPORT_PATH, payload);
}
function gracefulSkip(reason) {
  log('⚠️', reason);
  writeReport({
    _generatedAt: new Date().toISOString(),
    _skipped: true,
    _reason: reason,
    _gscProperty: GSC_PROPERTY,
    queries: [],
    drifts: [],
  });
  process.exit(0);
}

// ── Service Account discovery ───────────────────────────────────────────
function loadServiceAccount() {
  // 1. CI / explicit path via GOOGLE_APPLICATION_CREDENTIALS
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) {
    try {
      return JSON.parse(fs.readFileSync(envPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse SA at ${envPath}: ${e.message}`);
    }
  }
  // 2. Inline JSON via FIREBASE_SERVICE_ACCOUNT_JSON env
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (e) {
      throw new Error(`Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON env: ${e.message}`);
    }
  }
  // 3. Local default
  const expected = path.join(ROOT, 'mcp-gsc-main', 'service_account_credentials.json');
  if (fs.existsSync(expected)) {
    try {
      return JSON.parse(fs.readFileSync(expected, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse SA at ${expected}: ${e.message}`);
    }
  }
  // 4. Fallback: any *.json in mcp-gsc-main/
  const dir = path.join(ROOT, 'mcp-gsc-main');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j && j.type === 'service_account' && j.private_key && j.client_email) {
          log('ℹ️', `Using SA fallback: ${f}`);
          return j;
        }
      } catch {
        // ignore
      }
    }
  }
  throw new Error('No usable service_account JSON found (env or mcp-gsc-main/)');
}

// ── JWT → access token (no extra deps) ──────────────────────────────────
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
async function getAccessTokenFromSA(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(sa.private_key);
  const jwt = `${unsigned}.${base64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Token exchange returned no access_token');
  return data.access_token;
}

// ── GSC Search Analytics query ──────────────────────────────────────────
// Pre-filter at the API level on query containing "frontalier" — saves
// quota by making the API return only matching rows.
async function queryFrontaliereTerms(token, startDate, endDate) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_PROPERTY)}/searchAnalytics/query`;
  const body = {
    startDate,
    endDate,
    dimensions: ['query'],
    rowLimit: ROW_LIMIT,
    type: 'web',
    dimensionFilterGroups: [
      {
        filters: [
          {
            dimension: 'query',
            operator: 'contains',
            expression: QUERY_FILTER_SUBSTRING, // GSC contains is case-insensitive
          },
        ],
      },
    ],
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Search Analytics query failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.rows || [];
}

// ── Baseline I/O ────────────────────────────────────────────────────────
function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    if (j && j._pendingFirstRun) return null; // treat placeholder as missing
    return j;
  } catch (e) {
    log('⚠️', `Baseline parse error: ${e.message} — treating as missing`);
    return null;
  }
}

function buildBaselinePayload(top, dateRange) {
  return {
    _generatedAt: new Date().toISOString(),
    _gscProperty: GSC_PROPERTY,
    _lookbackDays: LOOKBACK_DAYS,
    _topN: TOP_N,
    _driftThreshold: DRIFT_THRESHOLD,
    _dateRange: dateRange,
    queries: top.map((r) => ({
      query: r.query,
      position: round1(r.position),
      clicks: r.clicks,
      impressions: r.impressions,
    })),
  };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  log('🔎', 'check-gsc-frontaliere-baseline — Cathedral Phase 3 / T3.2');
  log('ℹ️', `Update-baseline mode: ${UPDATE_BASELINE ? 'YES' : 'no'}`);

  let sa;
  try {
    sa = loadServiceAccount();
    log('ℹ️', `Loaded SA: ${sa.client_email}`);
  } catch (e) {
    return gracefulSkip(`SA load failed: ${e.message}`);
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const startStr = isoDate(startDate);
  const endStr = isoDate(endDate);
  const dateRange = `${startStr} to ${endStr}`;
  log('📅', `Date range: ${dateRange}`);

  let token;
  try {
    token = await getAccessTokenFromSA(sa);
    log('✅', 'Acquired GSC access token');
  } catch (e) {
    return gracefulSkip(`Auth failed: ${e.message}`);
  }

  let rows;
  try {
    rows = await queryFrontaliereTerms(token, startStr, endStr);
  } catch (e) {
    return gracefulSkip(`GSC query failed: ${e.message}`);
  }
  log('ℹ️', `GSC returned ${rows.length} rows containing "${QUERY_FILTER_SUBSTRING}"`);

  // Sanitise + sort by impressions desc (reach is the brand-dilution canary,
  // not clicks — a query at rank 9 with high impressions and 0 clicks still
  // signals brand erosion if it slips to rank 12).
  const enriched = rows
    .map((r) => ({
      query: (r.keys && r.keys[0]) || '',
      position: Number(r.position) || 0,
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
    }))
    .filter((r) => r.query && r.query.toLowerCase().includes(QUERY_FILTER_SUBSTRING))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);

  const top = enriched.slice(0, TOP_N);
  if (top.length === 0) {
    return gracefulSkip('GSC returned 0 frontaliere queries — no baseline to write/check');
  }

  const baseline = readBaseline();

  // ── First run (or explicit baseline update) ──
  if (!baseline || UPDATE_BASELINE) {
    const payload = buildBaselinePayload(top, dateRange);
    writeJson(BASELINE_PATH, payload);
    writeReport({
      _generatedAt: new Date().toISOString(),
      _gscProperty: GSC_PROPERTY,
      _dateRange: dateRange,
      _mode: baseline ? 'baseline-updated' : 'first-run',
      _driftDetected: false,
      _driftThreshold: DRIFT_THRESHOLD,
      queries: payload.queries.map((q) => ({ ...q, baselinePosition: q.position, delta: 0 })),
      drifts: [],
    });
    log('✅', baseline ? 'Baseline updated.' : 'First-run baseline written. No drift check this run.');
    process.exit(0);
  }

  // ── Diff against baseline ──
  const baselineByQuery = new Map(baseline.queries.map((q) => [q.query, q.position]));
  const reportRows = [];
  const drifts = [];
  for (const cur of top) {
    const oldPos = baselineByQuery.get(cur.query);
    const delta = oldPos != null ? round1(cur.position - oldPos) : null; // >0 = worse rank
    reportRows.push({
      query: cur.query,
      position: round1(cur.position),
      clicks: cur.clicks,
      impressions: cur.impressions,
      baselinePosition: oldPos != null ? oldPos : null,
      delta,
      newSinceBaseline: oldPos == null,
    });
    if (oldPos != null && delta >= DRIFT_THRESHOLD) {
      drifts.push({
        query: cur.query,
        oldRank: oldPos,
        newRank: round1(cur.position),
        delta,
      });
    }
  }

  // Also flag baseline queries that disappeared from the current top (=
  // dropped out of top-20-by-impressions; treat as drift if we have any
  // signal at all).
  const currentByQuery = new Map(top.map((r) => [r.query, r]));
  for (const b of baseline.queries) {
    if (!currentByQuery.has(b.query)) {
      drifts.push({
        query: b.query,
        oldRank: b.position,
        newRank: null,
        delta: null,
        note: 'dropped out of top-20 by impressions',
      });
    }
  }

  const report = {
    _generatedAt: new Date().toISOString(),
    _gscProperty: GSC_PROPERTY,
    _dateRange: dateRange,
    _mode: 'monitor',
    _driftDetected: drifts.length > 0,
    _driftThreshold: DRIFT_THRESHOLD,
    _baselineGeneratedAt: baseline._generatedAt,
    queries: reportRows,
    drifts,
  };
  writeReport(report);

  // ── Console summary ──
  log('', '');
  log('📊', `Top-${top.length} frontaliere queries vs baseline (${baseline._generatedAt?.slice(0, 10) || 'n/a'})`);
  log('', `${'Query'.padEnd(48)} ${'Pos'.padStart(6)} ${'Base'.padStart(6)} ${'Δ'.padStart(6)}`);
  log('', '─'.repeat(72));
  for (const r of reportRows) {
    const dStr = r.delta == null ? '  new' : (r.delta > 0 ? '+' : '') + String(r.delta);
    const baseStr = r.baselinePosition == null ? '  —' : String(r.baselinePosition);
    log('', `${r.query.slice(0, 48).padEnd(48)} ${String(r.position).padStart(6)} ${baseStr.padStart(6)} ${dStr.padStart(6)}`);
  }
  log('', '─'.repeat(72));

  if (drifts.length === 0) {
    log('✅', 'No brand drift detected.');
    process.exit(0);
  }

  log('🚨', `${drifts.length} brand drift(s) detected:`);
  for (const d of drifts) {
    const newStr = d.newRank == null ? 'OUT' : String(d.newRank);
    console.log(`[GSC-MONITOR] BRAND_DRIFT: ${d.query} ${d.oldRank} → ${newStr}${d.note ? ` (${d.note})` : ''}`);
  }
  process.exit(1);
}

main().catch((err) => {
  log('💥', `Unexpected error: ${err.message || err}`);
  // Graceful: still write a report so the workflow can read it.
  try {
    writeReport({
      _generatedAt: new Date().toISOString(),
      _skipped: true,
      _reason: `Unexpected error: ${err.message || err}`,
      _gscProperty: GSC_PROPERTY,
      queries: [],
      drifts: [],
    });
  } catch {
    // ignore
  }
  process.exit(0);
});
