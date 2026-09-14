#!/usr/bin/env node
/**
 * Build the cross-border pharmacy catalogue.
 *
 * Inputs:
 *   - Ticino's official public-pharmacy PDF (converted with pdftotext);
 *   - Italy's daily Ministry of Health open-data JSON;
 *   - an optional OpenStreetMap extract for ODbL field enrichment.
 *
 * The importer is fail-closed for the Italian dataset and refuses to replace
 * a complete Ticino catalogue with a suspiciously short PDF parse.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { PHARMACY_TIME_ZONE } from '../services/pharmacies/time.mjs';
import { canonicalJson } from './lib/canonical-json-digest.mjs';

import {
  ITALY_BORDER_PROVINCES,
  ITALY_PHARMACY_DATASET_PAGE,
  TICINO_PHARMACY_PDF_URL,
  buildItalianBorderRecords,
  buildOsmQuery,
  buildTicinoCompleteRecords,
  parseTicinoPdfText,
} from './lib/pharmacy-border-parser.mjs';
import { OFCT_REGIONS } from './lib/pharmacy-ticino-parser.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, 'data');
const TICINO_CURRENT_PATH = resolve(DATA_DIR, 'pharmacies-ticino.json');
const TICINO_OUTPUT_PATH = resolve(DATA_DIR, 'pharmacies-ticino-complete.json');
const ITALY_OUTPUT_PATH = resolve(DATA_DIR, 'pharmacies-italy-border.json');
const DUTIES_PATH = resolve(DATA_DIR, 'pharmacy-duties-ticino.json');
const USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const CATALOGUE_SNAPSHOT_PATH = 'data/pharmacies-ticino-complete.json';
const DUTIES_SNAPSHOT_PATH = 'data/pharmacy-duties-ticino.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const CATALOGUE_MAX_AGE_MS = 35 * DAY_MS;
const DUTIES_MAX_AGE_MS = 2 * DAY_MS;

// Floors deliberately leave room below the current snapshots (207 Ticino;
// 542 Italy: CO 193, VA 266, VB 83) while rejecting the partial feeds that
// otherwise look like a successful refresh. Keep these values in one place so
// the importer and its integrity checker enforce the same declared perimeter.
export const BORDER_MINIMUMS = Object.freeze({
  ticino: 200,
  italy: 400,
  italyByProvince: Object.freeze({ CO: 150, VA: 200, VB: 50 }),
});

function snapshotPayload(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const { _release: _ignoredRelease, ...payload } = snapshot;
  return payload;
}

export function pharmacySnapshotSha256(snapshot) {
  return createHash('sha256')
    .update(canonicalJson(snapshotPayload(snapshot) ?? null))
    .digest('hex');
}

function freshnessFor(fetchedAt, evaluatedAt, maxAgeMs) {
  const fetchedMs = typeof fetchedAt === 'string' ? Date.parse(fetchedAt) : NaN;
  const evaluatedMs = typeof evaluatedAt === 'string' ? Date.parse(evaluatedAt) : NaN;
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(evaluatedMs)) return 'unknown';
  const ageMs = evaluatedMs - fetchedMs;
  return ageMs < 0 || ageMs > maxAgeMs ? 'stale' : 'fresh';
}

function oldestRegionFetch(duties) {
  const timestamps = duties
    .map((duty) => ({ value: duty?.fetchedAt, parsed: Date.parse(duty?.fetchedAt || '') }))
    .filter((entry) => Number.isFinite(entry.parsed))
    .sort((a, b) => a.parsed - b.parsed);
  return timestamps[0]?.value || null;
}

function buildRegionReleaseStatus(region, duties, sourceErrors, preservedRegions, evaluatedAt) {
  const regionDuties = duties.filter((duty) => duty?.coverageName === region.name);
  const preserved = preservedRegions.has(region.key);
  const regionError = sourceErrors.some((error) => String(error).startsWith(`${region.key}:`));
  const fetchedAt = oldestRegionFetch(regionDuties);
  const freshness = freshnessFor(fetchedAt, evaluatedAt, DUTIES_MAX_AGE_MS);
  const coverage = preserved || regionError
    ? 'partial'
    : regionDuties.length > 0 ? 'covered' : 'not_published';
  let state = 'fresh';
  if (regionDuties.some((duty) => duty?.status === 'conflicting')) state = 'conflicting';
  else if (regionDuties.length === 0) state = 'not_published';
  else if (freshness === 'unknown') state = 'unknown';
  else if (preserved || regionError) state = 'partial';
  else if (freshness === 'stale') state = 'stale';
  else if (regionDuties.every((duty) => Number.isFinite(Date.parse(duty.endsAt)) && Date.parse(duty.endsAt) <= Date.parse(evaluatedAt))) state = 'expired';
  return {
    name: region.name,
    sourceUrl: region.url,
    dutyCount: regionDuties.length,
    fetchedAt,
    freshness,
    coverage,
    state,
    preserved,
  };
}

function aggregateReleaseState(catalogueFreshness, dutiesFreshness, regions) {
  if (catalogueFreshness === 'unknown' || dutiesFreshness === 'unknown') return 'unknown';
  if (catalogueFreshness === 'stale' || dutiesFreshness === 'stale') return 'stale';
  const states = Object.values(regions).map((region) => region.state);
  if (states.includes('conflicting')) return 'conflicting';
  if (states.every((state) => state === 'not_published')) return 'not_published';
  if (states.every((state) => state === 'expired')) return 'expired';
  if (states.some((state) => state !== 'fresh')) return 'partial';
  return 'fresh';
}

/**
 * Creates the same release metadata for the two snapshots. The hashes cover
 * the complete JSON payload except this metadata block, avoiding a circular
 * hash while making any catalogue/duty data change produce a new releaseId.
 */
