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

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  ITALY_BORDER_PROVINCES,
  ITALY_PHARMACY_DATASET_PAGE,
  TICINO_PHARMACY_PDF_URL,
  buildItalianBorderRecords,
  buildOsmQuery,
  buildTicinoCompleteRecords,
  parseTicinoPdfText,
} from './lib/pharmacy-border-parser.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, 'data');
const TICINO_CURRENT_PATH = resolve(DATA_DIR, 'pharmacies-ticino.json');
const TICINO_OUTPUT_PATH = resolve(DATA_DIR, 'pharmacies-ticino-complete.json');
const ITALY_OUTPUT_PATH = resolve(DATA_DIR, 'pharmacies-italy-border.json');
const DUTIES_PATH = resolve(DATA_DIR, 'pharmacy-duties-ticino.json');
const USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';

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

async function readPrevious() {
  let complete;
  try {
    complete = await readJsonFile(TICINO_OUTPUT_PATH);
  } catch {
    complete = null;
  }
  let legacy;
  try {
    legacy = await readJsonFile(TICINO_CURRENT_PATH);
  } catch {
    legacy = null;
  }
  if (!complete) return legacy || { pharmacies: [] };
  if (!legacy?.pharmacies?.length) return complete;
  const knownIds = new Set((complete.pharmacies || []).map((pharmacy) => pharmacy.id));
  return {
    ...complete,
    pharmacies: [...(complete.pharmacies || []), ...legacy.pharmacies.filter((pharmacy) => !knownIds.has(pharmacy.id))],
  };
}

async function readDutyPharmacyIds() {
  try {
    const dataset = await readJsonFile(DUTIES_PATH);
    return [...new Set((dataset.duties || []).map((duty) => duty.pharmacyId).filter(Boolean))];
  } catch {
    return [];
  }
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
  const [italy, osm, ticinoInput, previous, dutyPharmacyIds] = await Promise.all([
    readItalyInput(),
    readOsmInput(),
    readTicinoPdfText(),
    readPrevious(),
    readDutyPharmacyIds(),
  ]);

  const ticinoParsed = parseTicinoPdfText(ticinoInput.text);
  const ticinoWarnings = [...ticinoParsed.warnings];
  let ticinoPharmacies;
  if (ticinoParsed.rows.length >= 150) {
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

  if (ticinoPharmacies.length < 150) {
    throw new Error(`Ticino import produced only ${ticinoPharmacies.length} records; refusing to publish a truncated dataset`);
  }

  const italianPharmacies = buildItalianBorderRecords(italy.records, {
    fetchedAt,
    asOf,
    osmElements: osm.elements,
    datasetUrl: ITALY_PHARMACY_DATASET_PAGE,
  });
  if (italianPharmacies.length < 400) {
    throw new Error(`Italian border filter produced only ${italianPharmacies.length} records; refusing to publish a truncated dataset`);
  }
  assertBorderRecords([...ticinoPharmacies, ...italianPharmacies]);

  await writeJson(TICINO_OUTPUT_PATH, {
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
  });
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

main().catch((error) => {
  console.error(`[import-pharmacies-border] fatal: ${error?.stack || error}`);
  process.exitCode = 1;
});
