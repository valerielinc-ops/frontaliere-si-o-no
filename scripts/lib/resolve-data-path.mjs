/**
 * resolve-data-path.mjs — Shared dataset path resolver for validators.
 *
 * Validators run in three different contexts that expose dataset files at
 * different prefixes. The same script must work in all three without each
 * caller hand-coding a fallback chain:
 *
 *   1. Local dev / pre-push hook / `npm run build:ci`
 *      → source-of-truth at `<repo>/data/<file>` (some are gitignored,
 *        e.g. `data/jobs.json`, and assembled at runtime by
 *        `scripts/assemble-jobs-dataset.mjs`).
 *   2. CI deploy.yml `build:ci` step
 *      → same as above; the assemble step runs first.
 *   3. CI post-deploy-validation.yml
 *      → only the GitHub Pages artifact is restored. The dataset lives at
 *        `<repo>/dist/data/<file>` (and the workflow copies it to
 *        `<repo>/public/data/<file>` for compatibility — see
 *        post-deploy-validation.yml line ~218). `data/<file>` does NOT exist.
 *
 * Falling through these in priority order keeps a single validator working
 * in all three environments. If none exists, `requireDataPath` exits with
 * code 2 (distinct from code 1 = real validation regression) and prints a
 * CI-friendly error that names every tried path plus the recovery action.
 *
 * Usage:
 *   import { requireDataPath, resolveDataPath } from '../lib/resolve-data-path.mjs';
 *
 *   // Soft: returns the resolved absolute path or null.
 *   const p = resolveDataPath('jobs.json');
 *   if (!p) { ...handle missing... }
 *
 *   // Hard: exits 2 on miss with a CI-friendly error message.
 *   const p = requireDataPath('jobs.json', 'validate-jobs-quality');
 *
 * Both functions accept an optional explicit candidate list; the default is
 * `data/<file>`, `dist/data/<file>`, `public/data/<file>` (priority order).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/resolve-data-path.mjs → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Build the default candidate list for a given filename. Order matters:
 * source-of-truth first (local dev / build), then dist/ (post-deploy
 * artifact), then public/ (workflow compat copy).
 *
 * @param {string} filename — basename like `jobs.json` or
 *   `previous-slug-winners.json`. Must NOT include a directory prefix.
 * @returns {string[]} absolute candidate paths in priority order.
 */
export function defaultCandidates(filename) {
  return [
    path.resolve(REPO_ROOT, 'data', filename),
    path.resolve(REPO_ROOT, 'dist', 'data', filename),
    path.resolve(REPO_ROOT, 'public', 'data', filename),
  ];
}

/**
 * Resolve a dataset filename to an absolute path by walking a candidate
 * list and returning the first one that exists.
 *
 * @param {string} filename — basename of the dataset (e.g. `jobs.json`).
 * @param {string[]} [candidates] — optional override of the default
 *   priority list. Each entry must be an absolute path.
 * @returns {string|null} absolute path of the first existing candidate,
 *   or null if none exists.
 */
export function resolveDataPath(filename, candidates = defaultCandidates(filename)) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Same as `resolveDataPath`, but on miss prints a CI-friendly error
 * message that lists every tried path + recovery hint, then exits with
 * code 2. Code 2 distinguishes "infra missing" (no dataset reachable —
 * sequencing/checkout problem) from code 1 (real validation regression
 * the script would emit on a present-but-bad dataset).
 *
 * @param {string} filename — basename of the dataset.
 * @param {string} ctx — short caller name used in the error header
 *   (e.g. `validate-jobs-quality`). Surfaces in the GH Actions log so
 *   the failing validator is identifiable at a glance.
 * @param {string[]} [candidates] — optional candidate override.
 * @returns {string} absolute path to the resolved dataset (never returns
 *   on miss — `process.exit(2)` is invoked).
 */
export function requireDataPath(filename, ctx, candidates = defaultCandidates(filename)) {
  const resolved = resolveDataPath(filename, candidates);
  if (resolved) return resolved;

  const label = ctx || 'validator';
  console.error(`❌ ${label}: no dataset '${filename}' found.`);
  console.error('   Tried (in priority order):');
  for (const candidate of candidates) {
    console.error(`     - ${candidate}`);
  }
  console.error('   This is an infra/sequencing problem (missing input file),');
  console.error('   not a data-quality regression. In local/pre-push, run');
  console.error(`   \`node scripts/assemble-jobs-dataset.mjs --stats\` first if`);
  console.error(`   the file is part of the jobs dataset. In post-deploy-validation,`);
  console.error('   ensure the GitHub Pages artifact was downloaded and expanded');
  console.error('   into dist/ before this step.');
  process.exit(2);
}

/**
 * Repo root absolute path. Exported so callers can derive related paths
 * without re-resolving via fileURLToPath.
 */
export const ROOT = REPO_ROOT;
