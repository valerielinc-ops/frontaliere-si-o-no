#!/usr/bin/env node

/**
 * Generate `data/swiss-locality-postal-codes.json`: one postal code (PLZ/NPA)
 * per Swiss municipality and per official locality, scoped by canton.
 *
 * Source: the official directory of localities with postcodes published by
 * swisstopo together with Swiss Post ("Amtliches Ortschaftenverzeichnis mit
 * Postleitzahl und Perimeter", open data). Download the CSV release and pass it:
 *
 *   curl -L -o "$TMPDIR/amtovz.zip" \
 *     https://data.geo.admin.ch/ch.swisstopo-vd.ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz_2056.csv.zip
 *   unzip -p "$TMPDIR/amtovz.zip" '*.csv' > "$TMPDIR/amtovz.csv"
 *   node scripts/generate-swiss-locality-postal-codes.mjs --csv "$TMPDIR/amtovz.csv" --version 2026-08-28
 *
 * Why it exists. The JobPosting builder (`build-plugins/shared/jobPostingSchema.ts`)
 * accepts every BFS municipality and curated alias of `data/canton-municipalities.json`
 * as `addressLocality`, but the curated CAP tables only knew ~200 localities.
 * Every other municipality fell back to the canton capital's CAP and street:
 * `Pully` next to `1003` and `Place de la Palud 2` (Lausanne). This table gives
 * each of those localities its own official CAP, so the capital tuple is never
 * needed beside a different locality.
 *
 * Selection rule, one CAP per municipality (the directory lists every
 * locality/CAP pair that intersects a municipality, with the share of that
 * locality's addresses lying inside it):
 *   1. the locality that bears the municipality's own name ("Pully" in Pully,
 *      "Küsnacht ZH" in Küsnacht (ZH));
 *   2. otherwise a locality whose name contains the municipality's name or is
 *      contained in it ("Bad Zurzach" in Zurzach, "Möriken" in Möriken-Wildegg);
 *   3. otherwise any locality of the municipality.
 * In tier 1 the lowest CAP wins: a town with several CAPs keeps its base one
 * (Aarau 5000, Bern 3004, Lausanne 1003 — "Lausanne 25/26/27" are distinct
 * localities). In tiers 2 and 3 the locality with the highest address share
 * wins, then the lowest CAP. Every emitted CAP therefore belongs to that
 * municipality in the official directory.
 *
 * Localities that are not municipalities ("Villars-sur-Ollon" in Ollon) are
 * listed too, with the CAP of their highest-share row, so a curated alias that
 * names a real locality resolves without regenerating this file. A locality
 * name that maps to different CAPs in different municipalities of the same
 * canton is ambiguous and is left out.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const MUNICIPALITIES_FILE = join(DATA_DIR, 'canton-municipalities.json');
const OUTPUT_FILE = join(DATA_DIR, 'swiss-locality-postal-codes.json');
const SOURCE_URL = 'https://data.geo.admin.ch/ch.swisstopo-vd.ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz_2056.csv.zip';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Matching key: diacritics, case and punctuation folded, plus the Swiss Post
 * abbreviations "b." (bei) and "St" (Sankt/Saint). Same folding as
 * `officialLocalityKey` in build-plugins/shared/postalCodes.ts.
 */
function matchKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\b(?:sankt|saint)\b/g, 'st')
    .replace(/\bbei\b/g, 'b');
}

/** "Küsnacht (ZH)" → "Küsnacht": BFS disambiguates homonyms with "(XX)". */
function stripMunicipalityCanton(name) {
  return String(name).replace(/\s*\([A-Z]{2}\)\s*$/, '');
}

/** "Küsnacht ZH" → "Küsnacht": Swiss Post disambiguates with a trailing code. */
function stripLocalityCanton(name, cantonCodes) {
  const match = String(name).match(/^(.*\S)\s+([A-Z]{2})$/);
  return match && cantonCodes.has(match[2]) ? match[1] : String(name);
}

function share(row) {
  return Number.parseFloat(String(row.Adressenanteil).replace('%', '').trim()) || 0;
}

function lowestPostalCode(rows) {
  return rows.slice().sort((a, b) => Number(a.PLZ4) - Number(b.PLZ4))[0];
}

function highestShare(rows) {
  return rows
    .slice()
    .sort((a, b) => share(b) - share(a) || Number(a.PLZ4) - Number(b.PLZ4))[0];
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0].split(';');
  for (const column of ['Ortschaftsname', 'PLZ4', 'Gemeindename', 'Kantonskürzel', 'Adressenanteil']) {
    if (!header.includes(column)) throw new Error(`CSV column missing: ${column}`);
  }
  return lines.slice(1).map((line) => {
    const cols = line.split(';');
    return Object.fromEntries(header.map((name, index) => [name, (cols[index] || '').trim()]));
  });
}

const csvPath = argValue('--csv');
const sourceVersion = argValue('--version');
if (!csvPath || !sourceVersion) {
  console.error('usage: node scripts/generate-swiss-locality-postal-codes.mjs --csv <amtovz.csv> --version <YYYY-MM-DD>');
  process.exit(2);
}

