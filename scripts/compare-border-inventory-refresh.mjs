#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  OSM_FUEL_DATA_URL,
  OSM_FUEL_LICENSE,
  OSM_FUEL_PROVIDER,
  OSM_FUEL_QUERY_TAG,
  OSM_FUEL_SOURCE,
} from './lib/fuel-openstreetmap.mjs';
import {
  ITALY_BORDER_PROVINCES,
  ITALY_PHARMACY_DATASET_PAGE,
  TICINO_PHARMACY_AREA,
  isTicinoPharmacyPdfUrl,
} from './lib/pharmacy-border-parser.mjs';
import { normaliseText } from './lib/fuel-station-dedup.mjs';
import { OFCT_REGIONS } from './lib/pharmacy-ticino-parser.mjs';
import { cantonAtPoint } from './lib/swiss-canton-geo.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OFCT_URLS = new Set(OFCT_REGIONS.map(({ url }) => url));
const ITALY_PROVINCES = new Set(ITALY_BORDER_PROVINCES);

function hasIdentity(value) {
  return typeof value === 'string' && value !== '' && value === value.trim();
}

function isOfficialTicinoSource(url) {
  if (OFCT_URLS.has(url)) return true;
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password && !parsed.port && parsed.href === isTicinoPharmacyPdfUrl(url);
  } catch {
    return false;
  }
}

function hasOsmIdentity(row) {
  if (!row.inventoryId.startsWith('osm:') || row.inventoryId === 'osm:' || row.id !== row.inventoryId) return false;
  if (!row.inventoryId.startsWith('osm:fallback:')) return true;
  const fallback = `${normaliseText(row.name)}|${normaliseText(row.address)}|${row.lat.toFixed(6)},${row.lng.toFixed(6)}`;
  return row.inventoryId === `osm:fallback:${fallback}`;
}

const FUEL = {
  path: 'data/fuel-station-inventory.json',
  timestamp: 'observedAt',
  records: 'stations',
  count: 'stationCount',
  identity: (row) => row?.inventoryId,
  label: 'Carburanti CH',
  sources: `OpenStreetMap via Geofabrik (${OSM_FUEL_QUERY_TAG}, ${OSM_FUEL_LICENSE})`,
  validSnapshot: (snapshot) => snapshot.schemaVersion === 1
    && snapshot.country === 'CH' && snapshot.scope === 'national'
    && snapshot.coverageType === 'open-inventory'
    && snapshot.source?.provider === OSM_FUEL_PROVIDER
    && snapshot.source?.sourceId === OSM_FUEL_SOURCE
    && snapshot.source?.query === OSM_FUEL_QUERY_TAG
    && snapshot.source?.dataUrl === OSM_FUEL_DATA_URL
    && snapshot.source?.license === OSM_FUEL_LICENSE,
  validAddition: (row) => row.source === OSM_FUEL_SOURCE && row.inventorySource === OSM_FUEL_SOURCE
    && row.sp95PriceChf === null && row.dieselPriceChf === null
    && Array.isArray(row.fuelTypes)
    && (row.fuelTypes.length === 0 || row.fuelTypes.some((fuel) => fuel !== 'avgas' && fuel !== 'jet'))
    && Number.isFinite(row.lat) && Number.isFinite(row.lng)
    && Boolean(row.canton) && cantonAtPoint(row) === row.canton && hasOsmIdentity(row),
};

const PHARMACY = {
  timestamp: '_fetchedAt',
  records: 'pharmacies',
  count: '_pharmacyCount',
  identity: (row) => row?.id,
  validSnapshot: () => true, // The workflow already validates the complete catalogue/duty release.
};

const TICINO = {
  ...PHARMACY,
  path: 'data/pharmacies-ticino-complete.json',
  label: 'Farmacie Ticino',
  sources: 'catalogo ufficiale del Cantone Ticino e repertori OFCT, OpenStreetMap per i soli arricchimenti',
  validAddition: (row) => row.country === 'CH' && row.canton === TICINO_PHARMACY_AREA
    && row.sourceType === 'official' && isOfficialTicinoSource(row.sourceUrl),
};

