#!/usr/bin/env node
/**
 * Valida i mirror del dataset fiscale per cantone dopo il producer
 * (`fetch-canton-tax-data.mjs`), prima del commit del workflow.
 *
 * Fallisce chiuso: dataset assente, malformato, sotto soglia (vedi
 * `assertCantonTaxDataset`) o mirror divergenti. Non ripara e non inventa
 * valori: legge e basta.
 *
 * L'anno validato e' quello di `public/data/canton-tax/latest.json`: il
 * producer puo' legittimamente ripiegare sull'anno precedente in gennaio, se
 * ESTV non ha ancora caricato il nuovo. Un `latest` piu' vecchio di un anno
 * rispetto al calendario invece e' un publisher fermo, e fa fallire.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCantonTaxDataset } from './fetch-canton-tax-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`canton-tax: file mancante ${filePath} (${err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`canton-tax: JSON non valido ${filePath} (${err.message})`);
  }
}

export function validateCantonTaxData({ root = ROOT, now = new Date() } = {}) {
  const latestPath = path.join(root, 'public', 'data', 'canton-tax', 'latest.json');
  const latest = readJson(latestPath);
  const year = latest.year;
  const calendarYear = now.getUTCFullYear();
  if (!Number.isInteger(year) || year < calendarYear - 1 || year > calendarYear) {
    throw new Error(`canton-tax: latest.json e' dell'anno ${year}, il calendario e' ${calendarYear}`);
  }
  const paths = [
    path.join(root, 'data', 'canton-tax', `${year}.json`),
    path.join(root, 'public', 'data', 'canton-tax', `${year}.json`),
    latestPath,
  ];
  const snapshots = paths.map(readJson);
  for (let i = 0; i < snapshots.length; i++) {
    assertCantonTaxDataset(snapshots[i], { expectedYear: year });
    if (i > 0) assert.deepStrictEqual(snapshots[i], snapshots[0], `canton-tax: ${paths[i]} diverge da ${paths[0]}`);
  }
  return { year, paths };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { year, paths } = validateCantonTaxData();
    console.log(`✅ canton-tax ${year}: ${paths.length} mirror validi e identici`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
