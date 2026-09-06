/**
 * typecheck-sparse.mjs — classificare gli errori di `tsc` prodotti da un
 * worktree SPARSE, invece di rinunciare a misurare (issue #7677).
 *
 * PERCHÉ ESISTE
 * -------------
 * `check-typecheck-baseline.mjs` decideva con un solo probe che un worktree
 * sparse è inutilizzabile — `existsSync('data/blog-articles-data.ts')`, che è
 * un symlink verso `packages/articles/content/`, non materializzato — ed usciva
 * 2 PRIMA di invocare `tsc`. Conseguenza: zero typecheck in locale su codice
 * che decide rotte indicizzate, gate vivo solo in CI dove il checkout è pieno.
 * Questo repo si lavora in worktree sparse (CLAUDE.md: un checkout pieno costa
 * ~3,9 GB), quindi «gira solo in CI» vuol dire «non gira mai prima della PR».
 *
 * L'idioma corretto qui è già scritto altrove e va imitato, non reinventato:
 * `run-related-tests.mjs` droppa dal grafo i file tracciati illeggibili e
 * STAMPA il conteggio (una selezione monca visibile invece che presunta), e
 * `corpus-ahead-check.mjs` legge i gemelli sotto `data/` via `git show` invece
 * di leggere «assente» dove c'è solo «non materializzato».
 *
 * COSA È UN ERRORE D'AMBIENTE E COSA NO
 * -------------------------------------
 * Solo `TS2307` («Cannot find module 'X'») il cui specificatore RELATIVO
 * risolve a un path che git TRACCIA ma che il working tree non ha. Quello è il
 * profilo sparse che parla, non il codice. Tutto il resto — incluso un TS2307
 * verso un modulo che non esiste in nessun checkout (`./seoMetadataType`, i
 * path che risolvono sul repo gemello) — resta CONTATO: sono i 20 errori
 * strutturali già registrati nella baseline, e nasconderli renderebbe il gate
 * cieco proprio dove la baseline lo vuole vigile.
 *
 * La classificazione è deliberatamente STRETTA: un errore che l'assenza di un
 * modulo produce a valle (es. un `TS2339` su un tipo diventato `any`) non viene
 * scusato. Può quindi restare un rosso d'ambiente, e va bene: l'esito è exit 1
 * con gli errori stampati — «non si misura → si fallisce», mai un verde finto.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** L'unico codice che, da solo, prova «modulo non risolto». */
export const MODULE_NOT_FOUND_CODE = 'TS2307';

const MISSING_MODULE_RE = /Cannot find module '([^']+)'/;

/**
 * Estensioni che TS prova su uno specificatore senza estensione, più le forme
 * `index`. `''` copre lo specificatore già completo di estensione.
 */
const CANDIDATE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.json',
  '/index.ts',
  '/index.tsx',
  '/index.d.ts',
  '/index.js',
];

/** Lo specificatore di un `TS2307`, o `null` se l'errore è di altra natura. */
export function missingModuleSpecifier(error) {
  if (!error || error.code !== MODULE_NOT_FOUND_CODE) return null;
  const m = MISSING_MODULE_RE.exec(error.msg || '');
  return m ? m[1] : null;
}

const withSuffixes = (base) => {
  if (!base || base.startsWith('..')) return []; // fuori dal repo: confine fra i due repo, non sparse.
  return CANDIDATE_SUFFIXES.map((suffix) => `${base}${suffix}`);
};

/**
 * I path repo-relativi che uno specificatore potrebbe designare.
 *
 * Due forme, ed è la seconda che ha reso questo modulo necessario: metà del
 * codice importa i moduli dati con l'ALIAS di `tsconfig.json`
 * (`@/data/blog-articles-data`), non con un path relativo. MISURATO su questo
 * repo simulando lo sparse: senza risolvere `paths` restavano 9 falsi
 * "regressioni" in 4 componenti — cioè il gate sarebbe stato rosso in ogni
 * worktree sparse, che è la stessa inutilizzabilità di prima con un'altra
 * faccia. Uno specificatore bare vero (`react`, `node:fs`) non è mai un
 * effetto del profilo sparse: risolve in `node_modules`, che c'è comunque.
 *
 * @param {string} fromFile file che contiene l'import, repo-relativo
 * @param {string} specifier
 * @param {Record<string,string[]>} [paths] `compilerOptions.paths` (target repo-relativi)
 */
export function moduleCandidates(fromFile, specifier, paths = {}) {
  if (!specifier) return [];
  if (specifier.startsWith('.')) {
    const dir = path.posix.dirname(fromFile.split(path.sep).join('/'));
    return withSuffixes(path.posix.normalize(path.posix.join(dir, specifier)));
  }
  const out = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern !== specifier) continue;
      for (const target of targets) out.push(...withSuffixes(path.posix.normalize(target)));
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const target of targets) {
      out.push(...withSuffixes(path.posix.normalize(target.replace('*', matched))));
    }
  }
  return out;
}

