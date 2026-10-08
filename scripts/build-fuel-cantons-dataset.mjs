#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * Build `data/fuel-prices-cantons.json` (+ `public/data/` copy served by the
 * CDN): per canton URL group, the average / median / minimum fuel price on the
 * Swiss side and on the foreign side of the border, with station count,
 * observation time and source. Consumed by the corpus
 * (`generator/scripts/refresh-fuel-cantons.mjs`) for the canton hubs (D11).
 *
 * Input: the hand-off file written by
 *   node scripts/generate-fuel-prices-dataset.mjs --save-local --cantons-input-out <file>
 * (MIMIT Italian stations + ECB rate, when the upstream run succeeded). The
 * Swiss baseline comes independently from the official BFS/UST monthly feed;
 * the remaining foreign sides are fetched here, each failure-isolated.
 *
 * The dataset is refused (exit 1, nothing written, the previous file stays
 * published) when it fails `validateFuelCantonsDataset` — in particular when
 * any of the 24 canton URL groups has no Swiss value.
 *
 * Usage:
 *   node scripts/build-fuel-cantons-dataset.mjs --input <hand-off.json>
 *     [--out-root <dir>]   write <dir>/data/... and <dir>/public/data/... (tests)
 *     [--check]            build and validate, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  buildAtRecords,
  buildSwissNationalRecords,
  buildDeRecords,
  buildFrRecords,
  buildFuelCantonsDataset,
  buildItRecords,
  DE_SOURCE_ATTRIBUTION,
  validateFuelCantonsDataset,
} from './lib/fuel-cantons-dataset.mjs';
import {
  AT_ECONTROL_BY_REGION_URL,
  BFS_FUEL_PRICES_URL,
  DE_TANKERKOENIG_LIST_URL,
  FR_INSTANT_FEED_URL,
  fetchAustrianStations,
  fetchFrenchStations,
  fetchGermanStations,
  fetchSwissNationalFuelPrices,
} from './lib/fuel-foreign-sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_NAME = 'fuel-prices-cantons.json';

const log = (msg) => console.log(`[build-fuel-cantons] ${msg}`);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourceSummary(result, extra) {
  const { data: _data, ...rest } = result;
  return { ...extra, ...rest };
}

export async function buildFromInput(input, { fetchers = {}, now = new Date() } = {}) {
  const cantonSlugFile = readJson(path.join(REPO_ROOT, 'data', 'canton-url-slugs.json'));
  const cantonCodes = Object.keys(cantonSlugFile.cantons);
  const safeInput = input || {};
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const [ch, fr, at, de] = await Promise.all([
    (fetchers.ch || fetchSwissNationalFuelPrices)(),
    (fetchers.fr || fetchFrenchStations)(),
    (fetchers.at || fetchAustrianStations)(),
    (fetchers.de || fetchGermanStations)(),
  ]);

  const records = [
    ...buildSwissNationalRecords({ nationalPrices: ch.data, cantonCodes }),
    ...buildItRecords({ italyStations: safeInput.italyStations, nowMs }),
    ...buildFrRecords({ frenchStations: fr.data, nowMs }),
    // E-Control and Tankerkönig list current prices without a per-price
    // timestamp: the observation time is the fetch time.
    ...buildAtRecords({ austrianByRegion: at.data, observedAt: nowIso }),
    ...buildDeRecords({ germanByCanton: de.data, observedAt: nowIso }),
  ];

  const italyCount = (safeInput.italyStations || []).length;
  const dataset = buildFuelCantonsDataset({
    cantonCodes,
    generatedAt: nowIso,
    exchangeRate: safeInput.exchangeRate,
    sourceStatus: {
      CH: sourceSummary(ch, {
        provider: 'BFS/UST LIK — Durchschnittspreise für Energie und Treibstoffe',
        url: BFS_FUEL_PRICES_URL,
        license: 'OPEN-BY (attribuzione obbligatoria)',
        scope: 'national-monthly',
      }),
      IT: {
        status: italyCount ? 'ok' : 'failed',
        provider: 'MIMIT Osservaprezzi carburanti',
        stationCount: italyCount,
        priceSnapshotDate: safeInput.italyExtractedAt || null,
      },
      FR: sourceSummary(fr, { provider: 'prix-carburants.gouv.fr', url: FR_INSTANT_FEED_URL }),
      AT: sourceSummary(at, { provider: 'E-Control Spritpreisrechner', url: AT_ECONTROL_BY_REGION_URL }),
      DE: sourceSummary(de, {
        provider: 'Tankerkönig / MTS-K',
        url: DE_TANKERKOENIG_LIST_URL,
        license: 'CC BY 4.0',
        attribution: DE_SOURCE_ATTRIBUTION,
      }),
    },
    records,
  });
  return dataset;
}

async function main() {
  const inputPath = argValue('--input');
  const outRoot = path.resolve(argValue('--out-root') || REPO_ROOT);
  const checkOnly = process.argv.includes('--check');
  if (!inputPath) {
    console.error('::error::[build-fuel-cantons] --input <hand-off.json> is required');
    process.exit(2);
  }
  if (!fs.existsSync(inputPath)) {
    // The Italian hand-off is optional for the Swiss baseline. The BFS fetch
    // still runs, so a transient MIMIT/TCS generator failure cannot turn a
    // valid national Swiss dataset into a silent no-op.
    log(`input ${inputPath} not found (generator skipped this run) — building the BFS Swiss baseline without the foreign Italy overlay`);
  }

  const dataset = await buildFromInput(fs.existsSync(inputPath) ? readJson(inputPath) : {});
  const verdict = validateFuelCantonsDataset(dataset);
  for (const [side, info] of Object.entries(dataset.sources)) {
    const health = dataset.health?.[side.toLowerCase()] || 'failed:unknown';
    if (side === 'DE' && health !== 'ok') {
      console.warn(`::warning::[build-fuel-cantons] source DE skipped (${health})${info.reason ? ` — ${info.reason}` : ''}; the dataset continues with the other sources`);
    } else {
      log(`source ${side}: ${info.status}${info.reason ? ` — ${info.reason}` : ''}`);
    }
  }
  log(`records: ${dataset.records.length}; expected cantons with data: ${dataset.coverage.expectedCantonsWithData.length}/${dataset.coverage.expectedCantons.length} (ratio ${verdict.coverageRatio}, floor ${dataset.coverage.minExpectedCoverage}); cantons with any data: ${dataset.coverage.cantonsWithData.join(' ')}`);
  if (!verdict.ok) {
    for (const e of verdict.errors) console.error(`::error::[build-fuel-cantons] ${e}`);
    console.error('::error::[build-fuel-cantons] dataset refused — the previously published file is kept');
    process.exit(1);
  }
  if (checkOnly) {
    log('--check: valid, nothing written');
    return;
  }
  writeJsonAtomic(path.join(outRoot, 'data', OUT_NAME), dataset);
  writeJsonAtomic(path.join(outRoot, 'public', 'data', OUT_NAME), dataset);
  log(`wrote data/${OUT_NAME} and public/data/${OUT_NAME}`);
  // Explicit "accepted build" signal for the workflow: only this path may
  // close the rejection issue. A run that exits 0 without writing (generator
  // skipped, --check) leaves it unset.
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'built=true\n');
}

const invokedAsCli = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invokedAsCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
