#!/usr/bin/env node
/**
 * Rank editorial pages by content-refresh opportunity using Search Console
 * page-level performance (impressions, CTR, avg position).
 *
 * "Fase 1: selezione pagine candidate" of the GSC content-gap playbook
 * (issue #6221, docs/gsc-content-refresh-playbook.md). Read-only — it never
 * edits page content, only ranks candidates for a human/LLM to review next
 * with scripts/gsc-page-query-export.mjs.
 *
 * Usage:
 *   node scripts/gsc-content-opportunity-score.mjs [--days=90] [--top=15]
 *     [--weights=path/to/weights.json] [--out=data/gsc-content-refresh]
 *
 * --weights: optional JSON file mapping a path-prefix to a businessValue
 *   override in [0,1], e.g. {"/guida-frontaliere": 0.8}. Unmatched paths
 *   default to a neutral 0.5 (see scripts/lib/gsc-opportunity-scoring.mjs).
 *
 * Auth strategy (tries in order):
 *   1. OAuth2 refresh-token (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN)
 *   2. Service Account (GOOGLE_APPLICATION_CREDENTIALS) — the Firebase SA also
 *      has GSC permissions (see memory `reference_firebase_sa_doubles_as_gsc`)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getServiceAccountToken } from './lib/ga4-service-account.mjs';
import { classifyAnalyticsPath } from './lib/analytics-opportunity-utils.mjs';
import { rankPageOpportunities } from './lib/gsc-opportunity-scoring.mjs';

const SITE = 'sc-domain:frontaliereticino.ch';
const SITE_URL = 'https://frontaliereticino.ch';
const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

// Editorial content groups only — jobs/account/community/marketing pages are
// auto-generated or user-generated, not candidates for editorial content
// refresh (see "Criteri suggeriti di priorità" nel playbook).
//
// `tools` (calcolatore stipendio, comparatore) e `core` (homepage) sono
// inclusi DI PROPOSITO, non per svista: docs/gsc-content-refresh-playbook.md
// (Fase 1) li elenca esplicitamente tra le pagine editoriali in scope
// ("articoli, guide, statistiche, tool, glossario, home"). A differenza di
// job/account/community non sono generati/gestiti altrove — hanno prosa
// curata (spiegazioni, FAQ, testo esplicativo) soggetta allo stesso
// content-gap delle pagine editoriali pure, quindi restano candidate valide
// per il refresh.
const EDITORIAL_CONTENT_GROUPS = new Set(['articles', 'guides', 'stats', 'tools', 'reference', 'core']);

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

function loadWeights(path) {
  if (!path) return {};
  if (!existsSync(path)) {
    console.error(`--weights file not found: ${path} — continuo con business_value neutro (0.5)`);
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// searchanalytics.query non espone un `orderBy`: l'ordine di default è per
// click decrescenti (dimension `page`, no `date`) — proprio l'opposto di ciò
// che serve al content-gap, che cerca pagine ad alta impression/basso click:
// quelle finiscono in coda ai risultati e sarebbero le prime tagliate da un
// rowLimit fisso. Paginiamo con `startRow` fino a esaurire i risultati
// (rowLimit massimo consentito dall'API = 25000) invece di troncare a 5000.
const GSC_QUERY_ROW_LIMIT = 25000;
const GSC_QUERY_MAX_PAGES = 8; // safety cap: 8 * 25000 = 200000 righe

async function fetchPagePerformance(token, days) {
  const today = new Date();
  const end = new Date(today); end.setDate(end.getDate() - 2); // GSC ha un ritardo di 2 giorni
  const start = new Date(end); start.setDate(start.getDate() - days);

  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;
  const rows = [];
  for (let page = 0; page < GSC_QUERY_MAX_PAGES; page += 1) {
    const startRow = page * GSC_QUERY_ROW_LIMIT;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: fmt(start),
        endDate: fmt(end),
        dimensions: ['page'],
        rowLimit: GSC_QUERY_ROW_LIMIT,
        startRow,
      }),
    });
    if (!res.ok) throw new Error(`GSC API request failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    const batch = data.rows || [];
    rows.push(...batch);
    if (batch.length < GSC_QUERY_ROW_LIMIT) break;
  }
  return { rows, window: { start: fmt(start), end: fmt(end) } };
}

async function main() {
  const days = Number(argFlag('days', '90'));
  const top = Number(argFlag('top', '15'));
  const outDir = argFlag('out', 'data/gsc-content-refresh');
  const weights = loadWeights(argFlag('weights', null));

  const token = await getToken();
  const { rows, window } = await fetchPagePerformance(token, days);

  const pages = rows
    .map((r) => ({
      page: r.keys[0].replace(SITE_URL, ''),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Number((r.ctr * 100).toFixed(2)),
      position: Number(r.position.toFixed(1)),
    }))
    .filter((p) => EDITORIAL_CONTENT_GROUPS.has(classifyAnalyticsPath(p.page).contentGroup));

  const ranked = rankPageOpportunities(pages, { weights });
  const candidates = ranked.slice(0, top);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const jsonOut = join(outDir, 'opportunity-report.json');
  const mdOut = join(outDir, 'opportunity-report.md');

  const report = {
    generated: new Date().toISOString(),
    window,
    pagesConsidered: pages.length,
    candidates,
  };
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));

  const md = [
    '# GSC content-gap opportunity report',
    '',
    `Generato: ${report.generated} · Finestra: ${window.start} → ${window.end} · Pagine editoriali considerate: ${pages.length}`,
    '',
    'Prossimo passo per ogni candidata: `node scripts/gsc-page-query-export.mjs --page=<path>`, poi seguire',
    '`docs/gsc-content-refresh-playbook.md`.',
    '',
    '| # | Pagina | Score | Impressioni | Click | CTR | Pos. media | CTR gap vs peer |',
    '|---|---|---|---|---|---|---|---|',
    ...candidates.map((c, i) =>
      `| ${i + 1} | \`${c.page}\` | ${c.opportunityScore} | ${c.impressions} | ${c.clicks} | ${c.ctr}% | ${c.position} | ${(c.ctrGap * 100).toFixed(0)}%${c.ctrGapLowConfidence ? ' ⚠️ bassa confidenza (peer scarsi)' : ''} |`
    ),
  ].join('\n') + '\n';
  writeFileSync(mdOut, md);

  console.log(`GSC content-gap opportunity report: ${candidates.length} candidate su ${pages.length} pagine editoriali -> ${mdOut}`);
  for (const c of candidates) {
    console.log(`  ${c.opportunityScore.toFixed(3).padStart(6)}  ${c.page}  (impr ${c.impressions}, pos ${c.position}, ctr ${c.ctr}%)`);
  }
}

main().catch((err) => {
  console.error(`gsc-content-opportunity-score failed: ${err.message}`);
  process.exit(1);
});
