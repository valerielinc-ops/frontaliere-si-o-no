/**
 * dataset-dependent-tests.mjs — classifica i test in base al fatto che leggano
 * o meno gli OUTPUT di `scripts/assemble-jobs-dataset.mjs`.
 *
 * Perché esiste: su un job `tests` da ~648s, l'assemble costa 133-155s misurati
 * (run 30355205859 / 30357073975) e la sua cache è di fatto sempre un miss —
 * la key include `hashFiles('data/jobs/by-crawler/**')` e i crawler committano
 * slice decine di volte al giorno, per cui la key non ricentra mai; per giunta
 * la quota cache del repo è satura (9.54GB/10GB, 12 cache attive) e la LRU
 * evicta prima che una key si ripresenti. Quei ~140s erano puro tempo morto in
 * coda a vitest.
 *
 * Solo 37 file di test su 1388 leggono un output dell'assemble: gli altri
 * possono girare MENTRE l'assemble lavora in background (`background:` step in
 * tests.yml), e i 37 girano dopo il `wait-all`. Questo file è la singola fonte
 * di verità di quella partizione — è calcolata a runtime dal sorgente, non
 * committata come lista, così un test nuovo non può andare fuori sync.
 *
 * IMPORTANTE — le slice NON contano. `data/jobs/by-crawler/**` è committato nel
 * repo: un test che legge le slice non ha bisogno dell'assemble. Contano solo i
 * file che l'assemble GENERA (gitignored), elencati in ASSEMBLE_OUTPUTS.
 *
 * Classificazione volutamente CONSERVATIVA (over-include): un falso positivo
 * costa solo un po' di parallelismo in meno, un falso negativo costa un test
 * rosso. Per lo stesso motivo si segue anche il grafo di import (un test che
 * importa un helper che legge jobs.json è dipendente pur non nominandolo).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Basename dei file prodotti da assemble-jobs-dataset.mjs (vedi le costanti
 * `DATA_…` e `PUBLIC_…` in quello script). Match sul solo basename perché i test
 * costruiscono i path in modi diversi — `'data/jobs.json'`, ma anche
 * `path.join(ROOT, 'data', 'jobs.json')` che un grep sul path completo
 * mancherebbe.
 */
const ASSEMBLE_OUTPUTS = [
  'jobs.json',
  'expired-jobs.json',
  'jobs-meta.json',
  'jobs-stats.json',
  'jobs-crawler-summaries.json',
  'job-canton-pins.json',
  // Scritto da scripts/migrate-all-known-job-slugs-canton-aware.mjs, che gira
  // SUBITO DOPO l'assemble perché ne legge data/jobs.json. Nel job `tests`
  // entrambi stanno dietro lo stesso `wait-all`, quindi un test che legge
  // questo file va nello stesso gruppo dei dataset-dipendenti: prima del
  // wait il file è ancora nella versione committata, non migrata.
  //
  // Senza `.json` finale (issue #4248): il registro è passato da monolite a
  // shard sotto `data/all-known-job-slugs/`, e i lettori ora importano
  // `scripts/lib/all-known-job-slugs-store.mjs`. Il prefisso senza estensione
  // matcha entrambe le forme — il path degli shard E il path del modulo store
  // — così un test che legge il registro tramite l'accessor resta classificato
  // come dataset-dipendente invece di scivolare nel gruppo veloce e girare
  // prima che la migrazione canton-aware abbia scritto gli shard.
  'all-known-job-slugs',
  // Idem per il ledger degli orfani arricchiti (issue #4248, seconda metà):
  // anch'esso è passato da monolite `orphan-enriched-data.json` a shard sotto
  // `data/orphan-enriched-data/`, letti via
  // `scripts/lib/orphan-enriched-store.mjs`. Senza `.json` per la stessa
  // ragione: il prefisso matcha sia il path degli shard sia quello del modulo.
  // È scritto da sync-gsc-orphans/enrich-compat-orphan-slugs, ma un test che lo
  // legge vede comunque la versione committata finché la pipeline dati non ha
  // finito, quindi appartiene allo stesso gruppo.
  'orphan-enriched-data',
];

const OUTPUT_RE = new RegExp(
  `(^|['"\`/\\\\])(${ASSEMBLE_OUTPUTS.map((f) => f.replace(/[.]/g, '\\.')).join('|')})`,
);

/**
 * Nominare un output NON basta: `services/jobSlugShards.ts` cita
 * `/data/jobs.json` come URL da `fetch` a runtime nel browser, e siccome
 * `services/router.ts` lo importa ed è a sua volta importato da quasi ogni
 * componente, il solo match sul nome classificava 640/1388 test come
 * dipendenti (46%) — inclusi casi assurdi come `AdBlockGate.test.tsx`, la cui
 * catena è AdBlockGate → NavigationContext → router → jobSlugShards.
 *
 * Conta solo chi LEGGE il file dal filesystem: un fetch di un URL pubblico non
 * ha bisogno che l'assemble sia finito, una readFileSync sì.
 */
const FS_READ_RE =
  /\b(readFileSync|readFile|existsSync|statSync|createReadStream|readJson|loadJson|readAllKnownJobSlugs|readOrphanEnriched)\b/;

/** true se il sorgente legge un output dell'assemble dal filesystem. */
function readsDatasetFromDisk(src) {
  return OUTPUT_RE.test(src) && FS_READ_RE.test(src);
}

