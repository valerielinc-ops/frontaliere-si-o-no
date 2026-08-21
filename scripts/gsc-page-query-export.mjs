#!/usr/bin/env node
/**
 * Export the query-level Search Console performance for ONE page —
 * "Fase 2: export query corretto per singola pagina" della GSC content-gap
 * playbook (issue #6221, docs/gsc-content-refresh-playbook.md).
 *
 * Writes a CSV (query,clicks,impressions,ctr,position,nearWin) meant to be
 * pasted into the playbook's LLM prompt alongside the page content, plus a
 * JSON sidecar with export metadata (page, period, row count) for the audit
 * trail the playbook asks to keep. Read-only — never edits page content.
 *
 * Usage:
 *   node scripts/gsc-page-query-export.mjs --page=/guida-frontaliere/permesso-g
 *     [--days=90] [--row-limit=1000] [--out=data/gsc-content-refresh]
 *
 * Auth strategy (tries in order):
 *   1. OAuth2 refresh-token (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN)
 *   2. Service Account (GOOGLE_APPLICATION_CREDENTIALS)
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getServiceAccountToken } from './lib/ga4-service-account.mjs';
import { buildNearWinQueries } from './lib/analytics-opportunity-utils.mjs';

const SITE = 'sc-domain:frontaliereticino.ch';
const SITE_URL = 'https://frontaliereticino.ch';
const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
// 1000 rows matches the GSC UI export cap referenced in the playbook — a
// per-page query list rarely needs more, and a bigger default risks pulling
// long-tail noise the LLM prompt isn't meant to cluster.
const DEFAULT_ROW_LIMIT = 1000;

function argFlag(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

async function getOAuthToken() {
  const id = process.env.GSC_CLIENT_ID;
  const secret = process.env.GSC_CLIENT_SECRET;
  const refresh = process.env.GSC_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) {
    console.error(`OAuth token refresh failed (${r.status}): ${await r.text()}`);
    return null;
  }
  return (await r.json()).access_token;
}

async function getToken() {
  const oauth = await getOAuthToken();
  if (oauth) return oauth;
  const sa = await getServiceAccountToken([GSC_READONLY_SCOPE]);
  if (sa) return sa;
  throw new Error(
    'No GSC credentials available. Set GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN ' +
    'or GOOGLE_APPLICATION_CREDENTIALS pointing at a SA with GSC access.',
  );
}

const fmt = (d) => d.toISOString().slice(0, 10);

function toCsvValue(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function slugForPage(pagePath) {
  const stripped = pagePath.replace(/^\//, '').replace(/\/$/, '');
  return (stripped || 'home').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

async function main() {
  const pageArg = argFlag('page', null);
  if (!pageArg) {
    console.error('Missing --page=<path o URL completo>. Esempio: --page=/guida-frontaliere/permesso-g');
    process.exit(1);
    return;
  }
  const days = Number(argFlag('days', '90'));
  const rowLimit = Number(argFlag('row-limit', String(DEFAULT_ROW_LIMIT)));
  const outDir = argFlag('out', 'data/gsc-content-refresh');

  const pageUrl = pageArg.startsWith('http') ? pageArg : `${SITE_URL}${pageArg.startsWith('/') ? pageArg : `/${pageArg}`}`;
  const pagePath = pageUrl.replace(SITE_URL, '');

  const token = await getToken();
  const today = new Date();
  const end = new Date(today); end.setDate(end.getDate() - 2); // GSC ha un ritardo di 2 giorni
  const start = new Date(end); start.setDate(start.getDate() - days);

  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['query'],
      dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }] }],
      rowLimit,
    }),
  });
  if (!res.ok) throw new Error(`GSC API request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const rows = data.rows || [];

  const queries = rows.map((r) => ({
    query: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: Number((r.ctr * 100).toFixed(2)),
    position: Number(r.position.toFixed(1)),
  }));
  const nearWin = new Set(buildNearWinQueries(queries).map((q) => q.query));

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const slug = slugForPage(pagePath);
  const csvOut = join(outDir, `${slug}.csv`);
  const jsonOut = join(outDir, `${slug}.json`);

  const csv = [
    'query,clicks,impressions,ctr,position,nearWin',
    ...queries.map((q) =>
      [toCsvValue(q.query), q.clicks, q.impressions, q.ctr, q.position, nearWin.has(q.query) ? 'true' : 'false'].join(',')
    ),
  ].join('\n') + '\n';
  writeFileSync(csvOut, csv);

  const meta = {
    page: pagePath,
    pageUrl,
    window: { start: fmt(start), end: fmt(end) },
    exportedAt: new Date().toISOString(),
    rowCount: queries.length,
    nearWinCount: nearWin.size,
  };
  writeFileSync(jsonOut, JSON.stringify(meta, null, 2));

  console.log(`GSC query export per ${pagePath}: ${queries.length} query (${nearWin.size} near-win) -> ${csvOut}`);
  console.log('Prossimo passo: docs/gsc-content-refresh-template.md (prompt LLM) con questo CSV + il contenuto della pagina.');
}

main().catch((err) => {
  console.error(`gsc-page-query-export failed: ${err.message}`);
  process.exit(1);
});
