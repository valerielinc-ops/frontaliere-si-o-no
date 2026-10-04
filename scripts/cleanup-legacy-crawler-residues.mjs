#!/usr/bin/env node
/**
 * Remove known crawler-scratch archives that were emitted before the shared
 * slice predicate became fail-closed.
 *
 * This is deliberately an allowlist, not a generic "unknown archive" purge:
 * expired slices carry indexed route history and must never be deleted merely
 * because their crawler key is unfamiliar. The command is dry-run by default;
 * the scheduled housekeeping workflow opts into the explicit --apply mode.
 *
 * Two kinds of residue are allowlisted:
 *   - LEGACY_SCRATCH_ARCHIVES: expired-side archives that still carry entries.
 *     Their deletion is a catastrophic shrink and needs a housekeeping proof.
 *   - LEGACY_SCRATCH_SENTINELS: active-side scratch files whose writer has been
 *     retired (the Coop translation cache, removed by PR 11295). They are
 *     deleted only while they hold an empty JSON array; any other content means
 *     an unexpected writer is back, so the file is kept and reported instead.
 *
 * LEGACY_CRAWLER_RESIDUE_PATHS lists every repository path this script may
 * delete: the workflow commit step (git-commit-data.sh --extra-only) must name
 * exactly these paths, or a deletion stays on the runner and never reaches main.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeHousekeepingProofFile } from './lib/crawler-slice-integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXPIRED_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'expired', 'by-crawler');
const DEFAULT_ACTIVE_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');

export const LEGACY_SCRATCH_ARCHIVES = Object.freeze([
  Object.freeze({
    file: 'coop-ticino-locale-cache.json',
    companyKey: 'coop-ticino',
  }),
]);

export const LEGACY_SCRATCH_SENTINELS = Object.freeze([
  Object.freeze({
    file: 'coop-ticino-locale-cache.json',
  }),
]);

export const LEGACY_CRAWLER_RESIDUE_PATHS = Object.freeze([
  ...LEGACY_SCRATCH_ARCHIVES.map(({ file }) => `data/jobs/expired/by-crawler/${file}`),
  ...LEGACY_SCRATCH_SENTINELS.map(({ file }) => `data/jobs/by-crawler/${file}`),
]);

function isEmptyArraySentinel(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

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
 * Purge only the explicitly retired scratch archives and sentinels.
 *
 * `activeDir` defaults to the repository's data/jobs/by-crawler only when
 * `expiredDir` is also the default: a caller that redirects the archive
 * directory (a test fixture) never reaches the real tracked sentinel.
 *
 * @param {{expiredDir?: string, activeDir?: string | null, apply?: boolean, proofDir?: string, env?: NodeJS.ProcessEnv, cwd?: string, baseSha?: string}} [options]
 * @returns {{filesScanned: number, filesAbsent: number, filesRemoved: string[], wouldRemove: string[], filesKept: string[]}}
 */
export function purgeLegacyCrawlerResidues({
  expiredDir = DEFAULT_EXPIRED_DIR,
  activeDir = expiredDir === DEFAULT_EXPIRED_DIR ? DEFAULT_ACTIVE_DIR : null,
  apply = false,
  proofDir,
  env = process.env,
  cwd = process.cwd(),
  baseSha = '',
} = {}) {
  const filesRemoved = [];
  const wouldRemove = [];
  const filesKept = [];
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

  for (const { file } of activeDir ? LEGACY_SCRATCH_SENTINELS : []) {
    const filePath = path.join(activeDir, file);
    if (!fs.existsSync(filePath)) {
      filesAbsent += 1;
      continue;
    }
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`legacy scratch sentinel ${filePath} is not a regular file`);
    }
    filesScanned += 1;
    // A sentinel below the accumulator floor needs no housekeeping proof; the
    // commit step's integrity guard accepts the deletion of a 3-byte `[]`.
    if (!isEmptyArraySentinel(fs.readFileSync(filePath, 'utf8'))) {
      filesKept.push(filePath);
      console.warn(
        `::warning::Kept legacy crawler scratch sentinel ${filePath}: it is no longer an empty JSON array, `
        + 'so its retired writer may be back (issue 9142)',
      );
      continue;
    }
    if (!apply) {
      wouldRemove.push(filePath);
      continue;
    }
    fs.rmSync(filePath);
    filesRemoved.push(filePath);
    console.log(`Removed legacy crawler scratch sentinel ${filePath}`);
  }

  return { filesScanned, filesAbsent, filesRemoved, wouldRemove, filesKept };
}

function main() {
  const apply = process.argv.includes('--apply');
  const report = purgeLegacyCrawlerResidues({ apply });
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...report }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
