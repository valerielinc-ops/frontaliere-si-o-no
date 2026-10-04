/**
 * incomplete-predicate-version.mjs — l'impronta del predicato che decide cosa
 * conta come `complete` in data/translation-stats-history.json.
 *
 * ─── Perché esiste ──────────────────────────────────────────────────────────
 * La quota `complete` della history è scesa dal 61% al 33% fra il 29-09 e il
 * 04-10 (mappa di convergenza, workspace issue 2). Ricontando lo STESSO albero
 * con il predicato di prima e quello di dopo, 11,8 punti venivano da un solo
 * commit (8f20e9e5ff5, parità strutturale degli elenchi, 30-09) che aveva reso
 * `isIncomplete()` più severo: un cambio di MISURA. Il resto era DATO (ondate di
 * `needsRetranslation` dai crawler). La history non registrava con quale
 * predicato era stato contato ogni punto, quindi le due cause erano
 * indistinguibili: ci è voluto un replay a mano su quattro ref.
 *
 * Ogni riga della history porta ora `predicateVersion`: i primi 16 hex dello
 * sha256 dei sorgenti che definiscono il predicato. Due righe con versioni
 * diverse non sono confrontabili senza un ricalcolo; il monitor
 * (scripts/monitor-translation-coverage.mjs) usa questo campo per dire se un
 * calo è «misura» o «dato».
 *
 * ─── Cosa entra nell'impronta ───────────────────────────────────────────────
 * - il testo di `isIncomplete` (Function.prototype.toString), non l'intero
 *   scripts/relocalize-pending-jobs.mjs: quel file è il runner della cascata
 *   (2.700 righe, 28 commit in un mese) e quasi nessuno tocca il predicato;
 * - le costanti di modulo che il predicato legge (`PREDICATE_ENTRY_CONSTANTS`),
 *   estratte dal testo del file;
 * - i moduli da cui il predicato importa i giudizi (`PREDICATE_MODULES`) con la
 *   loro chiusura di import relativi, per intero: sono piccoli e dedicati;
 * - le funzioni prese da moduli grandi e instabili (`PREDICATE_FUNCTION_BINDINGS`,
 *   oggi solo `normalizeForLengthComparison` da dedicated-crawler-common.mjs,
 *   44 commit in un mese) col loro testo, non col file.
 * Tutto entra senza commenti e con gli spazi compressi (`codeOnly`): un
 * docblock riscritto non cambia cosa si conta.
 *
 * `auditPredicateCoverage()` è il guardiano di questo elenco: segnala ogni
 * import o funzione/costante locale che `isIncomplete` usa senza che
 * l'impronta lo copra. Il test lo esegue sul file vero, così un helper nuovo
 * nel predicato rompe il test invece di rendere l'impronta cieca.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Il file che definisce `isIncomplete`. */
export const PREDICATE_ENTRY = 'scripts/lib/translation-incomplete.mjs';

/** Moduli il cui contenuto (con la chiusura degli import relativi) è predicato. */
export const PREDICATE_MODULES = Object.freeze([
  'scripts/lib/translation-quality.mjs',
  'scripts/lib/ai-output-fidelity.mjs',
  'scripts/lib/job-locale-utils.mjs',
  'scripts/lib/detect-language.mjs',
]);

/** Binding presi da moduli grandi: entra il testo della funzione, non il file. */
export const PREDICATE_FUNCTION_BINDINGS = Object.freeze({
  normalizeForLengthComparison: 'scripts/lib/dedicated-crawler-common.mjs',
});

/** Costanti di modulo di PREDICATE_ENTRY lette dal predicato. */
export const PREDICATE_ENTRY_CONSTANTS = Object.freeze(['LOCALES', 'MIN_DESC_CHARS']);

const IDENT = '[A-Za-z_$][\\w$]*';

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Specificatori relativi importati staticamente o dinamicamente da `source`. */
export function relativeImportSpecifiers(source) {
  const specs = new Set();
  const text = String(source || '');
  const fromRe = /(?:^|[\s;])(?:import|export)\s[^;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  const bareRe = /(?:^|[\s;])import\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  const dynRe = /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, bareRe, dynRe]) {
    for (const m of text.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

/**
 * Chiusura degli import relativi a partire da `entries` (path relativi alla
 * root). Ordinata, deduplicata. Un import che non si risolve è un errore: un
 * file mancante renderebbe l'impronta silenziosamente parziale.
 */
export function moduleClosure(entries, readFile) {
  const seen = new Set();
  const stack = [...entries].map(toPosix);
  while (stack.length > 0) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFile(rel);
    for (const spec of relativeImportSpecifiers(source)) {
      stack.push(toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))));
    }
  }
  return [...seen].sort();
}

/** Mappa binding locale → specificatore, per gli import nominati di `source`. */
export function namedImportBindings(source) {
  const bindings = new Map();
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of String(source || '').matchAll(re)) {
    const spec = m[3];
    if (m[1]) bindings.set(m[1], spec);
    for (const part of m[2].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(new RegExp(`^(${IDENT})\\s+as\\s+(${IDENT})$`));
      bindings.set(asMatch ? asMatch[2] : trimmed, spec);
    }
  }
  const defaultRe = /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
  for (const m of String(source || '').matchAll(defaultRe)) bindings.set(m[1], m[2]);
  return bindings;
}

