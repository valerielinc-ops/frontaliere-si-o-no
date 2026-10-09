#!/usr/bin/env node

/**
 * Build the small locality → CAP directory used by the assisted-application
 * address normaliser.
 *
 * Source: GeoNames' Italy postal-code export (CC BY 4.0). The input contains
 * every postal locality, not a street-level address registry. We retain a
 * locality/province pair only when the source assigns it one CAP; ambiguous
 * pairs stay unknown and the application asks the candidate instead.
 *
 *   node scripts/assisted-application/generate-italy-postal-codes.mjs \
 *     --input /tmp/IT.txt --version 2026-10-09
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(ROOT, 'data', 'italy-postal-codes.json');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const input = argValue('--input');
const version = argValue('--version');
if (!input || !version) {
  console.error('usage: node generate-italy-postal-codes.mjs --input <IT.txt> --version <YYYY-MM-DD>');
  process.exit(2);
}

const sourceText = readFileSync(input, 'utf8');
const rows = sourceText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map((line) => {
  const [countryCode, postalCode, place, , , , province] = line.split('\t');
  return { countryCode, postalCode, place, province };
}).filter((row) => row.countryCode === 'IT' && /^\d{5}$/.test(row.postalCode) && /^[A-Z]{2}$/.test(row.province) && row.place);

const codesByPlace = new Map();
for (const row of rows) {
  const key = `${row.province}|${normalize(row.place)}`;
  const codes = codesByPlace.get(key) || new Set();
  codes.add(row.postalCode);
  codesByPlace.set(key, codes);
}

const entries = [];
for (const [key, codes] of codesByPlace) {
  if (codes.size !== 1) continue;
  const separator = key.indexOf('|');
  entries.push([key.slice(separator + 1), key.slice(0, separator), [...codes][0]]);
}
entries.sort(([leftName, leftProvince], [rightName, rightProvince]) =>
  leftProvince.localeCompare(rightProvince) || leftName.localeCompare(rightName));

const metadata = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: 'GeoNames postal code data',
  sourceUrl: 'https://download.geonames.org/export/zip/IT.zip',
  license: 'CC BY 4.0',
  sourceVersion: version,
  sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
  sourceRows: rows.length,
  selection: 'Only locality/province pairs with exactly one source CAP are retained; ambiguous pairs remain unknown.',
};

// Keep the generated file reviewable: metadata is pretty-printed, each postal
// triple occupies one line, and no 1 MB single-line JSON blob is committed.
const metadataLines = Object.entries(metadata)
  .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
const entryLines = entries.map((entry) => `    ${JSON.stringify(entry)}`);
const serialized = [
  '{',
  ...metadataLines,
  '  "entries": [',
  entryLines.join(',\n'),
  '  ]',
  '}',
].join('\n');

writeFileSync(OUTPUT, `${serialized}\n`, 'utf8');
console.log(`✅ ${OUTPUT}`);
console.log(`   source rows: ${rows.length}; unambiguous entries: ${entries.length}`);
