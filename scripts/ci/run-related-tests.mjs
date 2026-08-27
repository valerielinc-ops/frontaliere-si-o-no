#!/usr/bin/env node
/**
 * Run only tests related to the current PR diff.
 *
 * Vitest's `related` command rebuilds an in-memory Vite graph for every CI
 * run and inspects every discovered spec. In this repository that discovery
 * costs minutes while the selected tests take seconds. This runner keeps a
 * small static import graph on disk, updates only changed files, walks it in
 * reverse from changed sources, and passes the resulting test files directly
 * to Vitest. It is deliberately related-only and never falls back to the
 * full suite.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const changedPathFile = process.env.CHANGED_PATHS_FILE || 'changed-paths.txt';
const graphFile = process.env.VITEST_RELATED_GRAPH || '.cache/vitest-related/graph.json';
const sourceRe = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const testRe = /^(?:tests|packages\/[^/]+\/tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const ignoredRe = /^(?:data|public|reports|docs|_newsletter_variants|node_modules)\//;
const projectRe = /^(?:tests|scripts|services|components|hooks|server|infra|build-plugins|functions\/src|packages)\//;
const importRe = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+|import\s*\(|require\s*\()(['"])([^'"]+)\1/g;
const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

const normalize = (file) => file.replaceAll('\\', '/').replace(/^\.\//, '');
const changed = readFileSync(changedPathFile, 'utf8').split(/\r?\n/).map((p) => normalize(p.trim())).filter(Boolean);

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).map(normalize)
    .filter((file) => projectRe.test(file) && !ignoredRe.test(file) && sourceRe.test(file));
}

function signature(file) {
  try { return createHash('sha1').update(readFileSync(file)).digest('hex'); } catch { return null; }
}

function resolveImport(from, specifier, fileSet) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? path.resolve('.', specifier.slice(2))
    : path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, ...extensions.map((ext) => `${base}${ext}`), ...extensions.map((ext) => path.join(base, `index${ext}`))]) {
    const relative = normalize(path.relative('.', candidate));
    if (fileSet.has(relative)) return relative;
  }
  return null;
}

function importsOf(file, fileSet) {
  const deps = new Set();
  for (const match of readFileSync(file, 'utf8').matchAll(importRe)) {
    const dep = resolveImport(file, match[2], fileSet);
    if (dep) deps.add(dep);
  }
  return [...deps].sort();
}

function loadGraph(files) {
  let previous = {};
  try { previous = JSON.parse(readFileSync(graphFile, 'utf8')).files || {}; } catch {}
  const fileSet = new Set(files);
  const graph = {};
  for (const file of files) {
    const sig = signature(file);
    const old = previous[file];
    graph[file] = old?.signature === sig ? old : { signature: sig, deps: importsOf(file, fileSet) };
  }
  mkdirSync(path.dirname(graphFile), { recursive: true });
  writeFileSync(graphFile, JSON.stringify({ version: 1, files: graph }));
  return graph;
}

const candidates = [...new Set(changed.filter((file) =>
  file !== 'scripts/ci/run-related-tests.mjs' && !ignoredRe.test(file) && sourceRe.test(file) && existsSync(file)))];
if (candidates.length === 0) {
  console.log('No existing source/test files in the diff → related-only run has no tests.');
  process.exit(0);
}

const graph = loadGraph(trackedFiles());
const reverse = new Map();
for (const [file, entry] of Object.entries(graph)) {
  for (const dep of entry.deps) {
    if (!reverse.has(dep)) reverse.set(dep, []);
    reverse.get(dep).push(file);
  }
}
const related = new Set(candidates.filter((file) => testRe.test(file)));
const queue = [...candidates];
while (queue.length) {
  const file = queue.shift();
  for (const importer of reverse.get(file) || []) {
    if (!related.has(importer) && testRe.test(importer)) related.add(importer);
    if (!queue.includes(importer)) queue.push(importer);
  }
}
const tests = [...related].filter((file) => existsSync(file)).sort();
console.log(`Running Vitest related to ${candidates.length} changed source/test file(s): ${tests.length} test file(s)`);
console.log(tests.join('\n'));
if (tests.length === 0) process.exit(0);

const args = ['node_modules/vitest/vitest.mjs', 'run', '--passWithNoTests'];
if (process.env.VITEST_MAX_WORKERS) args.push(`--maxWorkers=${process.env.VITEST_MAX_WORKERS}`);
if (process.env.VITEST_POOL) args.push(`--pool=${process.env.VITEST_POOL}`);
args.push(...tests, ...process.argv.slice(2));
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) {
  console.error(`Unable to start Vitest related run: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
