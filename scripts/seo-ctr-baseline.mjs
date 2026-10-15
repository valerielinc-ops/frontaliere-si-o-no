#!/usr/bin/env node
/**
 * seo-ctr-baseline.mjs — CTR-vs-expected-position baseline (issue #4300)
 *
 * Pulls GSC page-level data for the SERP-CTR template families
 * (articoli-frontaliere, guida-frontaliere, tasse-e-pensione) plus two
 * healthy reference families (de/*, cerca-lavoro-ticino/*), compares each
 * page's actual CTR against the position-expected CTR curve
 * (scripts/lib/seo-ctr-curve.mjs), aggregates per family, and snapshots the
 * result so a later run can measure before/after once the title/description
 * + rich-results changes ship.
 *
 * The CTR is the same segmented measure as the weekly monitor (owner decision
 * I5, 2026-10-05, scripts/lib/seo-ctr-query-segments.mjs): search-operator
 * and promotional queries are excluded and stored apart; every snapshot
 * carries `measureVersion`.
 *
 * Auth: Firebase service-account JSON via GOOGLE_APPLICATION_CREDENTIALS
 * (same as scripts/analytics-report.mjs / scripts/fetch-article-performance.mjs).
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs)"
 *
 * Usage:
 *   npx tsx scripts/seo-ctr-baseline.mjs [--days 90] [--json]
 *   (`tsx`, non `node`: scripts/lib/seo-ctr-curve.mjs importa i moduli
 *   foglia .ts services/jobBoardSlugs.ts e build-plugins/fuelDailyData.ts)
 *
 * Always exits 0 — a GSC/auth failure is logged, never blocks CI.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SEO_CTR_FAMILIES, aggregateFamilyRows, effectiveTargetCtr, familyPathPrefixes, ctrExcludedSegmentsForFamily } from './lib/seo-ctr-curve.mjs';
import { CTR_MEASURE_VERSION, fetchSegmentedFamilyRows, excludedSegmentsForState } from './lib/seo-ctr-query-segments.mjs';

// Lo stesso floor di default di `aggregateFamilyRows`, passato esplicito anche
// alla segmentazione perche' «tutte le query» conti le stesse pagine.
const MIN_PAGE_IMPRESSIONS = 20;
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LAST_RUN_PATH = resolve(ROOT, 'data', 'seo-ctr-baseline-last-run.json');
const HISTORY_PATH = resolve(ROOT, 'data', 'seo-ctr-baseline-history.json');
const MAX_HISTORY_ENTRIES = 52; // ~1 year of weekly snapshots

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const DAYS = daysIdx !== -1 ? (parseInt(args[daysIdx + 1], 10) || 90) : 90;
const asJson = args.includes('--json');

function log(...parts) {
  if (!asJson) console.log(...parts);
}

function pct(n) {
  return n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(2)}%`;
}

async function main() {
  const nowIso = new Date().toISOString();
  const families = {};

  for (const family of SEO_CTR_FAMILIES) {
    log(`\n📊 ${family.label} (${family.pathContains})`);
    try {
      // Stessa misura del monitor (decisione I5 del 2026-10-05): CTR sulle
      // query con intento di lavoro, segmenti esclusi riportati a parte.
      const segmentation = await fetchSegmentedFamilyRows({
        windowDays: DAYS,
        pathContains: familyPathPrefixes(family),
        segments: ctrExcludedSegmentsForFamily(family),
        minImpressions: MIN_PAGE_IMPRESSIONS,
      });
      const agg = aggregateFamilyRows(segmentation.rows, { minImpressions: MIN_PAGE_IMPRESSIONS });
      // Same floor the scheduled monitor judges against — resolved through the
      // shared helper so the one-off baseline and the weekly monitor cannot
      // disagree on what "below target" means for a curve-derived family.
      const targetCtr = effectiveTargetCtr(family, agg.avgPosition);
      families[family.id] = {
        label: family.label,
        pathContains: family.pathContains,
        targetCtr,
        targetCtrCurveMultiple: family.targetCtrCurveMultiple ?? null,
        measureVersion: segmentation.measureVersion,
        rawRowCount: segmentation.rawRowCount,
        ...agg,
        ctrAllQueries: segmentation.allQueries.ctr,
        excludedSegments: excludedSegmentsForState(segmentation.segments),
        // Cap the stored worst-offender list — full detail isn't needed for
        // the before/after comparison, just enough to spot-check.
        belowCurvePages: agg.belowCurvePages.slice(0, 25),
      };
      const meetsTarget = targetCtr === null || (agg.avgCtr !== null && agg.avgCtr >= targetCtr);
      log(`   pagine: ${agg.pageCount} | click: ${agg.totalClicks} | impr: ${agg.totalImpressions}`);
      log(`   CTR medio (query di lavoro): ${pct(agg.avgCtr)} | pos media: ${agg.avgPosition ? agg.avgPosition.toFixed(1) : 'n/a'}`);
      log(`   CTR su tutte le query (misura precedente): ${pct(segmentation.allQueries.ctr)}`);
      log(`   pagine sotto curva attesa: ${agg.belowCurveCount}/${agg.pageCount}`);
      if (targetCtr !== null) {
        log(`   target: ${pct(targetCtr)} → ${meetsTarget ? '✅ OK' : '⚠️ SOTTO SOGLIA'}`);
      }
    } catch (e) {
      log(`   ⚠️ errore GSC: ${e.message}`);
      families[family.id] = { label: family.label, pathContains: family.pathContains, targetCtr: effectiveTargetCtr(family, null), error: e.message };
    }
  }

  // `measureVersion` come `predicateVersion` nella history delle traduzioni:
  // due snapshot con versioni diverse non si confrontano senza ricalcolo. Gli
  // snapshot precedenti, senza il campo, sono `page-all-queries`. La versione
  // di ogni famiglia aggiunge i segmenti applicati (`:operator+promo`).
  const snapshot = { generatedAt: nowIso, windowDays: DAYS, measureVersion: CTR_MEASURE_VERSION, families };

  try {
    writeJsonAtomic(LAST_RUN_PATH, snapshot);
    let history = [];
    if (existsSync(HISTORY_PATH)) {
      try {
        history = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
        if (!Array.isArray(history)) history = [];
      } catch { history = []; }
    }
    history.push(snapshot);
    if (history.length > MAX_HISTORY_ENTRIES) history = history.slice(history.length - MAX_HISTORY_ENTRIES);
    writeJsonAtomic(HISTORY_PATH, history);
    log(`\n💾 Snapshot salvato: ${LAST_RUN_PATH}`);
  } catch (e) {
    log(`⚠️ Impossibile salvare lo snapshot: ${e.message}`);
  }

  if (asJson) {
    console.log(JSON.stringify(snapshot, null, 2));
  }
}

main().catch((e) => {
  console.error('seo-ctr-baseline failed (non-blocking):', e.message);
  process.exitCode = 0;
});
