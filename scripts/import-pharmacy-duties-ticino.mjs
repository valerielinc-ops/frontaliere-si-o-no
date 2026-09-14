#!/usr/bin/env node
/**
 * Polite daily importer for the four server-rendered OFCT duty tables.
 * Locarnese is deliberately not included: its separate site has no complete
 * anagraphic table, so publishing a pharmacy identity there would be unsafe.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFCT_REGIONS } from './lib/pharmacy-ticino-parser.mjs';
import { buildPharmacyDuties } from './lib/pharmacy-ticino-duty-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const DATA_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-ticino.json');
const PHARMACY_PATH = resolve(REPO_ROOT, 'data/pharmacies-ticino-complete.json');
const STAGE_DIR = process.env.PHARMACY_DUTY_STAGE_DIR ? resolve(process.env.PHARMACY_DUTY_STAGE_DIR) : null;
const OUTPUT_DATA_PATH = STAGE_DIR ? resolve(STAGE_DIR, 'pharmacy-duties-ticino.json') : null;
const OUTPUT_STATUS_PATH = STAGE_DIR ? resolve(STAGE_DIR, 'pharmacy-duties-ticino-status.json') : null;
const USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const CRAWL_DELAY_MS = 10_000;
const timeoutMs = 15_000;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function readJson(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return fallback; }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it,de;q=0.8,en;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadFixture(region) {
  const fixtureDir = process.env.PHARMACY_DUTY_FIXTURE_DIR;
  if (!fixtureDir) return null;
  return readFile(resolve(fixtureDir, `${region.key}.html`), 'utf8');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && !STAGE_DIR) {
    console.error('[import-pharmacy-duties-ticino] blocked: PHARMACY_DUTY_STAGE_DIR is required; duties are finalized only by the atomic border job');
    process.exitCode = 1;
    return;
  }
  const attemptedAt = new Date().toISOString();
  const previous = await readJson(DATA_PATH, { duties: [], _lastSuccessfulFetchAt: null });
  const pharmacyData = await readJson(PHARMACY_PATH, { pharmacies: [] });
  const pharmacyIds = new Set((pharmacyData.pharmacies || []).map((pharmacy) => pharmacy.id));
  const previousByRegion = new Map();
  for (const duty of previous.duties || []) {
    const region = OFCT_REGIONS.find((candidate) => candidate.name === duty.coverageName);
    if (region) previousByRegion.set(region.key, [...(previousByRegion.get(region.key) || []), duty]);
  }

  const duties = [];
  const errors = [];
  const warnings = [];
  const preservedRegions = [];
  const successfulRegions = [];

  for (let index = 0; index < OFCT_REGIONS.length; index += 1) {
    const region = OFCT_REGIONS[index];
    if (index > 0 && !process.env.PHARMACY_DUTY_FIXTURE_DIR) await sleep(CRAWL_DELAY_MS);
    let html;
    try {
      html = await loadFixture(region);
      if (html === null) html = await fetchHtml(region.url);
      const result = buildPharmacyDuties(html, region, attemptedAt, pharmacyIds);
      if (result.duties.length === 0) throw new Error(result.warnings.join('; ') || 'zero duty intervals parsed');
      duties.push(...result.duties);
      successfulRegions.push(region.key);
      warnings.push(...result.warnings);
    } catch (error) {
      const message = `${region.key}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      const preserved = previousByRegion.get(region.key) || [];
      if (preserved.length > 0) {
        duties.push(...preserved);
        preservedRegions.push(region.key);
        warnings.push(`${region.key}: preserved ${preserved.length} previous interval(s); fetchedAt not renewed`);
      }
    }
  }

  const status = {
    _source: 'https://www.ofct.ch/farmacieturno/',
    _attemptedAt: attemptedAt,
    _lastSuccessfulFetchAt: successfulRegions.length > 0 ? attemptedAt : (previous._lastSuccessfulFetchAt || null),
    _successfulRegions: successfulRegions,
    _preservedRegions: preservedRegions,
    _allRegionsFailed: successfulRegions.length === 0,
    _errors: errors,
    _warnings: warnings,
  };

  // This job only stages the newly fetched duty payload. The border job is
  // the sole release finalizer: it pairs this payload with the catalogue and
  // writes all three release-bearing snapshots in one commit.

  if (successfulRegions.length === 0) {
    if (!dryRun) {
      await mkdir(dirname(OUTPUT_STATUS_PATH), { recursive: true });
      await writeFile(OUTPUT_STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    }
    console.error(`[import-pharmacy-duties-ticino] blocked: all ${OFCT_REGIONS.length} region fetches failed; atomic finalizer must preserve the previous catalogue+duties pair`);
    process.exitCode = 1;
    return;
  }

  const dutyOutput = {
    _source: 'https://www.ofct.ch/farmacieturno/',
    _sourceRegions: OFCT_REGIONS.map((region) => region.url),
    _fetchedAt: attemptedAt,
    _lastSuccessfulFetchAt: attemptedAt,
    _errors: errors,
    _warnings: warnings,
    _preservedRegions: preservedRegions,
    _successfulRegions: successfulRegions,
    _allRegionsFailed: false,
    duties,
  };
  if (!dryRun) {
    await mkdir(dirname(OUTPUT_DATA_PATH), { recursive: true });
    await writeFile(OUTPUT_DATA_PATH, `${JSON.stringify(dutyOutput, null, 2)}\n`, 'utf8');
    await writeFile(OUTPUT_STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  }
  console.log(`[import-pharmacy-duties-ticino] ${dryRun ? 'dry-run parsed' : 'staged'} ${duties.length} intervals from ${successfulRegions.length}/${OFCT_REGIONS.length} regions`);
  if (errors.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error('[import-pharmacy-duties-ticino] fatal:', error);
  process.exitCode = 1;
});