export function buildPharmacyReleaseContract({ catalogue, duties, evaluatedAt }) {
  const catalogueFetchedAt = typeof catalogue?._fetchedAt === 'string' ? catalogue._fetchedAt : null;
  const dutiesFetchedAt = typeof duties?._fetchedAt === 'string' ? duties._fetchedAt : null;
  const evaluationTime = evaluatedAt || dutiesFetchedAt || catalogueFetchedAt;
  const catalogueSha256 = pharmacySnapshotSha256(catalogue);
  const dutiesSha256 = pharmacySnapshotSha256(duties);
  const snapshots = {
    catalogue: { path: CATALOGUE_SNAPSHOT_PATH, sha256: catalogueSha256, fetchedAt: catalogueFetchedAt },
    duties: { path: DUTIES_SNAPSHOT_PATH, sha256: dutiesSha256, fetchedAt: dutiesFetchedAt },
  };
  const releaseId = `pharmacy-v1-${createHash('sha256').update(canonicalJson(snapshots)).digest('hex')}`;
  const preservedRegions = new Set(Array.isArray(duties?._preservedRegions) ? duties._preservedRegions : []);
  const sourceErrors = Array.isArray(duties?._errors) ? duties._errors : [];
  const dutiesList = Array.isArray(duties?.duties) ? duties.duties : [];
  const regions = Object.fromEntries(OFCT_REGIONS.map((region) => [
    region.key,
    buildRegionReleaseStatus(region, dutiesList, sourceErrors, preservedRegions, evaluationTime),
  ]));
  const catalogueFreshness = freshnessFor(catalogueFetchedAt, evaluationTime, CATALOGUE_MAX_AGE_MS);
  const dutiesFreshness = freshnessFor(dutiesFetchedAt, evaluationTime, DUTIES_MAX_AGE_MS);
  return {
    version: 1,
    releaseId,
    scope: {
      country: 'CH',
      canton: 'Ticino',
      regions: OFCT_REGIONS.map((region) => region.key),
    },
    timezone: PHARMACY_TIME_ZONE,
    state: aggregateReleaseState(catalogueFreshness, dutiesFreshness, regions),
    snapshots,
    regions,
  };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const asOf = option('--as-of') || new Date().toISOString().slice(0, 10);
const fetchedAt = new Date().toISOString();
const localItalyJson = option('--italy-json');
const localOsmJson = option('--osm-json');
const localTicinoText = option('--ticino-text');
const noOsm = process.argv.includes('--no-osm');
const noTicinoPdf = process.argv.includes('--no-ticino-pdf');

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(resolve(filePath), 'utf8'));
}

