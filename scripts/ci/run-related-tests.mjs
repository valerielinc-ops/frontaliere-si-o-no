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
// Workflow e artefatti portabili sotto `.github/`. Non sono sorgenti e non
// hanno nessun edge di import, ma i test che ne congelano il contenuto li
// aprono per path LETTERALE (`fs.readFileSync('.github/…')`,
// `git show origin/main:.github/…`). Senza questo indice un diff di soli
// workflow non seleziona NIENTE: e' la strada da cui #7355 ha spezzato
// l'adiacenza della terna shadow in
// `.github/corpus-workflows/translate-pending.yml` senza far girare
// `tests/crawler-generation-dispatch-workflow.test.ts`, e siccome `tests.yml`
// gira solo su `pull_request` il rosso e' rimasto invisibile su `main`
// finche' non l'ha ereditato una PR estranea (#7514, #7580).
const githubAssetRe = /^\.github\/.+\.(?:ya?ml|json)$/i;
const githubLiteralRe = /\.github\/[A-Za-z0-9._-][A-Za-z0-9._/-]*/g;
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

function trackedGithubAssets() {
  return execFileSync('git', ['ls-files', '-z', '--', '.github'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).map(normalize).filter((file) => githubAssetRe.test(file));
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

function importsOf(file, fileSet, githubAssets) {
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
  const code = stripComments(source);
  for (const match of code.matchAll(importRe)) {
    const dep = resolveImport(file, match[2], fileSet);
    if (dep) deps.add(dep);
  }
  // Il letterale vale come dipendenza quando nomina il file (`'.github/x.yml'`)
  // o la directory che lo contiene (`'.github/workflows'`, usato dai test che
  // scandiscono l'intera cartella). Solo dentro il CODICE: un path citato in un
  // commento non e' una dipendenza. Niente prefissi parziali — un template
  // letterale come `` `.github/…/crawler-group-${g}.yml` `` non produce arco, e
  // non serve: quei file non cambiano mai senza `contract.json`, che ne porta
  // gli sha256 ed e' nominato per esteso.
  for (const [rawLiteral] of code.matchAll(githubLiteralRe)) {
    // La barra finale va tolta: un riferimento costruito per template —
    // `` `.github/workflows/${name}` `` o `'.github/corpus-workflows/' + file` —
    // lascia il letterale con lo slash, e senza normalizzazione il confronto
    // diventa `startsWith('.github/workflows//')`, che non matcha niente. Il
    // caso che funzionava era solo quello senza template.
    const literal = rawLiteral.replace(/\/+$/, '');
    for (const asset of githubAssets) {
      if (asset === literal || asset.startsWith(`${literal}/`)) deps.add(asset);
    }
  }
  return [...deps].sort();
}

function loadGraph(files, githubAssets) {
  let previous = {};
  let previousVersion = 0;
  let previousAssets = null;
  // Gli archi verso gli asset `.github/**` vivono nella entry del file
  // SORGENTE che li nomina, e la validità di quella entry dipendeva solo dalla
  // firma del sorgente. Un workflow AGGIUNTO (o rinominato) non cambia la
  // firma di chi lo nomina per directory — `'.github/workflows'`, il caso
  // reale di scripts/generate-crawler-group-workflows.mjs — quindi la entry
  // vecchia veniva riusata senza l'arco verso il file nuovo. La cache
  // sopravvive fra le run (tests.yml la salva e la ripristina, con
  // restore-keys di prefisso), quindi da lì in poi una PR che tocca SOLO quel
  // workflow tornava a selezionare zero test: il blind spot di #7355/#7514
  // riaperto per ogni workflow nato dopo l'ultima invalidazione. Il bump di
  // `version` lo copriva una volta sola. Ora l'insieme degli asset entra nella
  // chiave di validità: se cambia, il grafo si ricalcola.
  const assetsDigest = createHash('sha1').update(githubAssets.join('\n')).digest('hex');
  try {
    const cached = JSON.parse(readFileSync(graphFile, 'utf8'));
    previous = cached.files || {};
    previousVersion = cached.version || 0;
    previousAssets = cached.assets || null;
  } catch {}
  const reusable = previousVersion === 6 && previousAssets === assetsDigest;
  const fileSet = new Set(files);
  // Keep old entries for deleted files: a deleted module can still be a
  // changed root, and its cached reverse edges identify the tests that used
  // to import it. Stale entries are harmless because only existing tests are
  // passed to Vitest below.
  const graph = { ...previous };
  for (const file of files) {
    const sig = signature(file);
    const old = previous[file];
    graph[file] = reusable && old?.signature === sig
      ? old
      : { signature: sig, deps: importsOf(file, fileSet, githubAssets) };
  }
  mkdirSync(path.dirname(graphFile), { recursive: true });
  writeFileSync(graphFile, JSON.stringify({ version: 6, assets: assetsDigest, files: graph }));
  return graph;
}

const candidates = [...new Set(changed.filter((file) =>
  file !== 'scripts/ci/run-related-tests.mjs' && !ignoredRe.test(file)
    && (sourceRe.test(file) || githubAssetRe.test(file)) && !alwaysExcludedTests.has(file)))];
const forceFull = changedStatus !== 'complete';
if (candidates.length === 0 && !forceFull) {
  console.log('No existing source/test files in the diff → related-only run has no tests.');
  process.exit(0);
}

const tracked = trackedFiles();
const graph = loadGraph(tracked, trackedGithubAssets());
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
// Il fallback si decide sui soli candidati SORGENTE. Un asset `.github/**` che
// nessun test nomina non ha blind spot da coprire — non e' importabile, quindi
// non esiste l'import mancato che il fallback esiste per proteggere — e farlo
// ricadere sulla suite intera farebbe pagare ~1900 file a ogni PR di soli
// workflow, che oggi ne paga zero. La politica related-only di `tests.yml`
// resta invariata.
const sourceCandidates = candidates.filter((file) => sourceRe.test(file));
if (related.size === 0 && sourceCandidates.length > 0) {
  if (shouldSkipFullSuiteFallback(sourceCandidates, reverse)) {
    console.log('No static related edge found, and every changed file has zero importers anywhere in the repo (standalone CLI script) → nothing to run, as expected.');
  } else {
    for (const test of allTests) related.add(test);
    usedFullFallback = true;
    console.log('No static related edge found → running all tracked tests conservatively.');
  }
}
const tests = [...related].filter((file) => existsSync(file)).sort();
const githubCandidateCount = candidates.length - sourceCandidates.length;
console.log(`Running Vitest related to ${sourceCandidates.length} changed source/test file(s)`
  + (githubCandidateCount ? ` + ${githubCandidateCount} .github asset(s)` : '')
  + `: ${tests.length} test file(s)`);
console.log(tests.join('\n'));
if (tests.length === 0) process.exit(0);
// Seam per ispezionare la SELEZIONE senza pagare la corsa: stampa l'elenco qui
// sopra ed esce. Usato da tests/run-related-tests-github-assets.test.ts e utile
// a mano per capire perche' un file seleziona (o non seleziona) un test.
//
// Disarmato sotto GitHub Actions, e di proposito: se questa variabile
// trapelasse nell'env del job bloccante, il gate uscirebbe 0 senza eseguire un
// solo test — un verde indistinguibile da una selezione vuota legittima. Il
// seam serve in locale e nel sottoprocesso dell'osservatore, mai nel gate.
if (process.env.VITEST_RELATED_DRY_RUN === 'true' && !process.env.GITHUB_ACTIONS) {
  process.exit(0);
}

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
