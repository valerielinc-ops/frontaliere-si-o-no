#!/usr/bin/env node
/**
 * Valida i mirror dei parametri previdenziali dopo il producer
 * (`fetch-pension-parameters.mjs`), prima del commit del workflow.
 *
 * Fallisce chiuso: file assenti o malformati, soglie non rispettate (vedi
 * `assertPensionParametersDataset`), mirror divergenti, e — dal 1° febbraio —
 * anno corrente non coperto dalle fonti. Quest'ultimo controllo vive QUI e non
 * nella suite vitest: e' un allarme sul publisher (il workflow mensile apre
 * una issue), non una bomba a orologeria che blocchi ogni PR del repo.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPensionParametersDataset } from './fetch-pension-parameters.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`pension-parameters: file mancante ${filePath} (${err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`pension-parameters: JSON non valido ${filePath} (${err.message})`);
  }
}

export function validatePensionParameters({ root = ROOT, now = new Date() } = {}) {
  const latestPath = path.join(root, 'data', 'pension-parameters', 'latest.json');
  const latest = readJson(latestPath);
  const year = latest.year;
  const paths = [
    path.join(root, 'data', 'pension-parameters', `${year}.json`),
    latestPath,
    path.join(root, 'public', 'data', 'pension-parameters', `${year}.json`),
    path.join(root, 'public', 'data', 'pension-parameters', 'latest.json'),
  ];
  const snapshots = paths.map(readJson);
  assertPensionParametersDataset(snapshots[0], { now });
  for (let i = 1; i < snapshots.length; i++) {
    assert.deepStrictEqual(snapshots[i], snapshots[0], `pension-parameters: ${paths[i]} diverge da ${paths[0]}`);
  }
  return { year, paths };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { year, paths } = validatePensionParameters();
    console.log(`✅ pension-parameters ${year}: ${paths.length} mirror validi e identici`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
