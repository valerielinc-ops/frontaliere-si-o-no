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
 * not expand an application test diff into the complete suite. `--select-only`
 * computes the same selection without invoking Vitest and emits the
 * pre-assembly dataset decision for tests.yml.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { listCorpusWideTests } from './corpus-wide-tests.mjs';
import { shouldAssembleForRelatedTests } from './dataset-dependent-tests.mjs';
import { shouldSkipFullSuiteFallback } from './lib/orphan-fallback.mjs';
import { selectMaxWorkers } from './lib/select-max-workers.mjs';
import { GRAPH_IGNORED_RE, GRAPH_SOURCE_RE, isGraphSourceFile } from './lib/related-graph-scope.mjs';

const changedPathFile = process.env.CHANGED_PATHS_FILE || 'changed-paths.txt';
const changedStatusFile = process.env.CHANGED_PATHS_STATUS_FILE || 'changed-paths-status.txt';
const graphFile = process.env.VITEST_RELATED_GRAPH || '.cache/vitest-related/graph.json';
const selectionOnly = process.argv.includes('--select-only');
const sourceRe = GRAPH_SOURCE_RE;
const testRe = /^(?:tests|packages\/[^/]+\/tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;
// faq-readability-gate misura il ratchet sulle FAQ dell'INTERO corpus articoli
// e si difende dal falso verde con `expect(total).toBeGreaterThan(1000)`. Il job
// PR non materializza `packages/articles/content`, quindi quel guard scatta
// sempre: misurato il 2026-09-06 sulla PR #7617, `expected 4 to be greater than
// 1000` — quattro campi FAQ visibili invece di 22.012. Non stava trovando un
// difetto, stava dicendo (come progettato) di non avere il dato; sul corpus vero
// passa, 23 illeggibili contro un RATCHET_BASELINE di 26.
// Stessa ragione del vicino qui sotto: un test che richiede un ambiente che
// QUESTO job non ha non e' un gate, e' un rosso fisso. Resta bloccante nella
// suite piena, che il corpus ce l'ha. Ci finiva dentro solo da quando un cambio
// a `blog-body-io.mjs` lo tira nel grafo related, cioe' su ogni PR che tocca
// quel modulo condiviso.
// firestore-rules-consent-write needs a running Firestore emulator (Java 21+,
// wired via `npm run test:firestore-rules`) — plain `vitest run` fails fast
// with ECONNREFUSED, so it stays out of the blocking related-tests gate (#6377).
const alwaysExcludedTests = new Set([
  'tests/checkout-sparse-profiles.test.ts',
  'tests/faq-readability-gate.test.ts',
  'tests/firestore-rules-consent-write.test.ts',
]);
const ignoredRe = GRAPH_IGNORED_RE;
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
const testFixtureRe = /^tests\/.+\.json$/i;
const assetLiteralRe = /(?:\.github|tests)\/[A-Za-z0-9._-][A-Za-z0-9._/-]*/g;
const skipCorpusWide = process.env.VITEST_SKIP_CORPUS_WIDE === 'true';
const corpusWideTests = skipCorpusWide ? new Set(listCorpusWideTests()) : new Set();
// A related-test verdict is only meaningful when the generated runtime data
// used by the selected tests is present. The CI checkout materializes these
// sentinels; a local sparse worktree does not. Keep `--select-only` and the
// local dry-run seam usable for inspecting the graph, but never let a real
// Vitest invocation turn missing artifacts into application regressions.
const REQUIRED_FULL_CHECKOUT_ARTIFACTS = Object.freeze([
  'data/blog-articles-data.ts',
  'data/swiss-articles-data.ts',
  'public/.nojekyll',
]);
function missingFullCheckoutArtifacts() {
  return REQUIRED_FULL_CHECKOUT_ARTIFACTS.filter((relative) => !existsSync(relative));
}
function requireFullCheckoutForVerdict() {
  const missing = missingFullCheckoutArtifacts();
  const localInspection = selectionOnly
    || (process.env.VITEST_RELATED_DRY_RUN === 'true' && process.env.GITHUB_ACTIONS !== 'true');
  if (missing.length === 0 || localInspection) return;
  console.error('BLOCKED: related-test verdict requires a full checkout; generated runtime artifacts are missing.');
  console.error(`  Artefacts mancanti: ${missing.join(', ')}`);
  console.error('  È un problema di ambiente, non di codice: esegui il comando in CI o da un checkout PIENO con data/ e public/ materializzati.');
  process.exit(2);
}
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
    .split('\0').filter(Boolean).map(normalize).filter(isGraphSourceFile);
}