const ITALY = {
  ...PHARMACY,
  path: 'data/pharmacies-italy-border.json',
  label: 'Farmacie Italia (CO, VA, VB)',
  sources: 'Ministero della Salute, OpenStreetMap per i soli arricchimenti',
  validAddition: (row) => row.country === 'IT' && ITALY_PROVINCES.has(row.province)
    && row.sourceType === 'official' && row.sourceUrl === ITALY_PHARMACY_DATASET_PAGE
    && hasIdentity(row.ministryId) && row.id === `it-msal-${row.ministryId}`,
};

const CATALOGUES = { fuel: [FUEL], pharmacies: [TICINO, ITALY] };

function utcMonth(timestamp) {
  if (typeof timestamp !== 'string') return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  if (timestamp !== iso && timestamp !== iso.replace('.000Z', 'Z')) return null;
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function compareCatalogue(catalogue, previous, candidate) {
  const { label, records, count, identity, validSnapshot, validAddition } = catalogue;
  const rows = candidate?.[records];
  if (!Array.isArray(rows) || rows.length === 0 || candidate[count] !== rows.length || !validSnapshot(candidate)) {
    throw new Error(`${label}: invalid or empty candidate catalogue`);
  }
  if (previous !== null && !Array.isArray(previous?.[records])) {
    throw new Error(`${label}: invalid baseline catalogue`);
  }

  const previousCounts = new Map();
  const counts = { added: 0, removed: 0, unevaluable: 0, unchanged: 0 };
  for (const row of previous?.[records] ?? []) {
    const id = identity(row);
    if (hasIdentity(id)) previousCounts.set(id, (previousCounts.get(id) ?? 0) + 1);
    else counts.unevaluable++;
  }

  const candidateIds = new Set();
  for (const row of rows) {
    const id = identity(row);
    if (!hasIdentity(id) || candidateIds.has(id)) {
      throw new Error(`${label}: missing or duplicate candidate identity`);
    }
    candidateIds.add(id);
    const matches = previousCounts.get(id) ?? 0;
    if (matches === 1) {
      counts.unchanged++;
      continue;
    }
    if (!validAddition(row)) throw new Error(`${label}: candidate identity lacks source or scope evidence: ${id}`);
    if (matches === 0) counts.added++;
  }
  for (const [id, occurrences] of previousCounts) {
    if (occurrences > 1) counts.unevaluable += occurrences + Number(candidateIds.has(id));
    else if (!candidateIds.has(id)) counts.removed++;
  }
  return { baselineNew: previous === null, ...counts };
}

export function compareMonthlyRefresh(kind, runAt, readSnapshots) {
  if (!Object.hasOwn(CATALOGUES, kind)) throw new Error(`Unknown inventory refresh: ${kind}`);
  const runMonth = utcMonth(runAt);
  if (runMonth === null) throw new Error('Expected an ISO UTC execution timestamp');
  const catalogues = CATALOGUES[kind].map((catalogue) => ({
    catalogue,
    snapshots: readSnapshots(catalogue.path),
  }));
  // Only a snapshot in HEAD can advance the cadence. Keep pharmacy reports paired.
  if (catalogues.every(({ catalogue, snapshots }) => {
    const month = utcMonth(snapshots.previous?.[catalogue.timestamp]);
    return month !== null && month >= runMonth;
  })) return '';
  const reports = catalogues.map(({ catalogue, snapshots }) => {
    const result = compareCatalogue(catalogue, snapshots.previous, snapshots.candidate);
    return `- ${catalogue.label} (${catalogue.sources})${result.baselineNew ? ' · nuova baseline' : ''} · aggiunti ${result.added}, rimossi ${result.removed}, non valutabili ${result.unevaluable}, invariati ${result.unchanged}.`;
  });
  return '\n- Verifica mensile delle identità nei cataloghi (UTC ' + runAt.slice(0, 10) + ')\n'
    + reports.map((report) => `  ${report}\n`).join('');
}

function readRunnerSnapshots(path) {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // ls-tree distinguishes a new catalogue from a failed read of a tracked blob.
  const tracked = Boolean(git('ls-tree', 'HEAD', '--', path));
  const previous = tracked
    ? JSON.parse(git('show', `HEAD:${path}`))
    : null;
  if (previous === null && tracked) {
    throw new Error(`${path}: tracked baseline is null`);
  }
  return {
    previous,
    get candidate() {
      return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
    },
  };
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    process.stdout.write(compareMonthlyRefresh(process.argv[2], process.argv[3], readRunnerSnapshots));
  } catch (error) {
    console.error(`[monthly-border-inventory] ${error.message}`);
    process.exitCode = 1;
  }
}
