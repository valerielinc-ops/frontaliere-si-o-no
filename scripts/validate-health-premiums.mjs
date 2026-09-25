#!/usr/bin/env node
/**
 * Validate the four health-premiums mirrors after the canonical producer ran.
 *
 * The updater must fail closed if the producer wrote an empty, malformed, or
 * divergent snapshot. This script only reads files; it never repairs or
 * invents premium values.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertHealthPremiumsSnapshot } from './fetch-health-premiums.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_YEAR = new Date().getUTCFullYear();

const SNAPSHOT_PATHS = [
  path.join(ROOT, 'data', 'health-premiums', `${CURRENT_YEAR}.json`),
  path.join(ROOT, 'public', 'data', 'health-premiums', `${CURRENT_YEAR}.json`),
  path.join(ROOT, 'data', 'health-premiums.json'),
  path.join(ROOT, 'public', 'data', 'health-premiums.json'),
];

async function readSnapshot(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`health-premiums snapshot is missing: ${filePath} (${error.message})`);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (error) {
    throw new Error(`health-premiums snapshot is not valid JSON: ${filePath} (${error.message})`);
  }
  try {
    assertHealthPremiumsSnapshot(snapshot, { expectedYear: CURRENT_YEAR, requireLugano: true });
  } catch (error) {
    throw new Error(`${filePath}: ${error.message}`);
  }
  return snapshot;
}

export async function validateHealthPremiumsSnapshots() {
  const snapshots = await Promise.all(SNAPSHOT_PATHS.map(readSnapshot));
  for (let index = 1; index < snapshots.length; index++) {
    assert.deepStrictEqual(
      snapshots[index],
      snapshots[0],
      `health-premiums mirrors diverge: ${SNAPSHOT_PATHS[index]} differs from ${SNAPSHOT_PATHS[0]}`,
    );
  }
  return { year: CURRENT_YEAR, paths: SNAPSHOT_PATHS };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  validateHealthPremiumsSnapshots()
    .then(({ year, paths }) => {
      console.log(`✅ Health-premiums snapshot ${year} valid and identical across ${paths.length} mirrors.`);
    })
    .catch((error) => {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    });
}
