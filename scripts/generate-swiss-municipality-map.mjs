/**
 * Generate the municipality and canton symbol data used by SwissBubbleMap.
 *
 * Current municipality names, BFS numbers and cantons come from the official
 * BFS commune snapshot. Wikidata P771 joins that register to representative
 * coordinates (P625) and coat-of-arms files (P94). Any missing coordinates are
 * filled from the corresponding official swisstopo municipality polygon.
 * Images stay on Wikimedia Commons; the map only requests them when opened.
 *
 * Run with: node scripts/generate-swiss-municipality-map.mjs
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(ROOT, 'data', 'bfs-communes-snapshot.csv');
const MUNICIPALITY_REFERENCE_PATH = path.join(ROOT, 'data', 'canton-municipalities.json');
const BOUNDARY_REFERENCE_PATH = path.join(ROOT, 'data', 'swiss-canton-boundaries.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'swiss-municipality-map.json');
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const SWISSTOPO_LAYER = 'ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill';
const SWISSTOPO_API = 'https://api3.geo.admin.ch/rest/services/api/MapServer';
const USER_AGENT = 'FrontaliereTicinoJobMap/1.0 (https://frontaliereticino.ch)';
const WIKIDATA_LANGUAGES = ['de', 'fr', 'it', 'rm', 'en'];
const MANUAL_SYMBOLS = {
  // Wikidata has no current item with a usable P771/P94 statement for this
  // BFS entry. This is the municipal coat published on Wikimedia Commons.
  311: {
    kind: 'coat-of-arms',
    commonsFile: 'CHE Schüpfen COA.svg',
  },
  // Haute-Ajoie uses its official municipal logo; no coat of arms for the
  // current merged municipality is listed in the official municipality site.
  6809: {
    kind: 'municipal-logo',
    imageUrl: 'https://hauteajoie.ch/wp-content/uploads/2022/05/Groupe-435.png',
    sourceUrl: 'https://hauteajoie.ch/',
  },
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (character !== '\r') {
      value += character;
    }
  }

  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  const [header = [], ...dataRows] = rows;
  return dataRows.map((cells) => Object.fromEntries(
    header.map((key, index) => [key, cells[index] || '']),
  ));
}

function normalizeName(value, cantonCode) {
  const cantonSuffix = cantonCode ? new RegExp(`\\s*\\(${cantonCode}\\)\\s*$`, 'i') : null;
  return String(value || '')
    .replace(cantonSuffix || /$^/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function municipalitiesFromBfsSnapshot(text) {
  const rows = parseCsv(text);
  const cantonsByHistoricalCode = new Map(
    rows.filter((row) => row.Level === '1')
      .map((row) => [row.HistoricalCode, row.ShortName]),
  );
  const districtsByHistoricalCode = new Map(
    rows.filter((row) => row.Level === '2')
      .map((row) => [row.HistoricalCode, row]),
  );

  return rows
    .filter((row) => row.Level === '3' && !row.ValidTo)
    .map((row) => {
      const district = districtsByHistoricalCode.get(row.Parent);
      const cantonCode = cantonsByHistoricalCode.get(district?.Parent) || '';
      const bfsCode = Number(row.BfsCode);
      if (!Number.isSafeInteger(bfsCode) || bfsCode <= 0 || !cantonCode) {
        throw new Error(`Invalid current BFS municipality row: ${row.Name} (${row.BfsCode})`);
      }
      return { bfsCode, name: row.Name, cantonCode };
    })
    .sort((a, b) => a.bfsCode - b.bfsCode);
}

function queryString(query) {
  return `${WIKIDATA_ENDPOINT}?${new URLSearchParams({ query, format: 'json' })}`;
}

async function fetchSparql(query) {
  const response = await fetch(queryString(query), {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`Wikidata SPARQL returned HTTP ${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result?.results?.bindings)) throw new Error('Wikidata returned an invalid SPARQL result');
  return result.results.bindings;
}

function municipalityLabelsQuery() {
  const languages = WIKIDATA_LANGUAGES.map((language) => `"${language}"`).join(', ');
  return `
    SELECT ?code ?item ?label WHERE {
      ?item wdt:P31 wd:Q70208 ; wdt:P771 ?code ; rdfs:label ?label .
      FILTER(LANG(?label) IN (${languages}))
    }
  `;
}

function municipalityStatementsQuery() {
  return `
    SELECT ?code ?item ?kind ?value ?rank WHERE {
      ?item wdt:P31 wd:Q70208 ; wdt:P771 ?code .
      {
        ?item p:P625 ?statement .
        ?statement ps:P625 ?value ; wikibase:rank ?rank .
        BIND("coordinate" AS ?kind)
      }
      UNION
      {
        ?item p:P94 ?statement .
        ?statement ps:P94 ?value ; wikibase:rank ?rank .
        BIND("coat" AS ?kind)
      }
    }
  `;
}

function cantonArmsQuery() {
  return `
    SELECT ?iso ?coat ?rank WHERE {
      ?item wdt:P300 ?iso ; p:P94 ?statement .
      ?statement ps:P94 ?coat ; wikibase:rank ?rank .
      FILTER(STRSTARTS(STR(?iso), "CH-"))
    }
  `;
}

function numericCode(value) {
  const code = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(code) ? code : null;
}

function ensureEntity(entities, rawCode, uri) {
  const bfsCode = numericCode(rawCode);
  if (bfsCode === null || !uri) return null;
  let byItem = entities.get(bfsCode);
  if (!byItem) {
    byItem = new Map();
    entities.set(bfsCode, byItem);
  }
  let entity = byItem.get(uri);
  if (!entity) {
    entity = { uri, labels: new Set(), coordinates: [], coats: [] };
    byItem.set(uri, entity);
  }
  return entity;
}

export function coordinateFromWkt(value) {
  const match = /^Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(String(value || ''));
  if (!match) return null;
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function selectBestStatement(statements) {
  const usable = statements.filter((statement) => statement.rank !== 'DeprecatedRank');
  const preferred = usable.filter((statement) => statement.rank === 'PreferredRank');
  const pool = preferred.length > 0 ? preferred : usable;
  const unique = new Map(pool.map((statement) => [statement.value, statement]));
  return [...unique.values()].sort((a, b) => a.value.localeCompare(b.value))[0] || null;
}

function commonsFilename(uri) {
  const pathPart = new URL(uri).pathname;
  const encoded = pathPart.slice(pathPart.lastIndexOf('/') + 1);
  return decodeURIComponent(encoded);
}

function municipalityItemsFromBindings(labelBindings, statementBindings) {
  const entities = new Map();
  for (const binding of labelBindings) {
    const entity = ensureEntity(entities, binding.code?.value, binding.item?.value);
    if (entity && binding.label?.value) entity.labels.add(binding.label.value);
  }
  for (const binding of statementBindings) {
    const entity = ensureEntity(entities, binding.code?.value, binding.item?.value);
    if (!entity || !binding.value?.value) continue;
    const statement = { value: binding.value.value, rank: binding.rank?.value?.split('#').at(-1) || 'NormalRank' };
    if (binding.kind?.value === 'coordinate') entity.coordinates.push(statement);
    if (binding.kind?.value === 'coat') entity.coats.push(statement);
  }
  return entities;
}

async function swisstopoMunicipalityCentroid(bfsCode) {
  const url = `${SWISSTOPO_API}/${SWISSTOPO_LAYER}/${bfsCode}?geometryFormat=geojson&sr=4326`;
  const response = await fetch(url, {
    headers: { Accept: 'application/geo+json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`swisstopo municipality ${bfsCode} returned HTTP ${response.status}`);
  const body = await response.json();
  const geometry = body?.feature?.geometry;
  const polygons = geometry?.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon'
      ? geometry.coordinates
      : [];
  let weightedLng = 0;
  let weightedLat = 0;
  let totalArea = 0;
  for (const polygon of polygons) {
    const ring = polygon?.[0];
    if (!Array.isArray(ring) || ring.length < 4) continue;
    let twiceArea = 0;
    let lngSum = 0;
    let latSum = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
      const [x1, y1] = ring[index];
      const [x2, y2] = ring[index + 1];
      const cross = x1 * y2 - x2 * y1;
      twiceArea += cross;
      lngSum += (x1 + x2) * cross;
      latSum += (y1 + y2) * cross;
    }
    if (Math.abs(twiceArea) < 1e-12) continue;
    const area = Math.abs(twiceArea) / 2;
    weightedLng += (lngSum / (3 * twiceArea)) * area;
    weightedLat += (latSum / (3 * twiceArea)) * area;
    totalArea += area;
  }
  if (totalArea <= 0) throw new Error(`swisstopo returned no usable polygon for municipality ${bfsCode}`);
  return { lat: weightedLat / totalArea, lng: weightedLng / totalArea };
}

async function municipalityRecord(municipality, entities) {
  const candidates = [...(entities.get(municipality.bfsCode)?.values() || [])];
  const wantedName = normalizeName(municipality.name, municipality.cantonCode);
  const exact = candidates.filter((candidate) => [...candidate.labels]
    .some((label) => normalizeName(label, municipality.cantonCode) === wantedName));
  const entity = exact.length === 1 ? exact[0] : exact.length === 0 && candidates.length === 1 ? candidates[0] : null;
  if (!entity && !MANUAL_SYMBOLS[municipality.bfsCode]) {
    throw new Error(`Cannot uniquely match BFS ${municipality.bfsCode} ${municipality.name} (${municipality.cantonCode}) to Wikidata P771`);
  }

  const manual = MANUAL_SYMBOLS[municipality.bfsCode];
  const coordinateStatement = entity ? selectBestStatement(entity.coordinates) : null;
  const coordinate = coordinateFromWkt(coordinateStatement?.value)
    || await swisstopoMunicipalityCentroid(municipality.bfsCode);
  const coatStatement = entity ? selectBestStatement(entity.coats) : null;
  const commonsFile = manual?.commonsFile || (coatStatement ? commonsFilename(coatStatement.value) : null);
  const symbol = manual?.kind === 'municipal-logo'
    ? { kind: manual.kind, imageUrl: manual.imageUrl, sourceUrl: manual.sourceUrl }
    : commonsFile
      ? { kind: 'coat-of-arms', commonsFile }
      : null;
  if (!symbol) throw new Error(`No official municipal symbol found for BFS ${municipality.bfsCode} ${municipality.name}`);

  return {
    bfsCode: municipality.bfsCode,
    cantonCode: municipality.cantonCode,
    name: municipality.name,
    lat: Number(coordinate.lat.toFixed(6)),
    lng: Number(coordinate.lng.toFixed(6)),
    coordinateSource: coordinateStatement ? 'Wikidata P625' : 'swisstopo municipality boundary centroid',
    ...symbol,
  };
}

function cantonRecordsFromBindings(bindings) {
  const byCode = new Map();
  for (const binding of bindings) {
    const code = binding.iso?.value?.split('-').at(-1)?.toUpperCase();
    const file = binding.coat?.value;
    if (!code || !file) continue;
    const values = byCode.get(code) || [];
    values.push({ value: file, rank: binding.rank?.value?.split('#').at(-1) || 'NormalRank' });
    byCode.set(code, values);
  }
  const records = [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, statements]) => {
    const statement = selectBestStatement(statements);
    if (!statement) throw new Error(`No official canton arms found for ${code}`);
    const commonsFile = commonsFilename(statement.value);
    return { code, commonsFile };
  });
  const expected = ['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH'];
  if (records.length !== expected.length || records.some((record, index) => record.code !== expected[index])) {
    throw new Error(`Expected canton arms for all 26 cantons; got ${records.map((record) => record.code).join(', ')}`);
  }
  return records;
}

export async function buildMapData({ snapshotCsv, municipalityReference, boundaryReference }) {
  const municipalities = municipalitiesFromBfsSnapshot(snapshotCsv);
  if (municipalities.length !== municipalityReference.totalMunicipalities) {
    throw new Error(`BFS snapshot has ${municipalities.length} current municipalities; reference says ${municipalityReference.totalMunicipalities}`);
  }

  const labelBindings = await fetchSparql(municipalityLabelsQuery());
  const statementBindings = await fetchSparql(municipalityStatementsQuery());
  const municipalityEntities = municipalityItemsFromBindings(labelBindings, statementBindings);
  const municipalMap = [];
  for (const municipality of municipalities) {
    municipalMap.push(await municipalityRecord(municipality, municipalityEntities));
  }

  const cantonBindings = await fetchSparql(cantonArmsQuery());
  const cantons = cantonRecordsFromBindings(cantonBindings);
  const result = {
    generatedAt: new Date().toISOString().slice(0, 10),
    municipalityReferenceDate: municipalityReference.generatedAt,
    cantonBoundaryReferenceDate: boundaryReference.generatedAt,
    sources: {
      municipalities: 'BFS official commune snapshot, joined by BFS municipality number (P771)',
      coordinates: 'Wikidata P625; missing point coordinates use the swisstopo municipality polygon centroid',
      municipalCoats: 'Wikidata P94 and Wikimedia Commons per-file pages',
      cantonCoats: 'Wikidata P94 and Wikimedia Commons per-file pages',
      cantonBoundaries: 'swisstopo swissBOUNDARIES3D',
    },
    municipalityCount: municipalMap.length,
    cantons,
    municipalities: municipalMap,
  };
  return result;
}

async function main() {
  const [snapshotCsv, municipalityReferenceText, boundaryReferenceText] = await Promise.all([
    readFile(SNAPSHOT_PATH, 'utf8'),
    readFile(MUNICIPALITY_REFERENCE_PATH, 'utf8'),
    readFile(BOUNDARY_REFERENCE_PATH, 'utf8'),
  ]);
  const result = await buildMapData({
    snapshotCsv,
    municipalityReference: JSON.parse(municipalityReferenceText),
    boundaryReference: JSON.parse(boundaryReferenceText),
  });
  const json = `${JSON.stringify(result)}\n`;
  await writeFile(OUTPUT_PATH, json);
  const counts = result.municipalities.reduce((summary, municipality) => {
    summary[municipality.kind] = (summary[municipality.kind] || 0) + 1;
    summary[municipality.coordinateSource] = (summary[municipality.coordinateSource] || 0) + 1;
    return summary;
  }, {});
  console.log(`[swiss-municipality-map] ${result.municipalityCount} municipalities, ${result.cantons.length} cantons, ${json.length} bytes`);
  console.log(`[swiss-municipality-map] wrote ${OUTPUT_PATH}; data summary ${JSON.stringify(counts)}`);
  console.log(`[swiss-municipality-map] SHA-256 ${createHash('sha256').update(json).digest('hex')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[swiss-municipality-map] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
