#!/usr/bin/env node
/**
 * Run only tests related to the current PR diff.
 *
 * Vitest's `related` command rebuilds an in-memory Vite graph for every CI
 * run and inspects every discovered spec. In this repository that discovery
 * costs minutes while the selected tests take seconds. This runner keeps a
 * small static import graph on disk, updates only changed files, walks it in
 * reverse from changed sources, and passes the resulting test files directly
 * to Vitest. It stays related-only for ordinary imports, with a conservative
 * full-test fallback only when the changed-path collector cannot prove a
 * complete diff. Runtime/configuration files are deliberately not treated as
 * global Vitest dependencies: changing CI or TypeScript configuration must
 * not expand an application test diff into the complete suite.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { listCorpusWideTests } from './corpus-wide-tests.mjs';
import { shouldSkipFullSuiteFallback } from './lib/orphan-fallback.mjs';
import { selectMaxWorkers } from './lib/select-max-workers.mjs';

const changedPathFile = process.env.CHANGED_PATHS_FILE || 'changed-paths.txt';
const changedStatusFile = process.env.CHANGED_PATHS_STATUS_FILE || 'changed-paths-status.txt';
const graphFile = process.env.VITEST_RELATED_GRAPH || '.cache/vitest-related/graph.json';
const sourceRe = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const testRe = /^(?:tests|packages\/[^/]+\/tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;
// firestore-rules-consent-write needs a running Firestore emulator (Java 21+,
// wired via `npm run test:firestore-rules`) — plain `vitest run` fails fast
// with ECONNREFUSED, so it stays out of the blocking related-tests gate (#6377).
const alwaysExcludedTests = new Set(['tests/checkout-sparse-profiles.test.ts', 'tests/firestore-rules-consent-write.test.ts']);
const ignoredRe = /^(?:data|public|reports|docs|_newsletter_variants|node_modules)\//;
const projectRe = /^(?:tests|scripts\/(?:ci|lib|dev|evals)\/|services|components|hooks|server|infra|build-plugins|functions|packages\/[^/]+\/(?:engine|src|tests)\/)/;
const skipCorpusWide = process.env.VITEST_SKIP_CORPUS_WIDE === 'true';
const corpusWideTests = skipCorpusWide ? new Set(listCorpusWideTests()) : new Set();
// These dependencies are wired by Vitest/configuration or executed through a
// path string, so no static import edge can reliably reach their consumers.
const importRe = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+|import\s*\(|require\s*\()(['"])([^'"]+)\1/g;
const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

const normalize = (file) => file.replaceAll('\\', '/').replace(/^\.\//, '');
const changed = readFileSync(changedPathFile, 'utf8').split(/\r?\n/).map((p) => normalize(p.trim())).filter(Boolean);
let changedStatus = 'complete';
try { changedStatus = readFileSync(changedStatusFile, 'utf8').trim() || 'error'; } catch {}

function stripComments(source) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i++;
    } else {
      out += char;
    }
  }
  return out;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).map(normalize)
    .filter((file) => !file.startsWith('.github/') && !ignoredRe.test(file) && sourceRe.test(file)
      && (!file.includes('/') || projectRe.test(file) || /^scripts\/[^/]+$/.test(file)
        || /^packages\/[^/]+\/[^/]+$/.test(file)));
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

// Tracked files this process could not read while building the graph. Empty on
// a full checkout; see importsOf() for the only case that fills it.
const unreadable = [];

function importsOf(file, fileSet) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // A file that git tracks but the working tree cannot open. In a SPARSE
    // worktree this is routine and not a broken repository: `services/` is
    // checked out, but `services/blogArticleIds.ts` is a symlink into
    // `packages/articles/content/`, which the sparse profile excludes — the
    // link resolves to nothing, so `ls` shows it and `readFileSync` throws.
    //
    // Crashing here made this runner unusable outside CI, which is exactly
    // where an agent needs it: without it the only pre-PR option is the full
    // suite, which in a sparse worktree is 156 inherited reds and no verdict.
    // The file is dropped from the graph, never silently: the count is
    // reported below so an under-selection is visible instead of assumed.
    unreadable.push(file);
    return [];
  }
  const deps = new Set();
  for (const match of stripComments(source).matchAll(importRe)) {
    const dep = resolveImport(file, match[2], fileSet);
    if (dep) deps.add(dep);
  }
  return [...deps].sort();
}

function loadGraph(files) {
  let previous = {};
  let previousVersion = 0;
  try {
    const cached = JSON.parse(readFileSync(graphFile, 'utf8'));
    previous = cached.files || {};
    previousVersion = cached.version || 0;
  } catch {}
  const fileSet = new Set(files);
  // Keep old entries for deleted files: a deleted module can still be a
  // changed root, and its cached reverse edges identify the tests that used
  // to import it. Stale entries are harmless because only existing tests are
  // passed to Vitest below.
  const graph = { ...previous };
  for (const file of files) {
    const sig = signature(file);
    const old = previous[file];
    graph[file] = previousVersion === 5 && old?.signature === sig
      ? old
      : { signature: sig, deps: importsOf(file, fileSet) };
  }
  mkdirSync(path.dirname(graphFile), { recursive: true });
  writeFileSync(graphFile, JSON.stringify({ version: 5, files: graph }));
  return graph;
}

const candidates = [...new Set(changed.filter((file) =>
  file !== 'scripts/ci/run-related-tests.mjs' && !ignoredRe.test(file)
    && sourceRe.test(file) && !alwaysExcludedTests.has(file)))];
const forceFull = changedStatus !== 'complete';
if (candidates.length === 0 && !forceFull) {
  console.log('No existing source/test files in the diff → related-only run has no tests.');
  process.exit(0);
}

const tracked = trackedFiles();
const graph = loadGraph(tracked);
if (unreadable.length > 0) {
  // Loud, and above the selection, because it is the one thing that can make
  // the list below shorter than it should be. Zero on a full checkout.
  console.log(`⚠️ ${unreadable.length} tracked file(s) unreadable in this working tree (sparse checkout?) — dropped from the import graph, so the selection may be incomplete:`);
  for (const file of unreadable.slice(0, 10)) console.log(`   ${file}`);
  if (unreadable.length > 10) console.log(`   … and ${unreadable.length - 10} more`);
}
const isRunnableTest = (file) => testRe.test(file) && !corpusWideTests.has(file) && !alwaysExcludedTests.has(file);
const allTests = tracked.filter(isRunnableTest);
const reverse = new Map();
for (const [file, entry] of Object.entries(graph)) {
  for (const dep of entry.deps) {
    if (!reverse.has(dep)) reverse.set(dep, []);
    reverse.get(dep).push(file);
  }
}
const related = new Set(forceFull ? allTests : candidates.filter(isRunnableTest));
if (forceFull) {
  console.log(`Changed-paths status is ${changedStatus} → running all tracked tests conservatively.`);
}
let usedFullFallback = forceFull;
const queue = [...candidates];
const visited = new Set();
while (queue.length) {
  const file = queue.shift();
  if (visited.has(file)) continue;
  visited.add(file);
  for (const importer of reverse.get(file) || []) {
    if (!related.has(importer) && isRunnableTest(importer)) related.add(importer);
    if (!queue.includes(importer)) queue.push(importer);
  }
}
// Never report success with zero tests for a source change: an unmodelled
// dependency is safer as a full run than as a silent no-op — UNLESS every
// changed file is a genuine leaf (zero importers anywhere in the repo, not
// just no test importer), in which case nothing could ever reach it through
// an import and the full run protects nothing (see lib/orphan-fallback.mjs).
if (related.size === 0 && candidates.length > 0) {
  if (shouldSkipFullSuiteFallback(candidates, reverse)) {
    console.log('No static related edge found, and every changed file has zero importers anywhere in the repo (standalone CLI script) → nothing to run, as expected.');
  } else {
    for (const test of allTests) related.add(test);
    usedFullFallback = true;
    console.log('No static related edge found → running all tracked tests conservatively.');
  }
}
const tests = [...related].filter((file) => existsSync(file)).sort();
console.log(`Running Vitest related to ${candidates.length} changed source/test file(s): ${tests.length} test file(s)`);
console.log(tests.join('\n'));
if (tests.length === 0) process.exit(0);

const args = ['node_modules/vitest/vitest.mjs', 'run', '--passWithNoTests'];
const maxWorkers = selectMaxWorkers({
  usedFullFallback,
  maxWorkers: process.env.VITEST_MAX_WORKERS,
  maxWorkersFallback: process.env.VITEST_MAX_WORKERS_FALLBACK,
});
if (maxWorkers) args.push(`--maxWorkers=${maxWorkers}`);
if (process.env.VITEST_POOL) args.push(`--pool=${process.env.VITEST_POOL}`);
args.push(...tests, ...process.argv.slice(2));
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) {
  console.error(`Unable to start Vitest related run: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
