#!/usr/bin/env node
/**
 * Polite daily importer for the server-rendered Ticino duty tables.
 * Locarnese rows are emitted only after a unique match to the current Ticino
 * catalogue; its source never supplies an anagraphic to copy into this file.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TICINO_DUTY_REGIONS } from './lib/pharmacy-duty-regions.mjs';
import { buildLocarnesePharmacyDuties } from './lib/pharmacy-locarnese-parser.mjs';
import { buildPharmacyDuties } from './lib/pharmacy-ticino-duty-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const DATA_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-ticino.json');
const PHARMACY_PATH = resolve(REPO_ROOT, 'data/pharmacies-ticino-complete.json');
const STAGE_DIR = process.env.PHARMACY_DUTY_STAGE_DIR ? resolve(process.env.PHARMACY_DUTY_STAGE_DIR) : null;
const OUTPUT_DATA_PATH = STAGE_DIR ? resolve(STAGE_DIR, 'pharmacy-duties-ticino.json') : null;
const OUTPUT_STATUS_PATH = STAGE_DIR ? resolve(STAGE_DIR, 'pharmacy-duties-ticino-status.json') : null;
const STATUS_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-ticino-status.json');
const DUTY_SOURCE = 'https://www.ofct.ch/farmacieturno/';
export const DUTY_SOURCE_REGIONS = Object.freeze(TICINO_DUTY_REGIONS.map((region) => region.url));
const USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const CRAWL_DELAY_MS = 10_000;
const timeoutMs = 15_000;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function readJson(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return fallback; }
}

/**
 * Keep a partial source failure non-destructive without preserving an
 * impossible `verified` status after the interval has ended. The returned
 * array is a copy so the previous snapshot remains untouched in memory.
 */
export function reclassifyPreservedDuties(duties, now = new Date()) {
  if (!Array.isArray(duties)) return duties;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) return duties;
  return duties.map((duty) => {
    const endsAtMs = Date.parse(duty?.endsAt);
    if (!duty || duty.status !== 'verified' || !Number.isFinite(endsAtMs) || endsAtMs > nowMs) return duty;
    return { ...duty, status: 'expired' };
  });
}

function previousFetchedAt(previous) {
  return typeof previous?._fetchedAt === 'string'
    ? previous._fetchedAt
    : (typeof previous?._lastSuccessfulFetchAt === 'string' ? previous._lastSuccessfulFetchAt : null);
}

/**
 * Build the status sidecar with the same source/fetch metadata as the duty
 * dataset. On an all-region failure `_fetchedAt` remains the last dataset
 * timestamp; `_attemptedAt` records the failed attempt separately.
 */
export function buildPharmacyDutyStatus({
  attemptedAt,
  previous = {},
  previousStatus = {},
  successfulRegions = [],
  preservedRegions = [],
  errors = [],
  warnings = [],
}) {
  const hasSuccessfulRegion = successfulRegions.length > 0;
  return {
    _source: DUTY_SOURCE,
    _sourceRegions: [...DUTY_SOURCE_REGIONS],
    _fetchedAt: hasSuccessfulRegion ? attemptedAt : previousFetchedAt(previous),
    _attemptedAt: attemptedAt,
    _lastSuccessfulFetchAt: hasSuccessfulRegion
      ? attemptedAt
      : (previous?._lastSuccessfulFetchAt || previousFetchedAt(previous)),
    _lastStaticRefreshAt: hasSuccessfulRegion
      ? attemptedAt
      : (previousStatus?._lastStaticRefreshAt || null),
    _successfulRegions: successfulRegions,
    _preservedRegions: preservedRegions,
    _allRegionsFailed: !hasSuccessfulRegion,
    _errors: errors,
    _warnings: warnings,
  };
}

