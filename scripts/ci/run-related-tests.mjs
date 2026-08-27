#!/usr/bin/env node
/**
 * Run only the Vitest tests related to the current PR diff.
 *
 * `vitest related` follows static imports, while changed test files are passed
 * directly because they are the test subjects rather than dependencies. Data,
 * generated output, docs, and deleted files are intentionally not candidates:
 * they cannot provide a useful import-graph root. An empty candidate set is a
 * valid no-test result; this CI path is deliberately related-only and never
 * falls back to the full suite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const changedPathFile = process.env.CHANGED_PATHS_FILE || 'changed-paths.txt';
const changed = readFileSync(changedPathFile, 'utf8')
  .split(/\r?\n/)
  .map((path) => path.trim().replace(/^\.\//, ''))
  .filter(Boolean);

const TEST_RE = /^(?:tests|packages\/[^/]+\/tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const SOURCE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const NON_SOURCE_RE = /^(?:data|public|reports|docs|_newsletter_variants|node_modules)\//;

const candidates = [...new Set(changed.filter((path) => {
  if (NON_SOURCE_RE.test(path) || !existsSync(path)) return false;
  return TEST_RE.test(path) || SOURCE_RE.test(path);
}))];
const maxWorkers = process.env.VITEST_MAX_WORKERS;

if (candidates.length === 0) {
  console.log('No existing source/test files in the diff → related-only run has no tests.');
  process.exit(0);
}

console.log(`Running Vitest related to ${candidates.length} changed source/test file(s):`);
console.log(candidates.join('\n'));

const result = spawnSync(process.execPath, [
  'node_modules/vitest/vitest.mjs',
  'related',
  '--run',
  '--passWithNoTests',
  ...(maxWorkers ? [`--maxWorkers=${maxWorkers}`] : []),
  ...candidates,
  ...process.argv.slice(2),
], { stdio: 'inherit' });

if (result.error) {
  console.error(`Unable to start Vitest related: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
