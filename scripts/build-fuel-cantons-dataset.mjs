#!/usr/bin/env node
/**
 * Build `data/fuel-prices-cantons.json` (+ `public/data/` copy served by the
 * CDN): per canton URL group, the average / median / minimum fuel price on the
 * Swiss side and on the foreign side of the border, with station count,
 * observation time and source. Consumed by the corpus
 * (`generator/scripts/refresh-fuel-cantons.mjs`) for the canton hubs (D11).
 *
 * Input: the hand-off file written by
 *   node scripts/generate-fuel-prices-dataset.mjs --save-local --cantons-input-out <file>
 * (Swiss TCS border-strip stations + MIMIT Italian stations + ECB rate, all
 * already fetched by that run). The foreign sides are fetched here
 * (scripts/lib/fuel-foreign-sources.mjs), each failure-isolated.
 *
 * The dataset is refused (exit 1, nothing written, the previous file stays
 * published) when it fails `validateFuelCantonsDataset` — too many expected
 * cantons empty, or the CH/IT input missing.
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
  buildChRecords,
  buildDeRecords,
  buildFrRecords,
  buildFuelCantonsDataset,
  buildItRecords,
  createStationCantonResolver,
  validateFuelCantonsDataset,
} from './lib/fuel-cantons-dataset.mjs';
import {
  AT_ECONTROL_BY_REGION_URL,
  DE_TANKERKOENIG_LIST_URL,
  FR_INSTANT_FEED_URL,
  fetchAustrianStations,
  fetchFrenchStations,
  fetchGermanStations,
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
  const postalIndex = readJson(path.join(REPO_ROOT, 'data', 'swiss-postal-code-index.json'));
  const localityIndex = readJson(path.join(REPO_ROOT, 'data', 'swiss-locality-postal-codes.json'));
  const resolveStationCanton = createStationCantonResolver({ postalIndex, localityIndex, cantonSlugFile });
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const [fr, at, de] = await Promise.all([
    (fetchers.fr || fetchFrenchStations)(),
    (fetchers.at || fetchAustrianStations)(),
    (fetchers.de || fetchGermanStations)(),
  ]);

  const records = [
    ...buildChRecords({
      swissStations: input.swissStations,
      resolveStationCanton,
      observedAtFallback: input.generatedAt,
    }),
    ...buildItRecords({ italyStations: input.italyStations, nowMs }),
    ...buildFrRecords({ frenchStations: fr.data, nowMs }),
    // E-Control and Tankerkönig list current prices without a per-price
    // timestamp: the observation time is the fetch time.
    ...buildAtRecords({ austrianByRegion: at.data, observedAt: nowIso }),
    ...buildDeRecords({ germanByCanton: de.data, observedAt: nowIso }),
  ];

  const swissCount = (input.swissStations || []).length;
  const italyCount = (input.italyStations || []).length;
  const dataset = buildFuelCantonsDataset({
    cantonCodes: Object.keys(cantonSlugFile.cantons),
    generatedAt: nowIso,
    exchangeRate: input.exchangeRate,
    sourceStatus: {
      CH: {
        status: swissCount ? 'ok' : 'failed',
        provider: 'TCS Benzinpreis-Radar',
        stationCount: swissCount,
        snapshotAt: input.generatedAt || null,
        scope: 'border-strip',
        note: 'National Swiss coverage is not collected: the TCS terms of use allow private use only.',
      },
      IT: {
        status: italyCount ? 'ok' : 'failed',
        provider: 'MIMIT Osservaprezzi carburanti',
        stationCount: italyCount,
        priceSnapshotDate: input.italyExtractedAt || null,
      },
      FR: sourceSummary(fr, { provider: 'prix-carburants.gouv.fr', url: FR_INSTANT_FEED_URL }),
      AT: sourceSummary(at, { provider: 'E-Control Spritpreisrechner', url: AT_ECONTROL_BY_REGION_URL }),
      DE: sourceSummary(de, { provider: 'Tankerkönig', url: DE_TANKERKOENIG_LIST_URL }),
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
    // generate-fuel-prices-dataset.mjs exits 0 without output when its
    // upstream APIs are unreachable; nothing to build from, nothing to publish.
    log(`input ${inputPath} not found (generator skipped this run) — keeping the published dataset`);
    return;
  }

  const dataset = await buildFromInput(readJson(inputPath));
  const verdict = validateFuelCantonsDataset(dataset);
  for (const [side, info] of Object.entries(dataset.sources)) {
    log(`source ${side}: ${info.status}${info.reason ? ` — ${info.reason}` : ''}`);
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

const invokedAsCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