/** Build the validator-shaped duty snapshot for a successful/partial fetch. */
export function buildPharmacyDutiesDataset({
  attemptedAt,
  duties = [],
  errors = [],
  warnings = [],
  preservedRegions = [],
  successfulRegions = [],
}) {
  return {
    _source: DUTY_SOURCE,
    _sourceRegions: [...DUTY_SOURCE_REGIONS],
    _fetchedAt: attemptedAt,
    _lastSuccessfulFetchAt: attemptedAt,
    _errors: errors,
    _warnings: warnings,
    _preservedRegions: preservedRegions,
    _successfulRegions: successfulRegions,
    _allRegionsFailed: successfulRegions.length === 0,
    duties,
  };
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
  const previousStatus = await readJson(STATUS_PATH, {});
  const pharmacyData = await readJson(PHARMACY_PATH, { pharmacies: [] });
  const pharmacyIds = new Set((pharmacyData.pharmacies || []).map((pharmacy) => pharmacy.id));
  const previousByRegion = new Map();
  for (const duty of previous.duties || []) {
    const region = TICINO_DUTY_REGIONS.find((candidate) => candidate.name === duty.coverageName);
    if (region) previousByRegion.set(region.key, [...(previousByRegion.get(region.key) || []), duty]);
  }

  const duties = [];
  const errors = [];
  const warnings = [];
  const preservedRegions = [];
  const successfulRegions = [];

  for (let index = 0; index < TICINO_DUTY_REGIONS.length; index += 1) {
    const region = TICINO_DUTY_REGIONS[index];
    if (index > 0 && !process.env.PHARMACY_DUTY_FIXTURE_DIR) await sleep(CRAWL_DELAY_MS);
    let html;
    try {
      html = await loadFixture(region);
      if (html === null) html = await fetchHtml(region.url);
      const result = region.key === 'locarnese'
        ? buildLocarnesePharmacyDuties(html, region, attemptedAt, pharmacyData.pharmacies || [])
        : buildPharmacyDuties(html, region, attemptedAt, pharmacyIds);
      if (result.unresolved?.length) {
        throw new Error(`${result.unresolved.length} Locarnese row(s) have no unique Ticino catalogue identity`);
      }
      if (result.duties.length === 0) throw new Error(result.warnings.join('; ') || 'zero duty intervals parsed');
      duties.push(...result.duties);
      successfulRegions.push(region.key);
      warnings.push(...result.warnings);
    } catch (error) {
      const message = `${region.key}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      const preserved = reclassifyPreservedDuties(previousByRegion.get(region.key) || [], attemptedAt);
      if (preserved.length > 0) {
        duties.push(...preserved);
        preservedRegions.push(region.key);
        warnings.push(`${region.key}: preserved ${preserved.length} previous interval(s); fetchedAt not renewed`);
      }
    }
  }

  const status = buildPharmacyDutyStatus({
    attemptedAt,
    previous,
    previousStatus,
    successfulRegions,
    preservedRegions,
    errors,
    warnings,
  });

  // This job only stages the newly fetched duty payload. The border job is
  // the sole release finalizer: it pairs this payload with the catalogue and
  // writes all three release-bearing snapshots in one commit.

  if (successfulRegions.length === 0) {
    if (!dryRun) {
      await mkdir(dirname(OUTPUT_STATUS_PATH), { recursive: true });
      await writeFile(OUTPUT_STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    }
    console.error(`[import-pharmacy-duties-ticino] blocked: all ${TICINO_DUTY_REGIONS.length} region fetches failed; atomic finalizer must preserve the previous catalogue+duties pair`);
    process.exitCode = 1;
    return;
  }

  const dutyOutput = buildPharmacyDutiesDataset({
    attemptedAt,
    duties,
    errors,
    warnings,
    preservedRegions,
    successfulRegions,
  });
  if (!dryRun) {
    await mkdir(dirname(OUTPUT_DATA_PATH), { recursive: true });
    await writeFile(OUTPUT_DATA_PATH, `${JSON.stringify(dutyOutput, null, 2)}\n`, 'utf8');
    await writeFile(OUTPUT_STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  }
  console.log(`[import-pharmacy-duties-ticino] ${dryRun ? 'dry-run parsed' : 'staged'} ${duties.length} intervals from ${successfulRegions.length}/${TICINO_DUTY_REGIONS.length} regions`);
  if (errors.length > 0) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error('[import-pharmacy-duties-ticino] fatal:', error);
    process.exitCode = 1;
  });
}
