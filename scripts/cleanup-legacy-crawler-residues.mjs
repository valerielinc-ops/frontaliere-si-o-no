#!/usr/bin/env node
/**
 * Remove known crawler-scratch archives that were emitted before the shared
 * slice predicate became fail-closed.
 *
 * This is deliberately an allowlist, not a generic "unknown archive" purge:
 * expired slices carry indexed route history and must never be deleted merely
 * because their crawler key is unfamiliar. The command is dry-run by default;
 * the scheduled housekeeping workflow opts into the explicit --apply mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeHousekeepingProofFile } from './lib/crawler-slice-integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXPIRED_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'expired', 'by-crawler');

export const LEGACY_SCRATCH_ARCHIVES = Object.freeze([
  Object.freeze({
    file: 'coop-ticino-locale-cache.json',
    companyKey: 'coop-ticino',
  }),
]);

function readValidatedArchive(filePath, expectedCompanyKey) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (error) {
    throw new Error(`legacy scratch archive ${filePath} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(entries)) {
    throw new Error(`legacy scratch archive ${filePath} is not a JSON array`);
  }
  const unexpected = entries.findIndex((entry) => entry?.companyKey !== expectedCompanyKey);
  if (unexpected !== -1) {
    throw new Error(
      `legacy scratch archive ${filePath} contains a non-${expectedCompanyKey} entry at index ${unexpected}`,
    );
  }
  return { raw, entries };
}

/**
 * Purge only the explicitly retired scratch archives.
 *
 * @param {{expiredDir?: string, apply?: boolean, proofDir?: string, env?: NodeJS.ProcessEnv, cwd?: string, baseSha?: string}} [options]
 * @returns {{filesScanned: number, filesAbsent: number, filesRemoved: string[], wouldRemove: string[]}}
 */
export function purgeLegacyCrawlerResidues({
  expiredDir = DEFAULT_EXPIRED_DIR,
  apply = false,
  proofDir,
  env = process.env,
  cwd = process.cwd(),
  baseSha = '',
} = {}) {
  const filesRemoved = [];
  const wouldRemove = [];
  let filesScanned = 0;
  let filesAbsent = 0;

  for (const { file, companyKey } of LEGACY_SCRATCH_ARCHIVES) {
    const filePath = path.join(expiredDir, file);
    if (!fs.existsSync(filePath)) {
      filesAbsent += 1;
      continue;
    }
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`legacy scratch archive ${filePath} is not a regular file`);
    }
    const { raw, entries } = readValidatedArchive(filePath, companyKey);
    filesScanned += 1;
    if (!apply) {
      wouldRemove.push(filePath);
      continue;
    }
    const slicePath = `data/jobs/expired/by-crawler/${file}`;
    const candidateRaw = '[]\n';
    const proofWritten = writeHousekeepingProofFile(slicePath, [{
      operation: 'retired-scratch-archive-delete',
      companyKey,
      entryCount: entries.length,
    }], {
      baseRaw: raw,
      candidateRaw,
      proofDir,
      env,
      cwd,
      baseSha,
    });
    if (!proofWritten) {
      throw new Error(`could not write housekeeping proof for ${slicePath}`);
    }
    fs.rmSync(filePath);
    filesRemoved.push(filePath);
    console.log(`Removed legacy crawler scratch archive ${filePath} (${entries.length} entries)`);
  }

  return { filesScanned, filesAbsent, filesRemoved, wouldRemove };
}

function main() {
  const apply = process.argv.includes('--apply');
  const report = purgeLegacyCrawlerResidues({ apply });
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...report }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