/** Il testo della dichiarazione top-level `const NAME = …;` (una riga), o null. */
export function topLevelConstText(source, name) {
  const m = String(source || '').match(new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=[^\\n]*;\\s*$`, 'm'));
  return m ? m[0].trim() : null;
}

/**
 * `source` senza commenti. Il commento di `isIncomplete` cita `main()`,
 * `MAX_JOBS` e altri nomi che il codice non usa: contarli farebbe dell'audit un
 * falso allarme. Le stringhe sono saltate per non leggere `//` in un URL come
 * un commento. Un letterale regex che contiene un apice non è gestito: il
 * predicato oggi non ne ha.
 */
export function stripComments(source) {
  const text = String(source || '');
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += text[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Il codice senza commenti e con gli spazi compressi: è ciò che entra
 * nell'impronta. Un commento riscritto non cambia cosa il predicato conta, e
 * marcarlo come cambio di misura sarebbe un falso «misura» nel monitor.
 */
export function codeOnly(source) {
  return stripComments(source).replace(/\s+/g, ' ').trim();
}

function identifierUsed(text, name) {
  return new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);
}

/**
 * Ciò che `isIncomplete` usa e l'impronta non copre.
 *
 * @param {{ predicateSource: string, entrySource: string, readFile: (rel: string) => string }} input
 * @returns {{ uncovered: string[], coveredModules: string[] }}
 */
export function auditPredicateCoverage({ predicateSource: rawPredicateSource, entrySource, readFile }) {
  const predicateSource = stripComments(rawPredicateSource);
  const coveredModules = moduleClosure(PREDICATE_MODULES, readFile);
  const covered = new Set(coveredModules);
  const uncovered = [];
  const entryDir = path.posix.dirname(PREDICATE_ENTRY);
  for (const [binding, spec] of namedImportBindings(entrySource)) {
    if (!identifierUsed(predicateSource, binding)) continue;
    if (!spec.startsWith('.')) continue; // node: built-in, non è predicato
    if (Object.hasOwn(PREDICATE_FUNCTION_BINDINGS, binding)) continue;
    const resolved = path.posix.normalize(path.posix.join(entryDir, spec));
    if (!covered.has(resolved)) uncovered.push(`${binding} (${resolved})`);
  }
  // Funzioni e costanti top-level del file del predicato, fuori dall'impronta.
  const localRe = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var)\\s+(${IDENT})`, 'gm');
  for (const m of String(entrySource || '').matchAll(localRe)) {
    const name = m[1];
    if (name === 'isIncomplete') continue;
    if (PREDICATE_ENTRY_CONSTANTS.includes(name)) continue;
    if (identifierUsed(predicateSource, name)) uncovered.push(`${name} (locale a ${PREDICATE_ENTRY})`);
  }
  return { uncovered: [...new Set(uncovered)].sort(), coveredModules };
}

/**
 * L'impronta, da sorgenti già letti. Pura.
 *
 * @param {{
 *   predicateSource: string,
 *   entrySource: string,
 *   functionSources: Record<string, string>,
 *   readFile: (rel: string) => string,
 * }} input
 * @returns {{ version: string, modules: string[] }}
 */
export function computePredicateVersion({ predicateSource, entrySource, functionSources, readFile }) {
  const modules = moduleClosure(PREDICATE_MODULES, readFile);
  const parts = [`predicate\n${codeOnly(predicateSource)}`];
  for (const name of PREDICATE_ENTRY_CONSTANTS) {
    const text = topLevelConstText(entrySource, name);
    if (text == null) throw new Error(`predicate constant ${name} not found in ${PREDICATE_ENTRY}`);
    parts.push(`const ${name}\n${text}`);
  }
  for (const name of Object.keys(PREDICATE_FUNCTION_BINDINGS).sort()) {
    const text = functionSources?.[name];
    if (typeof text !== 'string' || !text) throw new Error(`predicate helper ${name} source missing`);
    parts.push(`fn ${name}\n${codeOnly(text)}`);
  }
  for (const rel of modules) parts.push(`module ${rel}\n${codeOnly(readFile(rel))}`);
  return { version: sha256Hex(parts.join('\n\u0000\n')).slice(0, 16), modules };
}

/** Lettore di file relativo alla root del repository del codice in esecuzione. */
export function repoFileReader(root = REPO_ROOT) {
  return (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
}

/**
 * L'impronta del predicato in esecuzione. Riceve le funzioni già importate dal
 * chiamante (log-translation-stats.mjs le carica comunque): così il testo
 * hashato è quello che sta davvero contando, non una copia letta da disco.
 *
 * @param {{ isIncomplete: Function, helpers: Record<string, Function>, root?: string }} input
 */
export function currentPredicateVersion({ isIncomplete, helpers, root = REPO_ROOT }) {
  const readFile = repoFileReader(root);
  const functionSources = {};
  for (const name of Object.keys(PREDICATE_FUNCTION_BINDINGS)) {
    functionSources[name] = typeof helpers?.[name] === 'function' ? helpers[name].toString() : '';
  }
  return computePredicateVersion({
    predicateSource: isIncomplete.toString(),
    entrySource: readFile(PREDICATE_ENTRY),
    functionSources,
    readFile,
  }).version;
}