async function readPreviousSnapshot(filePath, label) {
  try {
    const snapshot = await readJsonFile(filePath);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Array.isArray(snapshot.pharmacies)) {
      throw new Error(`${label} snapshot must contain a pharmacies array`);
    }
    return snapshot;
  } catch (error) {
    // Only an absent snapshot means first execution. A parse error or any I/O
    // error must stop before a refresh can drop stable IDs, slugs or duties.
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

function recordsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchText(url, { timeoutMs = 60_000, accept = '*/*' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'it,en;q=0.8' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function discoverItalyDownloadUrl() {
  if (process.env.PHARMACY_ITALY_DOWNLOAD_URL) return process.env.PHARMACY_ITALY_DOWNLOAD_URL;
  const page = await fetchText(ITALY_PHARMACY_DATASET_PAGE, { accept: 'text/html' });
  const matches = [...page.matchAll(/(?:https?:\/\/[^"'<>\s]+\/)?FRM_FARMA_5_\d{8}\.json/gi)]
    .map((match) => match[0]);
  const latest = matches.at(-1);
  if (!latest) throw new Error('Italian Ministry dataset page did not expose a JSON download URL');
  return latest.startsWith('http') ? latest : `https://www.dati.salute.gov.it/sites/default/files/opendata/${latest}`;
}

async function readItalyInput() {
  if (localItalyJson) {
    // A local fixture is an input convenience, never public provenance: do
    // not ship `/tmp/...` or a workstation path in the checked-in snapshot.
    return { records: recordsFromPayload(await readJsonFile(localItalyJson)), downloadUrl: ITALY_PHARMACY_DATASET_PAGE };
  }
  const downloadUrl = await discoverItalyDownloadUrl();
  return { records: recordsFromPayload(JSON.parse(await fetchText(downloadUrl, { accept: 'application/json' }))), downloadUrl };
}

async function readOsmInput() {
  if (noOsm) return { elements: [], source: null };
  if (localOsmJson) {
    const parsed = await readJsonFile(localOsmJson);
    return { elements: parsed.elements || [], source: localOsmJson };
  }
  try {
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(buildOsmQuery())}`;
    const parsed = JSON.parse(await fetchText(url, { timeoutMs: 120_000, accept: 'application/json' }));
    return { elements: parsed.elements || [], source: 'https://www.openstreetmap.org/' };
  } catch (error) {
    // OSM is optional enrichment. A rate limit or temporary Overpass outage
    // must not block the official identity/address refresh; the output keeps a
    // warning and simply omits secondary fields for this run.
    const message = error instanceof Error ? error.message : String(error);
    return { elements: [], source: null, warning: `OpenStreetMap enrichment unavailable: ${message}` };
  }
}

async function readTicinoPdfText() {
  if (localTicinoText) return { text: await readFile(resolve(localTicinoText), 'utf8'), source: localTicinoText };
  if (noTicinoPdf) return { text: '', source: null };
  const tempDir = await mkdtemp(resolve(tmpdir(), 'frontaliere-pharmacies-'));
  const pdfPath = resolve(tempDir, 'ticino-pharmacies.pdf');
  try {
    await writeFile(pdfPath, await fetchBuffer(TICINO_PHARMACY_PDF_URL));
    const { stdout } = await execFileAsync('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 4 * 1024 * 1024 });
    return { text: stdout, source: TICINO_PHARMACY_PDF_URL };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function readPreviousTicino(filePath = TICINO_OUTPUT_PATH) {
  return (await readPreviousSnapshot(filePath, 'Ticino')) || { pharmacies: [] };
}

export async function readPreviousTicinoSnapshots({ completePath = TICINO_OUTPUT_PATH, legacyPath = TICINO_CURRENT_PATH } = {}) {
  const complete = await readPreviousSnapshot(completePath, 'Ticino');
  const legacy = await readPreviousSnapshot(legacyPath, 'Ticino legacy');
  if (!complete) return legacy || { pharmacies: [] };
  if (!legacy?.pharmacies?.length) return complete;
  const knownIds = new Set((complete.pharmacies || []).map((pharmacy) => pharmacy.id));
  return {
    ...complete,
    pharmacies: [...(complete.pharmacies || []), ...legacy.pharmacies.filter((pharmacy) => !knownIds.has(pharmacy.id))],
  };
}

export async function readPreviousItaly(filePath = ITALY_OUTPUT_PATH) {
  return (await readPreviousSnapshot(filePath, 'Italy')) || { pharmacies: [] };
}

export async function readDutySnapshot(filePath = DUTIES_PATH) {
  const dataset = await readJsonFile(filePath);
  if (!dataset || typeof dataset !== 'object' || !Array.isArray(dataset.duties)) {
    throw new Error('Ticino duties snapshot must contain a duties array');
  }
  return dataset;
}

export async function readDutyPharmacyIds(filePath = DUTIES_PATH) {
  const dataset = await readDutySnapshot(filePath);
  return [...new Set(dataset.duties.map((duty) => duty?.pharmacyId).filter(Boolean))];
}

async function writeJson(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function assertBorderRecords(records) {
  if (!records.length) throw new Error('Cross-border pharmacy import produced no records');
  const ids = new Set();
  const slugs = new Set();
  for (const pharmacy of records) {
    for (const field of ['id', 'name', 'slug', 'address', 'postalCode', 'city', 'country', 'sourceUrl', 'lastVerifiedAt']) {
      if (!String(pharmacy[field] || '').trim()) throw new Error(`Cross-border pharmacy is missing ${field}: ${JSON.stringify(pharmacy)}`);
    }
    if (pharmacy.country === 'IT' && !String(pharmacy.ministryId || '').trim()) {
      throw new Error(`Italian pharmacy is missing ministryId: ${pharmacy.id || pharmacy.name || '<unknown>'}`);
    }
    if (ids.has(pharmacy.id)) throw new Error(`Duplicate pharmacy id: ${pharmacy.id}`);
    if (slugs.has(pharmacy.slug)) throw new Error(`Duplicate pharmacy slug: ${pharmacy.slug}`);
    ids.add(pharmacy.id);
    slugs.add(pharmacy.slug);
    if (pharmacy.country === 'CH' && pharmacy.canton !== 'Ticino') throw new Error(`Swiss pharmacy is outside Ticino: ${pharmacy.id}`);
    if (pharmacy.country === 'IT' && !ITALY_BORDER_PROVINCES.includes(pharmacy.province)) throw new Error(`Italian pharmacy is outside the configured border provinces: ${pharmacy.id}`);
    if (!['CH', 'IT'].includes(pharmacy.country)) throw new Error(`Unsupported pharmacy country: ${pharmacy.id}`);
  }
}

async function main() {
  const [italy, osm, ticinoInput, previous, previousItaly, dutiesSnapshot] = await Promise.all([
    readItalyInput(),
    readOsmInput(),
    readTicinoPdfText(),
    readPreviousTicinoSnapshots(),
    readPreviousItaly(),
    readDutySnapshot(),
  ]);
  const dutyPharmacyIds = [...new Set(dutiesSnapshot.duties.map((duty) => duty?.pharmacyId).filter(Boolean))];

  const ticinoParsed = parseTicinoPdfText(ticinoInput.text);
  const ticinoWarnings = [...ticinoParsed.warnings];
  let ticinoPharmacies;
  if (ticinoParsed.rows.length >= BORDER_MINIMUMS.ticino) {
    ticinoPharmacies = buildTicinoCompleteRecords(ticinoParsed.rows, {
      previous: previous.pharmacies || [],
      fetchedAt,
      osmElements: osm.elements,
      requiredIds: dutyPharmacyIds,
    });
  } else {
    ticinoWarnings.push(`PDF parse produced ${ticinoParsed.rows.length} records; preserving the previous ${previous.pharmacies?.length || 0}-record dataset`);
    ticinoPharmacies = previous.pharmacies || [];
  }

  if (ticinoPharmacies.length < BORDER_MINIMUMS.ticino) {
    throw new Error(`Ticino import produced only ${ticinoPharmacies.length} records; refusing to publish a truncated dataset (minimum ${BORDER_MINIMUMS.ticino})`);
  }

  const italianPharmacies = buildItalianBorderRecords(italy.records, {
    fetchedAt,
    asOf,
    osmElements: osm.elements,
    datasetUrl: ITALY_PHARMACY_DATASET_PAGE,
    previous: previousItaly.pharmacies || [],
  });
  if (italianPharmacies.length < BORDER_MINIMUMS.italy) {
    throw new Error(`Italian border filter produced only ${italianPharmacies.length} records; refusing to publish a truncated dataset (minimum ${BORDER_MINIMUMS.italy})`);
  }
  for (const [province, minimum] of Object.entries(BORDER_MINIMUMS.italyByProvince)) {
    const count = italianPharmacies.filter((pharmacy) => pharmacy.province === province).length;
    if (count < minimum) {
      throw new Error(`Italian border filter produced only ${count} records for ${province}; refusing to publish a truncated dataset (minimum ${minimum})`);
    }
  }
  assertBorderRecords([...ticinoPharmacies, ...italianPharmacies]);

  const ticinoOutput = {
    _source: TICINO_PHARMACY_PDF_URL,
    _sourceRegions: previous._sourceRegions || [],
    _sourcePublishedAt: '2026-01-15',
    _fetchedAt: fetchedAt,
    _userAgent: USER_AGENT,
    _pharmacyCount: ticinoPharmacies.length,
    _errors: [],
    _warnings: ticinoWarnings,
    _scope: { country: 'CH', canton: 'Ticino' },
    pharmacies: ticinoPharmacies,
  };
  ticinoOutput._release = buildPharmacyReleaseContract({
    catalogue: ticinoOutput,
    duties: dutiesSnapshot,
    evaluatedAt: fetchedAt,
  });
  await writeJson(TICINO_OUTPUT_PATH, ticinoOutput);
  await writeJson(ITALY_OUTPUT_PATH, {
    _source: ITALY_PHARMACY_DATASET_PAGE,
    _sourceDownloadUrl: italy.downloadUrl,
    _license: 'Italian Open Data Licence v2.0',
    _fetchedAt: fetchedAt,
    _asOf: asOf,
    _userAgent: USER_AGENT,
    _pharmacyCount: italianPharmacies.length,
    _errors: [],
    _warnings: osm.elements.length ? [] : [osm.warning || 'OpenStreetMap enrichment unavailable; optional fields remain source-limited'],
    _scope: { country: 'IT', provinces: ITALY_BORDER_PROVINCES },
    _osmAttribution: osm.elements.length ? 'OpenStreetMap contributors, ODbL 1.0' : null,
    pharmacies: italianPharmacies,
  });

  console.log(`[import-pharmacies-border] Ticino: ${ticinoPharmacies.length}; Italy CO/VA/VB: ${italianPharmacies.length}; OSM enrichment records: ${osm.elements.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[import-pharmacies-border] fatal: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