const TEST_EXTS = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mjs', '.js', '.mts', '/index.ts', '/index.tsx', '/index.mjs'];

/** Tutti i file di test sotto tests/, ricorsivo. */
function listTestFiles(dir = path.join(ROOT, 'tests'), acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__snapshots__') continue;
      listTestFiles(full, acc);
    } else if (TEST_EXTS.some((ext) => e.name.endsWith(ext))) {
      acc.push(full);
    }
  }
  return acc;
}

const sourceTextCache = new Map();
function readSource(file) {
  if (sourceTextCache.has(file)) return sourceTextCache.get(file);
  let src = '';
  try {
    src = fs.readFileSync(file, 'utf-8');
  } catch {
    src = '';
  }
  sourceTextCache.set(file, src);
  return src;
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/** Risolve uno specifier locale (relativo o alias `@/`) a un file reale. */
function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith('@/')) {
    base = path.join(ROOT, spec.slice(2));
  } else {
    return null; // pacchetto npm: fuori dal grafo del repo
  }
  for (const ext of RESOLVE_EXTS) {
    const cand = base + ext;
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      /* prossimo candidato */
    }
  }
  return null;
}

/**
 * Import locali risolti di `file`, entro il repo. Cached: il grafo viene
 * percorso più volte dal fixed-point sotto.
 *
 * ESPORTATA per `scripts/ci/corpus-wide-tests.mjs`, che deve sapere quali file
 * sorgente un test corpus-wide raggiunge per decidere se il diff di una PR lo
 * rende ancora bloccante. Riscrivere lì la stessa risoluzione (RESOLVE_EXTS +
 * alias `@/` + IMPORT_RE) creerebbe due copie della stessa regola destinate a
 * divergere (AGENTS.md #6), e la divergenza si presenterebbe nel modo peggiore
 * possibile: un gate che smette di scattare senza che niente diventi rosso.
 * Nessun cambio di comportamento per i chiamanti esistenti — solo `export`.
 */
const importsCache = new Map();
export function localImports(file) {
  const cached = importsCache.get(file);
  if (cached) return cached;
  const out = [];
  for (const m of readSource(file).matchAll(IMPORT_RE)) {
    const resolved = resolveSpecifier(m[1], file);
    if (resolved) out.push(resolved);
  }
  importsCache.set(file, out);
  return out;
}

/**
 * Classificazione a FIXED-POINT, calcolata una volta sola.
 *
 * Un primo tentativo usava una DFS con memoizzazione dei soli risultati
 * positivi più un set `seen` per spezzare i cicli di import. Non era
 * idempotente: `seen` è condiviso fra i rami di una stessa visita, quindi un
 * modulo già attraversato veniva liquidato come `false` in un contesto e
 * risolto `true` in un altro, e la memo dei positivi cambiava l'esito della
 * chiamata SUCCESSIVA — 594 dipendenti alla prima invocazione, 596 alla
 * seconda. Su una partizione che decide quali test girano in quale delle due
 * run vitest, un risultato che dipende dall'ordine delle chiamate può perdere
 * file per strada (copertura persa in silenzio, vedi
 * tests/dataset-test-partition.test.ts).
 *
 * Il fixed-point non ha quel difetto: si parte dai file che leggono davvero il
 * dataset e si propaga all'indietro lungo gli archi di import finché nulla
 * cambia. I cicli convergono naturalmente e l'esito non dipende dall'ordine di
 * visita.
 */
let taintedCache = null;
function taintedFiles() {
  if (taintedCache) return taintedCache;

  // 1. Raccogli tutti i file raggiungibili dai test (chiusura degli import).
  const all = new Set();
  const queue = listTestFiles();
  while (queue.length) {
    const f = queue.pop();
    if (all.has(f)) continue;
    all.add(f);
    for (const dep of localImports(f)) if (!all.has(dep)) queue.push(dep);
  }

  // 2. Seed: chi legge un output dell'assemble dal filesystem.
  const tainted = new Set();
  for (const f of all) if (readsDatasetFromDisk(readSource(f))) tainted.add(f);

  // 3. Propaga: importare un file tainted rende tainted anche l'importatore.
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of all) {
      if (tainted.has(f)) continue;
      if (localImports(f).some((dep) => tainted.has(dep))) {
        tainted.add(f);
        changed = true;
      }
    }
  }

  taintedCache = tainted;
  return tainted;
}

const toPosixRel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

/** Path POSIX relativi alla root, ordinati — dei test che richiedono l'assemble. */
export function listDatasetDependentTests() {
  const tainted = taintedFiles();
  return listTestFiles().filter((f) => tainted.has(f)).map(toPosixRel).sort();
}

/** Path POSIX relativi alla root — dei test che NON richiedono l'assemble. */
export function listDatasetIndependentTests() {
  const tainted = taintedFiles();
  return listTestFiles().filter((f) => !tainted.has(f)).map(toPosixRel).sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv.includes('--independent') ? 'independent' : 'dependent';
  const list = mode === 'independent' ? listDatasetIndependentTests() : listDatasetDependentTests();
  if (process.argv.includes('--count')) {
    const dep = listDatasetDependentTests().length;
    const all = listTestFiles().length;
    console.log(`dataset-dependent: ${dep} / ${all} test file (${((dep / all) * 100).toFixed(1)}%)`);
  } else {
    console.log(list.join('\n'));
  }
}