/**
 * `compilerOptions.paths` di un tsconfig, normalizzato a target repo-relativi.
 * Fallisce in silenzio verso `{}`: senza alias la classificazione resta
 * corretta sui path relativi, e un tsconfig illeggibile non deve trasformare
 * il gate in un crash.
 */
export function tsconfigPaths(tsconfigText) {
  try {
    const parsed = JSON.parse(tsconfigText);
    const raw = (parsed.compilerOptions && parsed.compilerOptions.paths) || {};
    const out = {};
    for (const [pattern, targets] of Object.entries(raw)) {
      out[pattern] = targets.map((t) => path.posix.normalize(t.replace(/^\.\//, '')));
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Divide gli errori in ciò che questo worktree può giudicare e ciò che è solo
 * il profilo sparse che parla.
 *
 * Tre bucket, e il terzo è il compromesso esplicito di #7677:
 *   - `environment`: `TS2307` verso un path tracciato-ma-assente. Prova diretta.
 *   - `downstream`: gli errori sulla STESSA RIGA di un errore `environment`.
 *     Un `await import('@/data/blog-articles-data')` non risolto produce lì un
 *     `TS2307` e, sulla stessa riga, il `TS2322` del valore diventato
 *     `Map<unknown, unknown>` — MISURATO in `services/seo/articleAuthorUrl.ts`
 *     riga 72, e sparisce appena il modulo c'è. Contarlo terrebbe il gate rosso
 *     in OGNI worktree sparse, cioè inutilizzabile esattamente come quando
 *     usciva 2. Nemmeno questi spariscono in silenzio: sono stampati e contati
 *     a parte.
 *     La riga, non il FILE. Il primo tentativo declassava tutti gli errori dei
 *     file con un import rotto: MISURATO, si mangiava una regressione vera
 *     (`const x: number = 'stringa'` piantato a riga 4056 di
 *     `services/router.ts`, che importa un modulo non materializzato) e il gate
 *     usciva 0 su un errore reale — fail-open, cioè il difetto che questo
 *     script dichiara di non voler avere. Sulla riga il nesso è provato; sul
 *     file è solo una vicinanza.
 *   - `measured`: tutto il resto, incluso un `TS2307` verso un modulo che non
 *     esiste in nessun checkout (i 20 errori strutturali della baseline).
 *
 * @param {{file:string,code:string,msg:string,line:number}[]} errors
 * @param {Set<string>} missingTracked path tracciati da git ma assenti su disco
 * @param {{paths?: Record<string,string[]>}} [options]
 * @returns {{measured: object[], environment: object[], downstream: object[]}}
 */
export function classifySparseErrors(errors, missingTracked, options = {}) {
  const paths = options.paths || {};
  const environment = [];
  const rest = [];
  for (const error of errors) {
    const specifier = missingModuleSpecifier(error);
    const candidates = specifier ? moduleCandidates(error.file, specifier, paths) : [];
    if (candidates.some((candidate) => missingTracked.has(candidate))) environment.push(error);
    else rest.push(error);
  }
  const poisonedLines = new Set(environment.map((e) => `${e.file}:${e.line}`));
  const measured = [];
  const downstream = [];
  for (const error of rest) {
    if (poisonedLines.has(`${error.file}:${error.line}`)) downstream.push(error);
    else measured.push(error);
  }
  return { measured, environment, downstream };
}

/**
 * I file della baseline che questo worktree non ha materializzato: `tsc` non li
 * ha nemmeno letti, quindi «zero errori» su di loro non è un miglioramento — è
 * un'assenza di misura, e va detta invece di essere confusa con un progresso.
 */
export function unmeasurableBaselineFiles(baselineBlocking, missingTracked) {
  return Object.keys(baselineBlocking || {})
    .filter((file) => missingTracked.has(file))
    .sort();
}

/**
 * I path che git traccia e che `fs.existsSync` non risolve. `existsSync` SEGUE
 * i symlink, che è esattamente ciò che serve: `data/blog-articles-data.ts`
 * esiste come link e non come contenuto, e per `tsc` è indistinguibile da un
 * file assente.
 *
 * @param {string} root
 * @param {{listTracked?: () => string[], exists?: (rel: string) => boolean}} [io] iniettabile nei test
 * @returns {Set<string>}
 */
export function trackedButAbsent(root, io = {}) {
  const listTracked =
    io.listTracked ||
    (() =>
      execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter(Boolean));
  const exists = io.exists || ((rel) => fs.existsSync(path.join(root, rel)));
  const missing = new Set();
  for (const rel of listTracked()) if (!exists(rel)) missing.add(rel);
  return missing;
}
