#!/usr/bin/env node
/**
 * Polite daily importer for the four server-rendered OFCT duty tables.
 * Locarnese is deliberately not included: its separate site has no complete
 * anagraphic table, so publishing a pharmacy identity there would be unsafe.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OFCT_REGIONS } from './lib/pharmacy-ticino-parser.mjs';
import { buildPharmacyDuties } from './lib/pharmacy-ticino-duty-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const DATA_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-ticino.json');
const PHARMACY_PATH = resolve(REPO_ROOT, 'data/pharmacies-ticino-complete.json');
const STATUS_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-ticino-status.json');
const DUTY_SOURCE = 'https://www.ofct.ch/farmacieturno/';
const DUTY_SOURCE_REGIONS = Object.freeze(OFCT_REGIONS.map((region) => region.url));
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
}) {
  return {
    _source: DUTY_SOURCE,
    _sourceRegions: [...DUTY_SOURCE_REGIONS],
    _fetchedAt: attemptedAt,
    _lastSuccessfulFetchAt: attemptedAt,
    _errors: errors,
    _warnings: warnings,
    _preservedRegions: preservedRegions,
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
  const attemptedAt = new Date().toISOString();
  const previous = await readJson(DATA_PATH, { duties: [], _lastSuccessfulFetchAt: null });
  const previousStatus = await readJson(STATUS_PATH, {});
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

  if (successfulRegions.length === 0) {
    await mkdir(dirname(STATUS_PATH), { recursive: true });
    if (!dryRun) await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    console.error(`[import-pharmacy-duties-ticino] blocked: all ${OFCT_REGIONS.length} region fetches failed; existing dataset preserved`);
    process.exitCode = 1;
    return;
  }

  const output = buildPharmacyDutiesDataset({
    attemptedAt,
    duties,
    errors,
    warnings,
    preservedRegions,
  });
  if (!dryRun) {
    await mkdir(dirname(DATA_PATH), { recursive: true });
    await writeFile(DATA_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  }
  console.log(`[import-pharmacy-duties-ticino] ${dryRun ? 'dry-run parsed' : 'wrote'} ${duties.length} intervals from ${successfulRegions.length}/${OFCT_REGIONS.length} regions`);
  if (errors.length > 0) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error('[import-pharmacy-duties-ticino] fatal:', error);
    process.exitCode = 1;
  });
}
