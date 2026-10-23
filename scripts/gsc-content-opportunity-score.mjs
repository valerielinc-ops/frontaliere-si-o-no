#!/usr/bin/env node
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
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
import { dirname, join } from 'node:path';
import { getServiceAccountToken } from './lib/ga4-service-account.mjs';
import { classifyAnalyticsPath } from './lib/analytics-opportunity-utils.mjs';
import { rankPageOpportunities } from './lib/gsc-opportunity-scoring.mjs';
import { utcDaysBefore } from './lib/analytics-settled-window.mjs';
import { GSC_READONLY_SCOPE, GSC_SITE_URL } from './lib/gsc-property.mjs';
import {
  fetchGscRecoveryInputs,
  fetchGscSearchAnalyticsRows,
  GSC_QUERY_MAX_PAGES,
} from './lib/gsc-recovery-source.mjs';
import {
  buildGscRecoveryReport,
  createGscRecoverySnapshot,
  renderGscRecoveryMarkdown,
} from './lib/gsc-recovery-report.mjs';
import { selectLatestGscFinalWindow } from './lib/gsc-final-window.mjs';

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
// invece di troncare a 5000; il limite e il safety cap sono condivisi con il
// recupero SEO in `gsc-recovery-source.mjs`.

export async function fetchPagePerformance(token, days) {
  const today = new Date();
  const end = utcDaysBefore(today, 2); // GSC ha un ritardo di 2 giorni
  const start = utcDaysBefore(end, days - 1);

  const { rows } = await fetchGscSearchAnalyticsRows(token, {
    startDate: fmt(start),
    endDate: fmt(end),
    dimensions: ['page'],
    dataState: 'final',
  }, { maxPages: GSC_QUERY_MAX_PAGES });
  return { rows, window: { start: fmt(start), end: fmt(end) } };
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadIndexabilityEvidence(path, fallback = []) {
  if (!path) return fallback;
  const value = readJson(path, '--indexability file');
  return Array.isArray(value) ? value : value.evidence || [];
}

async function runRecoveryMode() {
  const fixturePath = argFlag('fixture', null);
  const baselineSnapshotPath = argFlag('baseline-snapshot', null);
  const captureBaselinePath = argFlag('capture-baseline', null);
  const outputDir = argFlag('out', 'data/gsc-seo-recovery');
  const top = Number(argFlag('top', '50'));
  let current;
  let baseline;
  let baselineSource;
  let selection = null;
  let indexabilityEvidence = [];

  if (fixturePath) {
    const fixture = readJson(fixturePath, '--fixture file');
    selection = fixture.selection || (fixture.today
      ? selectLatestGscFinalWindow({
          today: fixture.today,
          availableDates: fixture.availableDates || [],
          firstIncompleteDate: fixture.firstIncompleteDate || null,
        })
      : null);
    current = fixture.current || (selection && Array.isArray(fixture.currentPageRows)
      ? createGscRecoverySnapshot({
          assessment: selection,
          pageRows: fixture.currentPageRows,
          queryRows: fixture.currentQueryRows || [],
          pageRowsComplete: true,
          queryRowsComplete: true,
          source: 'offline-fixture',
        })
      : null);
    baseline = fixture.baseline || (selection?.previous && Array.isArray(fixture.previousPageRows)
      ? createGscRecoverySnapshot({
          assessment: selection.previous,
          pageRows: fixture.previousPageRows,
          queryRows: fixture.previousQueryRows || [],
          pageRowsComplete: true,
          queryRowsComplete: true,
          source: 'offline-fixture',
        })
      : null);
    baselineSource = fixture.baselineSource || (fixture.baseline ? 'fixture-baseline' : 'previous-final-window');
    indexabilityEvidence = fixture.indexabilityEvidence || [];
  } else {
    const token = await getToken();
    const fixedBaseline = baselineSnapshotPath ? readJson(baselineSnapshotPath, '--baseline-snapshot file') : null;
    const inputs = await fetchGscRecoveryInputs(token, {
      days: Number(argFlag('days', '7')),
      baselineSnapshot: fixedBaseline,
    });
    ({ current, baseline, baselineSource, selection } = inputs);
  }

  if (baselineSnapshotPath && fixturePath) {
    baseline = readJson(baselineSnapshotPath, '--baseline-snapshot file');
    baselineSource = 'immutable-snapshot';
  }
  indexabilityEvidence = loadIndexabilityEvidence(argFlag('indexability', null), indexabilityEvidence);

  if (captureBaselinePath) {
    if (!current?.assessment || current.assessment.status !== 'measurable' || current.pageRowsComplete !== true || current.queryRowsComplete !== true) {
      throw new Error('--capture-baseline requires a complete page and query snapshot');
    }
    const directory = dirname(captureBaselinePath);
    if (directory !== '.') mkdirSync(directory, { recursive: true });
    writeFileSync(captureBaselinePath, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
    console.log(`Immutable GSC recovery baseline captured: ${captureBaselinePath}`);
  }

  const generatedAt = new Date().toISOString();
  const report = buildGscRecoveryReport({
    current,
    baseline,
    baselineSource,
    indexabilityEvidence,
    generatedAt,
  });
  mkdirSync(outputDir, { recursive: true });
  const jsonOut = join(outputDir, 'recovery-report.json');
  const mdOut = join(outputDir, 'recovery-report.md');
  writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdOut, renderGscRecoveryMarkdown(report, { limit: top }));
  console.log(`GSC recovery report: ${report.status}; indexability ${report.summary.indexability}, visibility ${report.summary.visibilityLoss}, CTR/content ${report.summary.ctrContent}, unknown ${report.summary.unknown} -> ${mdOut}`);
  if (selection?.selection?.fellBack) {
    console.log(`GSC final-window selection fell back: selected ${selection.window.start} → ${selection.window.end}`);
  }
}

async function main() {
  const mode = argFlag('mode', 'content');
  if (mode === 'recovery') return runRecoveryMode();
  if (mode !== 'content') throw new Error(`unsupported --mode=${mode}; expected content or recovery`);

  const days = Number(argFlag('days', '90'));
  const top = Number(argFlag('top', '15'));
  const outDir = argFlag('out', 'data/gsc-content-refresh');
  const weights = loadWeights(argFlag('weights', null));

  const token = await getToken();
  const { rows, window } = await fetchPagePerformance(token, days);

  const pages = rows
    .map((r) => ({
    page: r.keys[0].replace(GSC_SITE_URL, ''),
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

if (isInvokedDirectly(import.meta.url)) main().catch((err) => {
  console.error(`gsc-content-opportunity-score failed: ${err.message}`);
  process.exit(1);
});
