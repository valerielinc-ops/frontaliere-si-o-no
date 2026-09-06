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

/**
 * I path repo-relativi che uno specificatore RELATIVO potrebbe designare.
 * Uno specificatore bare (`react`, `node:fs`) non è mai un effetto del profilo
 * sparse: risolve in `node_modules`, che un worktree sparse ha comunque.
 */
export function moduleCandidates(fromFile, specifier) {
  if (!specifier || !specifier.startsWith('.')) return [];
  const dir = path.posix.dirname(fromFile.split(path.sep).join('/'));
  const base = path.posix.normalize(path.posix.join(dir, specifier));
  if (base.startsWith('..')) return []; // fuori dal repo: è il confine fra i due repo, non lo sparse.
  return CANDIDATE_SUFFIXES.map((suffix) => `${base}${suffix}`);
}

/**
 * Divide gli errori in ciò che questo worktree può giudicare e ciò che è solo
 * il profilo sparse che parla.
 *
 * @param {{file:string,code:string,msg:string,line:number}[]} errors
 * @param {Set<string>} missingTracked path tracciati da git ma assenti su disco
 * @returns {{measured: object[], environment: object[]}}
 */
export function classifySparseErrors(errors, missingTracked) {
  const measured = [];
  const environment = [];
  for (const error of errors) {
    const specifier = missingModuleSpecifier(error);
    const candidates = specifier ? moduleCandidates(error.file, specifier) : [];
    if (candidates.some((candidate) => missingTracked.has(candidate))) environment.push(error);
    else measured.push(error);
  }
  return { measured, environment };
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
