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

const COUNTRY_RULES = [
  { code: 'IT', flag: '--it', url: 'https://download.geonames.org/export/zip/IT.zip', digits: /^\d{5}$/, region: (cols) => cols[6], validRegion: /^[A-Z]{2}$/ },
  { code: 'CH', flag: '--ch', url: 'https://download.geonames.org/export/zip/CH.zip', digits: /^\d{4}$/, region: (cols) => cols[4], validRegion: /^[A-Z]{2}$/ },
  { code: 'DE', flag: '--de', url: 'https://download.geonames.org/export/zip/DE.zip', digits: /^\d{5}$/, region: (cols) => cols[4], validRegion: /^[A-Z]{2}$/ },
  { code: 'FR', flag: '--fr', url: 'https://download.geonames.org/export/zip/FR.zip', digits: /^\d{5}$/, region: (cols) => cols[6] || cols[4], validRegion: /^(?:\d{2,3}|2[AB])$/ },
  { code: 'AT', flag: '--at', url: 'https://download.geonames.org/export/zip/AT.zip', digits: /^\d{4}$/, region: (cols) => cols[4], validRegion: /^\d{2}$/ },
  { code: 'LI', flag: '--li', url: 'https://download.geonames.org/export/zip/LI.zip', digits: /^\d{4}$/, region: () => 'LI', validRegion: /^LI$/ },
];

const version = argValue('--version');
const inputs = COUNTRY_RULES
  .map((rule) => ({ ...rule, path: argValue(rule.flag) }))
  .filter((rule) => Boolean(rule.path));
if (!inputs.some((rule) => rule.code === 'IT') || !inputs.some((rule) => rule.code === 'CH') || !version) {
  console.error('usage: node generate-platform-postal-codes.mjs --it <IT.txt> --ch <CH.txt> [--de <DE.txt> --fr <FR.txt> --at <AT.txt> --li <LI.txt>] --version <YYYY-MM-DD>');
  process.exit(2);
}

const best = new Map();
const hashes = {};
let sourceRows = 0;
for (const { code: country, path, digits, region: readRegion, validRegion } of inputs) {
  const text = readFileSync(path, 'utf8');
  hashes[country] = createHash('sha256').update(text).digest('hex');
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line) continue;
    const columns = line.split('\t');
    const [countryCode, postalCode, place] = columns;
    const region = String(readRegion(columns) || '').trim().toUpperCase();
    if (countryCode !== country || !digits.test(postalCode) || !validRegion.test(region)) continue;
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
  sourceUrls: inputs.map((rule) => rule.url),
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
