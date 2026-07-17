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
 * Auth: Firebase service-account JSON via GOOGLE_APPLICATION_CREDENTIALS
 * (same as scripts/analytics-report.mjs / scripts/fetch-article-performance.mjs).
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs)"
 *
 * Usage:
 *   node scripts/seo-ctr-baseline.mjs [--days 90] [--json]
 *
 * Always exits 0 — a GSC/auth failure is logged, never blocks CI.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fetchGscByPage } from './lib/perf-sources/gsc.mjs';
import { SEO_CTR_FAMILIES, aggregateFamilyRows } from './lib/seo-ctr-curve.mjs';
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
      const { rows, perPath } = await fetchGscByPage({ windowDays: DAYS, pathContains: family.pathContains });
      const pageRows = [...perPath.entries()].map(([path, metrics]) => ({ path, ...metrics }));
      const agg = aggregateFamilyRows(pageRows);
      families[family.id] = {
        label: family.label,
        pathContains: family.pathContains,
        targetCtr: family.targetCtr,
        rawRowCount: rows,
        ...agg,
        // Cap the stored worst-offender list — full detail isn't needed for
        // the before/after comparison, just enough to spot-check.
        belowCurvePages: agg.belowCurvePages.slice(0, 25),
      };
      const meetsTarget = family.targetCtr === null || (agg.avgCtr !== null && agg.avgCtr >= family.targetCtr);
      log(`   pagine: ${agg.pageCount} | click: ${agg.totalClicks} | impr: ${agg.totalImpressions}`);
      log(`   CTR medio: ${pct(agg.avgCtr)} | pos media: ${agg.avgPosition ? agg.avgPosition.toFixed(1) : 'n/a'}`);
      log(`   pagine sotto curva attesa: ${agg.belowCurveCount}/${agg.pageCount}`);
      if (family.targetCtr !== null) {
        log(`   target: ${pct(family.targetCtr)} → ${meetsTarget ? '✅ OK' : '⚠️ SOTTO SOGLIA'}`);
      }
    } catch (e) {
      log(`   ⚠️ errore GSC: ${e.message}`);
      families[family.id] = { label: family.label, pathContains: family.pathContains, targetCtr: family.targetCtr, error: e.message };
    }
  }

  const snapshot = { generatedAt: nowIso, windowDays: DAYS, families };

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
