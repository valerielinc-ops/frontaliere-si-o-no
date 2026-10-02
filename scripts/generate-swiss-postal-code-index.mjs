#!/usr/bin/env node

/**
 * Generate `data/swiss-postal-code-index.json`: Swiss postal code (PLZ/NPA) →
 * its canton and locality, for the postal codes that name exactly ONE canton
 * and ONE locality in the official directory.
 *
 * Source: the same official directory as `data/swiss-locality-postal-codes.json`
 * (swisstopo with Swiss Post, "Amtliches Ortschaftenverzeichnis mit
 * Postleitzahl und Perimeter", open data):
 *
 *   curl -L -o "$TMPDIR/amtovz.zip" \
 *     https://data.geo.admin.ch/ch.swisstopo-vd.ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz_2056.csv.zip
 *   unzip -p "$TMPDIR/amtovz.zip" '*.csv' > "$TMPDIR/amtovz.csv"
 *   node scripts/generate-swiss-postal-code-index.mjs --csv "$TMPDIR/amtovz.csv" --version 2026-09-30
 *
 * Why a second table. `swiss-locality-postal-codes.json` keeps ONE postal code
 * per locality name (Zürich → 8001), so it cannot answer the opposite
 * question: a source that states only an address — Abbott's Zürich
 * requisitions read `Switzerland : Technoparkstrass 1 CH 8005` — names a postal
 * code, not a place. This index answers "which locality is 8005" without
 * guessing: a postal code shared by several cantons (169 of 3190 in the
 * 2026-09-30 release) or by several localities (554) is left out, and so are
 * the Liechtenstein codes (no canton).
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const MUNICIPALITIES_FILE = join(DATA_DIR, 'canton-municipalities.json');
const OUTPUT_FILE = join(DATA_DIR, 'swiss-postal-code-index.json');
const SOURCE_URL = 'https://data.geo.admin.ch/ch.swisstopo-vd.ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz_2056.csv.zip';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** "Küsnacht ZH" → "Küsnacht": Swiss Post disambiguates with a trailing code. */
function stripLocalityCanton(name, cantonCodes) {
  const match = String(name).match(/^(.*\S)\s+([A-Z]{2})$/);
  return match && cantonCodes.has(match[2]) ? match[1] : String(name);
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0].split(';');
  for (const column of ['Ortschaftsname', 'PLZ4', 'Kantonskürzel']) {
    if (!header.includes(column)) throw new Error(`missing column ${column} in the directory CSV`);
  }
  return lines.slice(1).map((line) => {
    const cols = line.split(';');
    return Object.fromEntries(header.map((name, index) => [name, cols[index] ?? '']));
  });
}

const csvPath = argValue('--csv');
const sourceVersion = argValue('--version');
if (!csvPath || !/^\d{4}-\d{2}-\d{2}$/.test(sourceVersion || '')) {
  console.error('usage: node scripts/generate-swiss-postal-code-index.mjs --csv <amtovz.csv> --version <YYYY-MM-DD>');
  process.exit(2);
}

const csvText = readFileSync(csvPath, 'utf8');
const rows = parseCsv(csvText).filter((row) => /^\d{4}$/.test(row.PLZ4));
const cantonCodes = new Set(Object.keys(JSON.parse(readFileSync(MUNICIPALITIES_FILE, 'utf8')).cantons));

const byPostalCode = new Map();
for (const row of rows) {
  const entry = byPostalCode.get(row.PLZ4) || { cantons: new Set(), localities: new Set() };
  entry.cantons.add(row['Kantonskürzel']);
  entry.localities.add(stripLocalityCanton(row.Ortschaftsname, cantonCodes));
  byPostalCode.set(row.PLZ4, entry);
}

const postalCodes = {};
let multiCanton = 0;
let multiLocality = 0;
let noCanton = 0;
for (const postalCode of [...byPostalCode.keys()].sort()) {
  const { cantons, localities } = byPostalCode.get(postalCode);
  if (cantons.size > 1) { multiCanton += 1; continue; }
  const [canton] = cantons;
  if (!cantonCodes.has(canton)) { noCanton += 1; continue; }
  if (localities.size > 1) { multiLocality += 1; continue; }
  postalCodes[postalCode] = [canton, [...localities][0]];
}

const output = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: 'swisstopo with Swiss Post — Amtliches Ortschaftenverzeichnis mit Postleitzahl und Perimeter (official directory of localities with postcodes, open data)',
  sourceUrl: SOURCE_URL,
  sourceVersion,
  sourceRows: rows.length,
  sourceSha256: createHash('sha256').update(csvText).digest('hex'),
  selection: 'A postal code is listed only when every directory row for it names the same canton and the same locality (Swiss Post canton suffix stripped). '
    + `Left out: ${multiCanton} codes spanning several cantons, ${multiLocality} codes shared by several localities, ${noCanton} codes without a canton (Liechtenstein).`,
  totalPostalCodes: Object.keys(postalCodes).length,
  postalCodes,
};

writeFileSync(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${OUTPUT_FILE}: ${output.totalPostalCodes} postal codes (${multiCanton} multi-canton, ${multiLocality} multi-locality, ${noCanton} without canton left out)`);