function trackedAssets() {
  return execFileSync('git', ['ls-files', '-z', '--', '.github'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).map(normalize).filter((file) => githubAssetRe.test(file))
    .concat(
      execFileSync('git', ['ls-files', '-z', '--', 'tests'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0').filter(Boolean).map(normalize).filter((file) => testFixtureRe.test(file)),
    );
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

function writeAssembleDecision(selectedTests) {
  let decision;
  try {
    decision = shouldAssembleForRelatedTests({
      eventName: process.env.GITHUB_EVENT_NAME,
      changedPaths: changed,
      changedStatus,
      selectedTests,
      unreadableCount: unreadable.length,
    });
  } catch (error) {
    decision = {
      required: true,
      degraded: true,
      reason: `assemble decision failed: ${error?.message || String(error)}`,
    };
  }
  console.log(`Assemble + migrate: ${decision.required ? 'required' : 'not required'} (${decision.reason})`);
  if (decision.degraded) {
    // Un `required: true` degradato non e' la feature che lavora: e' lo skip
    // spento perche' il predicato non ha potuto misurare. Senza annotazione
    // resta identico a una decisione legittima nel log, e l'ottimizzazione
    // puo' restare un no-op per mesi senza che nessuno se ne accorga.
    console.log(`::warning::Assemble + migrate non e' saltabile: ${decision.reason}. Lo skip del dataset e' disattivato finche' la causa resta.`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${decision.required}\n`);
  }
}

function importsOf(file, fileSet, assets) {
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
  // Il letterale vale come dipendenza quando nomina un asset o la directory
  // che lo contiene (`'.github/workflows'` e `tests/fixtures`, usati dai test
  // che scandiscono una cartella). Solo dentro il CODICE: un path citato in un
  // commento non e' una dipendenza. Niente prefissi parziali — un template
  // letterale come `` `.github/…/crawler-group-${g}.yml` `` non produce arco, e
  // non serve: quei file non cambiano mai senza `contract.json`, che ne porta
  // gli sha256 ed e' nominato per esteso.
  for (const [rawLiteral] of code.matchAll(assetLiteralRe)) {
    // La barra finale va tolta: un riferimento costruito per template —
    // `` `.github/workflows/${name}` `` o `'.github/corpus-workflows/' + file` —
    // lascia il letterale con lo slash e senza normalizzazione non matcha.
    const literal = rawLiteral.replace(/\/+$/, '');
    for (const asset of assets) {
      if (asset === literal || asset.startsWith(`${literal}/`)) deps.add(asset);
    }
  }
  return [...deps].sort();
}

function loadGraph(files, assets) {
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
  const assetsDigest = createHash('sha1').update([...assets].sort().join('\n')).digest('hex');
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
      : { signature: sig, deps: importsOf(file, fileSet, assets) };
  }
  mkdirSync(path.dirname(graphFile), { recursive: true });
  writeFileSync(graphFile, JSON.stringify({ version: 6, assets: assetsDigest, files: graph }));
  return graph;
}

const candidates = [...new Set(changed.filter((file) =>
  file !== 'scripts/ci/run-related-tests.mjs' && !ignoredRe.test(file)
    && (sourceRe.test(file) || githubAssetRe.test(file) || testFixtureRe.test(file))
    && !alwaysExcludedTests.has(file)))];
const forceFull = changedStatus !== 'complete';
requireFullCheckoutForVerdict();
if (candidates.length === 0 && !forceFull) {
  console.log('No existing source/test files in the diff → related-only run has no tests.');
  if (selectionOnly) writeAssembleDecision([]);
  process.exit(0);
}

function changedAssetsFromDiff() {
  const refs = [...new Set([
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null,
    'origin/main',
  ].filter(Boolean))];
  for (const ref of refs) {
    let base;
    try {
      base = execFileSync('git', ['merge-base', ref, 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      continue;
    }
    try {
      const fields = execFileSync('git', [
        // This consumer needs only the set of asset paths. `R old new` and
        // `D old` + `A new` therefore produce the same entries; rename
        // detection would otherwise lazy-fetch base blobs under `blob:none`.
        'diff', '--name-status', '--no-renames', '-z', base, '--', '.github', 'tests',
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
      const assets = [];
      for (let i = 0; i < fields.length;) {
        const status = fields[i++];
        const pathCount = /^[RC]/.test(status) ? 2 : 1;
        for (let j = 0; j < pathCount && i < fields.length; j++) {
          const file = normalize(fields[i++]);
          if (githubAssetRe.test(file) || testFixtureRe.test(file)) assets.push(file);
        }
      }
      return assets;
    } catch {
      return [];
    }
  }
  return [];
}

const tracked = trackedFiles();
const assets = [...new Set([
  ...trackedAssets(),
  ...candidates.filter((file) => githubAssetRe.test(file) || testFixtureRe.test(file)),
  ...changedAssetsFromDiff(),
])];
const graph = loadGraph(tracked, assets);
if (unreadable.length > 0) {
  // Loud, and above the selection, because it is the one thing that can make
  // the list below shorter than it should be. Zero on a full checkout.
  console.log(`⚠️ ${unreadable.length} tracked file(s) unreadable in this working tree (sparse checkout?) — dropped from the import graph, so the selection may be incomplete:`);
  for (const file of unreadable.slice(0, 10)) console.log(`   ${file}`);
  if (unreadable.length > 10) console.log(`   … and ${unreadable.length - 10} more`);
  // A sparse checkout is useful for inspecting a selection, but it cannot
  // produce a trustworthy related-test verdict. Keep the explicit local
  // dry-run seam for that inspection and fail closed for every real run.
  const sparseInspection = process.env.VITEST_RELATED_DRY_RUN === 'true'
    && process.env.GITHUB_ACTIONS !== 'true';
  if (!sparseInspection && process.env.VITEST_RELATED_DRY_RUN !== 'true') {
    console.error('BLOCKED: related-test verdict requires a full checkout; missing tracked imports make the static graph incomplete.');
    console.error('Run this command in CI or from a full checkout with data/ and public/ materialized.');
    process.exit(2);
  }
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
// Il fallback si decide sui soli candidati SORGENTE. Un asset non-sorgente che
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
const githubCandidateCount = candidates.filter((file) => githubAssetRe.test(file)).length;
const fixtureCandidateCount = candidates.filter((file) => testFixtureRe.test(file)).length;
console.log(`Running Vitest related to ${sourceCandidates.length} changed source/test file(s)`
  + (githubCandidateCount ? ` + ${githubCandidateCount} .github asset(s)` : '')
  + (fixtureCandidateCount ? ` + ${fixtureCandidateCount} tests fixture(s)` : '')
  + `: ${tests.length} test file(s)`);
console.log(tests.join('\n'));
if (selectionOnly) {
  writeAssembleDecision([...related]);
  process.exit(0);
}
if (tests.length === 0) process.exit(0);
// Seam per ispezionare la SELEZIONE senza pagare la corsa: stampa l'elenco qui
// sopra ed esce. Usato da tests/run-related-tests-github-assets.test.ts e utile
// a mano per capire perche' un file seleziona (o non seleziona) un test.
//
// Il seam serve in locale e nel sottoprocesso dell'osservatore, mai nel gate.
// Se trapelasse nel job bloccante, fallire esplicitamente e' piu' sicuro che
// uscire 0 senza eseguire un solo test, indistinguibile da una selezione vuota.
if (process.env.VITEST_RELATED_DRY_RUN === 'true') {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error('VITEST_RELATED_DRY_RUN non e\' consentito in GitHub Actions: esecuzione bloccante annullata.');
    process.exit(1);
  }
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
