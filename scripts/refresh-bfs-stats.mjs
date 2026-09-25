#!/usr/bin/env node
/**
 * BFS cross-border worker statistics — refresh worker.
 *
 * Runs twice a day from .github/workflows/refresh-bfs-stats.yml.
 * - Fetches the BFS SDMX REST CSV (DF_GGS_6).
 * - Parses Ticino series (trend, ages, genderTrend, genderSnapshot).
 * - Compares the latest quarter token (e.g. "2026-Q1") against the value
 *   currently stored in Firestore `config/bfs_stats`.
 * - Always overwrites Firestore with the freshly-parsed payload (data may
 *   be revised within the same quarter — overwriting keeps clients fresh).
 * - When the latest quarter changed (a new quarter was published) emits
 *   GitHub Actions outputs so the workflow can dispatch generate-article.yml
 *   with a stats-update angle.
 *
 * Outputs to GITHUB_OUTPUT (only set on a quarter change):
 *   new_quarter=2026-Q1
 *   prev_quarter=2025-Q4
 *   latest_value=82345
 *   prev_value=81234
 *   delta_abs=1111
 *   delta_pct=1.4
 *   yoy_delta_pct=2.1     (vs the same quarter one year earlier, when present)
 *
 * Always emits:
 *   firestore_written=true|false
 *   latest_quarter=…
 */

import admin from 'firebase-admin';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildStatsFromCSV, fetchBfsCsv } from './lib/bfs-stats-parser.mjs';

const FIRESTORE_COLLECTION = 'config';
const FIRESTORE_DOC = 'bfs_stats';

function logInfo(msg) { console.error(`ℹ️  ${msg}`); }
function logOk(msg) { console.error(`✅ ${msg}`); }
function logWarn(msg) { console.error(`⚠️  ${msg}`); }
function logErr(msg) { console.error(`❌ ${msg}`); }

function emitOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) {
    console.error(`OUT  ${key}=${value}`);
    return;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function quarterToYear(q) {
  const m = String(q || '').match(/^(\d{4})-Q([1-4])$/);
  return m ? Number(m[1]) : null;
}

/**
 * Idempotency check: has create-article.mjs already produced an article for
 * this quarter? Reads the per-repo article-source-urls.json registry that
 * create-article writes after a successful publish. The synthetic URL
 * `stats-bfs://2026-Q1` (lowercased by normalizeNewsUrl) is the dedup key.
 *
 * Used to keep dispatching across cron ticks until the article actually
 * lands in main — the generate-article concurrency chain frequently cancels
 * one-shot dispatches, so a single trigger isn't reliable.
 */
function articleAlreadyPublished(latestQuarter) {
  const path = resolve('data/article-source-urls.json');
  if (!existsSync(path)) return false;
  try {
    const map = JSON.parse(readFileSync(path, 'utf8'));
    const key = `stats-bfs://${String(latestQuarter).toLowerCase()}`;
    return Object.prototype.hasOwnProperty.call(map, key);
  } catch {
    return false;
  }
}

function findValueAt(trend, quarter) {
  const hit = trend.find((p) => p.year === quarter);
  return hit ? hit.frontalieri : null;
}

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  const db = admin.firestore();

  logInfo('Scarico CSV BFS (SDMX)…');
  const csv = await fetchBfsCsv();
  const parsed = buildStatsFromCSV(csv);
  if (!parsed) {
    logErr('Parsing CSV BFS fallito o nessuna riga Ticino.');
    process.exit(1);
  }

  const { latestQuarter, trend } = parsed;
  logOk(`Parsed ${trend.length} quarter (latest=${latestQuarter}, ${trend[trend.length - 1].frontalieri.toLocaleString('it-IT')} frontalieri).`);

  const ref = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
  const prevSnap = await ref.get();
  const prev = prevSnap.exists ? prevSnap.data() : null;
  const prevQuarter = prev?.latestQuarter || null;

  const payload = {
    trend: parsed.trend,
    ages: parsed.ages,
    genderTrend: parsed.genderTrend,
    genderSnapshot: parsed.genderSnapshot,
    latestQuarter,
    lastUpdated: new Date().toISOString(),
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(payload, { merge: false });
  logOk(`Scritto Firestore: ${FIRESTORE_COLLECTION}/${FIRESTORE_DOC}`);
  emitOutput('firestore_written', 'true');
  emitOutput('latest_quarter', latestQuarter);

  // ── Article-dispatch decision ───────────────────────────────────────
  // Decoupled from the Firestore write so:
  //  (a) clients always see fresh data even on intra-quarter revisions
  //  (b) if a previous dispatch was cancelled by the generate-article
  //      concurrency chain, the next cron retries until the article lands
  //      (idempotency check via data/article-source-urls.json registry).
  if (articleAlreadyPublished(latestQuarter)) {
    logInfo(`Articolo per ${latestQuarter} già pubblicato (registrato in data/article-source-urls.json) — niente dispatch.`);
    emitOutput('new_quarter', '');
    return;
  }

  if (!prevQuarter) {
    // First write ever to Firestore — typically the very first deploy. We
    // intentionally do NOT publish an article retroactively for the bootstrap
    // case, otherwise every fresh environment gets spammed with a "now-old"
    // quarter article. Operators can force one with a manual workflow_dispatch
    // on generate-article.yml.
    logInfo('Nessun valore precedente in Firestore — primo write, niente articolo retroattivo.');
    emitOutput('new_quarter', '');
    return;
  }

  if (prevQuarter === latestQuarter) {
    logInfo(`Quarter invariato (${latestQuarter}) ma articolo non ancora pubblicato — re-dispatch (precedente probabilmente cancellato dalla concurrency chain).`);
    // Fall through to dispatch path
  } else if (prevQuarter.localeCompare(latestQuarter) >= 0) {
    logWarn(`prevQuarter=${prevQuarter} non precede latestQuarter=${latestQuarter}; salto notifica.`);
    emitOutput('new_quarter', '');
    return;
  }

  const latestValue = findValueAt(parsed.trend, latestQuarter);
  // For prev_value compare against the immediately-preceding quarter in
  // the new trend (not whatever value was stored in the old Firestore doc:
  // BFS revises) — gives an apples-to-apples QoQ.
  const prevIdx = parsed.trend.findIndex((p) => p.year === latestQuarter) - 1;
  const prevValue = prevIdx >= 0 ? parsed.trend[prevIdx].frontalieri : null;

  if (latestValue == null || prevValue == null) {
    logWarn('Impossibile calcolare delta QoQ (valori mancanti) — salto notifica.');
    emitOutput('new_quarter', '');
    return;
  }

  const deltaAbs = latestValue - prevValue;
  const deltaPct = ((deltaAbs / prevValue) * 100).toFixed(1);

  // Year-over-year (same quarter, previous year)
  const ly = quarterToYear(latestQuarter);
  let yoyDeltaPct = '';
  if (ly !== null) {
    const yoyQuarter = `${ly - 1}-Q${latestQuarter.slice(-1)}`;
    const yoyValue = findValueAt(parsed.trend, yoyQuarter);
    if (yoyValue != null && yoyValue > 0) {
      yoyDeltaPct = (((latestValue - yoyValue) / yoyValue) * 100).toFixed(1);
    }
  }

  // For the dispatch payload always use the actual preceding quarter from
  // the trend, not the Firestore prevQuarter field (those diverge in the
  // re-dispatch path where Firestore was already advanced).
  const trendPrevQuarter = prevIdx >= 0 ? parsed.trend[prevIdx].year : prevQuarter;
  logOk(`Quarter da pubblicare: ${trendPrevQuarter} → ${latestQuarter}  (${deltaAbs >= 0 ? '+' : ''}${deltaAbs}, ${deltaPct}%${yoyDeltaPct ? `, YoY ${yoyDeltaPct}%` : ''})`);

  emitOutput('new_quarter', latestQuarter);
  emitOutput('prev_quarter', trendPrevQuarter);
  emitOutput('latest_value', String(latestValue));
  emitOutput('prev_value', String(prevValue));
  emitOutput('delta_abs', String(deltaAbs));
  emitOutput('delta_pct', deltaPct);
  emitOutput('yoy_delta_pct', yoyDeltaPct);
}

main().catch((e) => {
  logErr(`refresh-bfs-stats fallito: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
