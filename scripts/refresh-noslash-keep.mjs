#!/usr/bin/env node
/**
 * Refresh data/noslash-keep.json — the union of job-section URL paths that
 * receive ANY measurable traffic without a trailing slash, sourced from:
 *   1. Google Search Console (SEO impressions)
 *   2. Google Analytics 4 (pageviews)
 *   3. PostHog (pageviews)
 *
 * These are the flat `.html` shadows we MUST keep emitting in dist/ so the
 * 200-OK direct serve at the no-slash form is preserved and we don't lose
 * the indexed entry's link equity / referral traffic.
 *
 * Background:
 *   `_qwFlat` / `_qwFlatFull` in build-plugins/jobsSeoPagesPlugin.ts
 *   normally SKIP the flat `.html` emission for any path under a job
 *   section (`/cerca-lavoro-*`, `/en/find-jobs-*`, `/de/jobs-im-*`,
 *   `/fr/trouver-emploi-*`) — these flats account for ~470 k files
 *   (~2.3 GB raw) and serve only ~0.057 % of GSC impressions.
 *
 *   This script carves out the small set of job-section paths that ANY
 *   traffic source reports as still active so the build keeps emitting
 *   those specific flats and we lose zero traffic.
 *
 * Auth:
 *   - GSC: Firebase Service Account (same as scripts/check-gsc-frontaliere-baseline.mjs)
 *   - GA4: GA4_PROPERTY_ID env + GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON
 *   - PostHog: POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID env
 *
 *   Missing sources are silently skipped (best-effort union).
 *
 * Output (data/noslash-keep.json):
 *   {
 *     "refreshedAt": "2026-05-27T13:45:00.000Z",
 *     "lookbackDays": 90,
 *     "sources": {
 *       "gsc":     { "ok": true,  "noSlashSeen": 671, "jobSectionKept": 3 },
 *       "ga4":     { "ok": false, "reason": "missing creds" },
 *       "posthog": { "ok": false, "reason": "missing creds" }
 *     },
 *     "keepCount": 3,
 *     "keepPaths": [ "/cerca-lavoro-ticino/<slug>", ... ]
 *   }
 *
 * Usage:
 *   node scripts/refresh-gsc-noslash-keep.mjs                 # 90 days, threshold 1
 *   node scripts/refresh-gsc-noslash-keep.mjs --days 180
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'noslash-keep.json');
const SITE = 'sc-domain:frontaliereticino.ch';

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
const days = parseInt(arg('--days', '90'), 10);
const minImpressions = parseInt(arg('--min-impressions', '1'), 10);

const JOB_SECTION_RX = /^\/(cerca-lavoro-|en\/find-jobs-|de\/jobs-im-|fr\/trouver-emploi-)/;

function loadServiceAccount() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) {
    return JSON.parse(fs.readFileSync(envPath, 'utf8'));
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const local = path.join(ROOT, 'mcp-gsc-main', 'service_account_credentials.json');
  if (fs.existsSync(local)) {
    return JSON.parse(fs.readFileSync(local, 'utf8'));
  }
  return null;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(sa, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claims = {
    iss: sa.client_email,
    scope: scopes,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const jwt = `${unsigned}.${base64url(signer.sign(sa.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('no access_token');
  return data.access_token;
}

function pathFromUrl(u) {
  try {
    return new URL(u).pathname;
  } catch {
    if (typeof u === 'string' && u.startsWith('/')) return u;
    return null;
  }
}

function isJobNoSlash(p) {
  return p && !p.endsWith('/') && !p.endsWith('.html') && p !== '/' && JOB_SECTION_RX.test(p);
}

async function fetchGsc(sa, startDate, endDate) {
  const token = await getAccessToken(sa, 'https://www.googleapis.com/auth/webmasters.readonly');
  const rows = [];
  let startRow = 0;
  for (let i = 0; i < 10; i++) {
    const body = { startDate, endDate, dimensions: ['page'], rowLimit: 25000, startRow, type: 'web' };
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GSC ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.rows || data.rows.length === 0) break;
    rows.push(...data.rows);
    if (data.rows.length < 25000) break;
    startRow += data.rows.length;
  }
  return rows;
}

async function fetchGa4(sa, startDate, endDate) {
  const propertyIdRaw = process.env.GA4_PROPERTY_ID;
  if (!propertyIdRaw) throw new Error('GA4_PROPERTY_ID unset');
  const propertyId = propertyIdRaw.startsWith('properties/') ? propertyIdRaw : `properties/${propertyIdRaw}`;
  const token = await getAccessToken(sa, 'https://www.googleapis.com/auth/analytics.readonly');
  const url = `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      limit: 100000,
    }),
  });
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.rows || []).map((r) => ({
    path: r.dimensionValues?.[0]?.value || '',
    views: parseInt(r.metricValues?.[0]?.value || '0', 10),
  }));
}

async function fetchPosthog(startDate, endDate) {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  if (!apiKey || !projectId) throw new Error('POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID unset');
  const query = `
    SELECT properties.$pathname AS path, count() AS views
    FROM events
    WHERE event = '$pageview'
      AND properties.$pathname IS NOT NULL
      AND properties.$pathname LIKE '/cerca-lavoro-%' OR properties.$pathname LIKE '/en/find-jobs-%' OR properties.$pathname LIKE '/de/jobs-im-%' OR properties.$pathname LIKE '/fr/trouver-emploi-%'
      AND timestamp >= toDateTime('${startDate} 00:00:00')
      AND timestamp <= toDateTime('${endDate} 23:59:59')
    GROUP BY path
    LIMIT 5000
  `.trim();
  const url = `${host}/api/projects/${projectId}/query/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.results || []).map((row) => ({ path: row[0], views: row[1] }));
}

async function main() {
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startD = new Date(today);
  startD.setDate(startD.getDate() - days);
  const startDate = startD.toISOString().slice(0, 10);

  console.error(`[noslash-keep] lookback ${startDate} → ${endDate} (${days} days), min impressions/views = ${minImpressions}`);

  const keep = new Set();
  const sources = { gsc: { ok: false }, ga4: { ok: false }, posthog: { ok: false } };
  const sa = loadServiceAccount();

  // ─── GSC ───────────────────────────────────────────────────────────────
  if (sa) {
    try {
      const rows = await fetchGsc(sa, startDate, endDate);
      let noSlashSeen = 0, kept = 0;
      for (const row of rows) {
        const p = pathFromUrl(row.keys?.[0]);
        if (!p || p.endsWith('/') || p.endsWith('.html') || p === '/') continue;
        noSlashSeen += 1;
        if (!JOB_SECTION_RX.test(p)) continue;
        if (row.impressions < minImpressions) continue;
        keep.add(p);
        kept += 1;
      }
      sources.gsc = { ok: true, rowsScanned: rows.length, noSlashSeen, jobSectionKept: kept };
      console.error(`[noslash-keep] GSC: ${kept} job-section paths kept from ${noSlashSeen} no-slash URLs (${rows.length} rows scanned)`);
    } catch (err) {
      sources.gsc = { ok: false, reason: err.message };
      console.error(`[noslash-keep] GSC: ${err.message}`);
    }
  } else {
    sources.gsc = { ok: false, reason: 'no service account' };
    console.error('[noslash-keep] GSC: no service account');
  }

  // ─── GA4 ───────────────────────────────────────────────────────────────
  if (sa && process.env.GA4_PROPERTY_ID) {
    try {
      const rows = await fetchGa4(sa, startDate, endDate);
      let noSlashSeen = 0, kept = 0;
      for (const row of rows) {
        const p = row.path;
        if (!p || p.endsWith('/') || p.endsWith('.html') || p === '/') continue;
        noSlashSeen += 1;
        if (!JOB_SECTION_RX.test(p)) continue;
        if (row.views < minImpressions) continue;
        keep.add(p);
        kept += 1;
      }
      sources.ga4 = { ok: true, rowsScanned: rows.length, noSlashSeen, jobSectionKept: kept };
      console.error(`[noslash-keep] GA4: ${kept} job-section paths kept from ${noSlashSeen} no-slash paths (${rows.length} rows)`);
    } catch (err) {
      sources.ga4 = { ok: false, reason: err.message };
      console.error(`[noslash-keep] GA4: ${err.message}`);
    }
  } else {
    sources.ga4 = { ok: false, reason: 'missing GA4_PROPERTY_ID or service account' };
    console.error('[noslash-keep] GA4: skipped (missing credentials)');
  }

  // ─── PostHog ───────────────────────────────────────────────────────────
  if (process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID) {
    try {
      const rows = await fetchPosthog(startDate, endDate);
      let noSlashSeen = 0, kept = 0;
      for (const row of rows) {
        const p = row.path;
        if (!p || p.endsWith('/') || p.endsWith('.html') || p === '/') continue;
        noSlashSeen += 1;
        if (!JOB_SECTION_RX.test(p)) continue;
        if (row.views < minImpressions) continue;
        keep.add(p);
        kept += 1;
      }
      sources.posthog = { ok: true, rowsScanned: rows.length, noSlashSeen, jobSectionKept: kept };
      console.error(`[noslash-keep] PostHog: ${kept} job-section paths kept from ${noSlashSeen} no-slash paths (${rows.length} rows)`);
    } catch (err) {
      sources.posthog = { ok: false, reason: err.message };
      console.error(`[noslash-keep] PostHog: ${err.message}`);
    }
  } else {
    sources.posthog = { ok: false, reason: 'missing POSTHOG_* env' };
    console.error('[noslash-keep] PostHog: skipped (missing credentials)');
  }

  // ─── Merge previous keep-list to avoid losing entries when a source is
  // temporarily unavailable. The keep-list is a UNION across days, refreshed
  // periodically — paths only disappear when a source explicitly says "no
  // traffic" AND no other source disputes (and even then the policy below
  // keeps them: we prefer to over-emit by a few KB than to lose any URL).
  let prev = null;
  if (fs.existsSync(OUT_PATH)) {
    try {
      prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    } catch {
      prev = null;
    }
  }
  if (prev && Array.isArray(prev.keepPaths)) {
    for (const p of prev.keepPaths) keep.add(p);
  }

  const keepPaths = Array.from(keep).sort();
  const output = {
    refreshedAt: new Date().toISOString(),
    lookbackDays: days,
    minImpressions,
    sources,
    keepCount: keepPaths.length,
    keepPaths,
  };
  writeJsonAtomic(OUT_PATH, output);
  console.error(`[noslash-keep] Wrote ${OUT_PATH} — ${keepPaths.length} keep paths total (union of GSC/GA4/PostHog + previous keep-list)`);
}

main().catch((err) => {
  console.error('[noslash-keep] Fatal:', err.message);
  process.exit(1);
});
