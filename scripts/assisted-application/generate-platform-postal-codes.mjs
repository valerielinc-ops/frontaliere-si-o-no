#!/usr/bin/env node

/**
 * Build the locality → CAP/NPA directory used by the platform defaults of the
 * assisted application (owner decision 2026-11-09: the postal code is deduced
 * from the CV's town, never asked).
 *
 * Source: GeoNames' Italy and Switzerland postal-code exports (CC BY 4.0).
 * Unlike data/italy-postal-codes.json (unambiguous pairs only, used to read a
 * CV address), every locality keeps one representative code: the lowest one
 * the source assigns it (Milano → 20121). Swiss post-office-box rows
 * («Lugano 4 Caselle») are not localities and are skipped.
 *
 *   node scripts/assisted-application/generate-platform-postal-codes.mjs \
 *     --it /tmp/IT.txt --ch /tmp/CH.txt --version 2026-11-09
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(ROOT, '..', '..', 'functions', 'src', 'data', 'platform-postal-codes.json');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const inputs = { IT: argValue('--it'), CH: argValue('--ch') };
const version = argValue('--version');
if (!inputs.IT || !inputs.CH || !version) {
  console.error('usage: node generate-platform-postal-codes.mjs --it <IT.txt> --ch <CH.txt> --version <YYYY-MM-DD>');
  process.exit(2);
}

const best = new Map();
const hashes = {};
let sourceRows = 0;
for (const [country, path] of Object.entries(inputs)) {
  const text = readFileSync(path, 'utf8');
  hashes[country] = createHash('sha256').update(text).digest('hex');
  const digits = country === 'IT' ? /^\d{5}$/ : /^\d{4}$/;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line) continue;
    const columns = line.split('\t');
    const [countryCode, postalCode, place] = columns;
    // IT: province code (column 7); CH: canton code (column 5).
    const region = country === 'IT' ? columns[6] : columns[4];
    if (countryCode !== country || !digits.test(postalCode) || !/^[A-Z]{2}$/.test(region || '')) continue;
    const name = normalize(place);
    if (!name || /\d/.test(name)) continue;
    sourceRows++;
    const key = `${country}|${region}|${name}`;
    const previous = best.get(key);
    if (!previous || postalCode < previous) best.set(key, postalCode);
  }
}

const entries = [...best].map(([key, code]) => [...key.split('|'), code])
  .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]) || left[2].localeCompare(right[2]));

const metadata = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: 'GeoNames postal code data',
  sourceUrls: ['https://download.geonames.org/export/zip/IT.zip', 'https://download.geonames.org/export/zip/CH.zip'],
  license: 'CC BY 4.0',
  sourceVersion: version,
  sourceSha256: hashes,
  sourceRows,
  selection: 'One representative code per country/region/locality: the lowest the source assigns it.',
};

const serialized = [
  '{',
  ...Object.entries(metadata).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`),
  '  "entries": [',
  entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n'),
  '  ]',
  '}',
].join('\n');

writeFileSync(OUTPUT, `${serialized}\n`, 'utf8');
console.log(`✅ ${OUTPUT}`);
console.log(`   source rows: ${sourceRows}; localities: ${entries.length}`);