const csvText = readFileSync(csvPath, 'utf8');
const rows = parseCsv(csvText).filter((row) => /^\d{4}$/.test(row.PLZ4));
const municipalityData = JSON.parse(readFileSync(MUNICIPALITIES_FILE, 'utf8'));
const cantonCodes = new Set(Object.keys(municipalityData.cantons));

const rowsByMunicipality = new Map();
for (const row of rows) {
  const key = `${row['Kantonskürzel']}|${row.Gemeindename}`;
  if (!rowsByMunicipality.has(key)) rowsByMunicipality.set(key, []);
  rowsByMunicipality.get(key).push(row);
}

const cantons = {};
const tierCounts = { name: 0, contains: 0, any: 0 };
const missing = [];
let ambiguousLocalities = 0;

for (const canton of [...cantonCodes].sort()) {
  const entries = {};
  const takenKeys = new Set();
  for (const municipality of municipalityData.cantons[canton].municipalities || []) {
    const candidates = rowsByMunicipality.get(`${canton}|${municipality}`) || [];
    if (candidates.length === 0) {
      missing.push(`${canton}|${municipality}`);
      continue;
    }
    const municipalityKey = matchKey(stripMunicipalityCanton(municipality));
    const localityKey = (row) => matchKey(stripLocalityCanton(row.Ortschaftsname, cantonCodes));
    const named = candidates.filter((row) => localityKey(row) === municipalityKey);
    const containing = candidates.filter((row) => {
      const key = localityKey(row);
      return ` ${key} `.includes(` ${municipalityKey} `) || ` ${municipalityKey} `.includes(` ${key} `);
    });
    const tier = named.length > 0 ? 'name' : containing.length > 0 ? 'contains' : 'any';
    tierCounts[tier] += 1;
    entries[municipality] = named.length > 0
      ? lowestPostalCode(named).PLZ4
      : highestShare(containing.length > 0 ? containing : candidates).PLZ4;
    takenKeys.add(municipalityKey);
  }

  const rowsByLocality = new Map();
  for (const row of rows) {
    if (row['Kantonskürzel'] !== canton) continue;
    const name = stripLocalityCanton(row.Ortschaftsname, cantonCodes);
    const key = matchKey(name);
    if (takenKeys.has(key)) continue;
    if (!rowsByLocality.has(key)) rowsByLocality.set(key, { name, rows: [] });
    rowsByLocality.get(key).rows.push(row);
  }
  for (const { name, rows: localityRows } of rowsByLocality.values()) {
    const postalCodesByMunicipality = new Map();
    for (const row of localityRows) {
      if (!postalCodesByMunicipality.has(row.Gemeindename)) postalCodesByMunicipality.set(row.Gemeindename, new Set());
      postalCodesByMunicipality.get(row.Gemeindename).add(row.PLZ4);
    }
    const distinctPostalCodes = new Set(localityRows.map((row) => row.PLZ4));
    const spansMunicipalities = postalCodesByMunicipality.size > 1;
    if (spansMunicipalities && distinctPostalCodes.size > 1) {
      // Same name, different CAPs, different municipalities: two localities
      // that happen to share a name. Leave it out rather than guess.
      const perMunicipality = [...postalCodesByMunicipality.values()].map((set) => [...set].sort().join(','));
      if (new Set(perMunicipality).size > 1) {
        ambiguousLocalities += 1;
        continue;
      }
    }
    entries[name] = highestShare(localityRows).PLZ4;
  }

  cantons[canton] = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, 'de')),
  );
}

if (missing.length > 0) {
  console.error(`❌ ${missing.length} BFS municipalities have no row in the directory: ${missing.slice(0, 20).join(', ')}`);
  process.exit(1);
}

const output = {
  generatedAt: new Date().toISOString().split('T')[0],
  source: 'swisstopo with Swiss Post — Amtliches Ortschaftenverzeichnis mit Postleitzahl und Perimeter (official directory of localities with postcodes, open data)',
  sourceUrl: SOURCE_URL,
  sourceVersion,
  sourceRows: rows.length,
  sourceSha256: createHash('sha256').update(csvText).digest('hex'),
  selection: 'One CAP per canton-scoped name. Municipality (BFS name): the lowest CAP of the locality bearing its name; else, by highest address share then lowest CAP, a locality whose name contains or is contained in it, else any of its localities. Other official localities: their highest-share CAP; names with conflicting CAPs across municipalities are omitted.',
  totalMunicipalities: Object.values(tierCounts).reduce((sum, count) => sum + count, 0),
  cantons,
};

writeFileSync(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
const totalEntries = Object.values(cantons).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
console.log(`✅ ${OUTPUT_FILE}`);
console.log(`   municipalities: ${output.totalMunicipalities} (by name ${tierCounts.name}, by containment ${tierCounts.contains}, other locality ${tierCounts.any})`);
console.log(`   entries: ${totalEntries}, ambiguous locality names left out: ${ambiguousLocalities}`);
