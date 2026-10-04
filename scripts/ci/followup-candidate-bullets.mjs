/**
 * followup-candidate-bullets.mjs — bullet già classificati e instradati per il
 * triage follow-up (zero-agent, deterministico).
 *
 * `post-merge-followup.yml` consegnava all'agente l'intera sezione
 * `## Non implementato (ancora)` e gli chiedeva di riapplicare a mano la
 * tassonomia degli stati e una mappa in prosa dei repository. Due classi di
 * item non chiudibili nascevano lì:
 *   - bullet che `isCandidateItem()` dichiara già chiusi («falso positivo»,
 *     `per scelta`, `in questa PR`…) coniati comunque;
 *   - item coniati nel repository sbagliato, perché «sito: tutto il resto» non
 *     guarda né l'esistenza del file né il manifest di mirror.
 *
 * Questo script fa le due cose prima che l'agente parta e le scrive nel bundle
 * (`## Candidate bullets`): per ogni bullet lo stato letterale, `candidate`
 * (stesso oracolo di `followup-has-candidates.mjs`: solo import) e, per ogni
 * path citato fra backtick in un bullet candidato, l'instradamento di
 * `mirrorRoute()`.
 *
 * La verità sull'instradamento è `scripts/ci/loop-sync-manifest.json`, che vive
 * SOLO nel corpus. La regola «manca qui ed esiste nel gemello → gemello» manda
 * a rovescio i file `identical`: `host/batchWrite.ts` manca sul sito ed esiste
 * nel corpus, ma si corregge nel sito in `build-plugins/batchWrite.ts`. Per
 * questo, senza manifest, la risposta è `unknown` e MAI un instradamento per
 * sola esistenza.
 *
 * Uso:
 *   node scripts/ci/followup-candidate-bullets.mjs [--side site|corpus]
 *     [--manifest <file>] <pr.json> [<pr.json> ...]
 * Ogni `<pr.json>` è l'output di `gh pr view N --json number,body,...`.
 * Senza `--manifest` il manifest si legge UNA volta via API dal repository del
 * corpus. Stampa la sezione markdown su stdout. Fail-open: un errore lascia la
 * PR senza elenco e l'agente ricade sulla propria lettura della sezione.
 *
 * Env: FOLLOWUP_SITE_REPO, FOLLOWUP_CORPUS_REPO (slug), FOLLOWUP_TWIN_LOOKUP_CAP,
 * FOLLOWUP_TESTS_WORKFLOW (default `tests.yml` sul sito, spento sul corpus),
 * FOLLOWUP_MERGE_RUN_LOG_CAP (log di run letti per batch, default 6).
 * Il `<pr.json>` deve portare `headRefOid` perché un bullet che rinvia una
 * verifica alla CI della PR (`own-verification`) possa leggere la run `tests`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bulletState,
  decisionDeferralSpecificity,
  nonImplementedSection,
  topLevelBullets,
} from '../lib/pr-body-sections-check.mjs';
import { isCandidateItem } from './followup-has-candidates.mjs';

export const MANIFEST_PATH = 'scripts/ci/loop-sync-manifest.json';
export const DEFAULT_REPOS = Object.freeze({
  site: 'valerielinc-ops/frontaliere-si-o-no',
  corpus: 'nanakokyobashi-rgb/frontaliere-articles',
});
const DEFAULT_TWIN_LOOKUP_CAP = 40;

// ── Logica pura ─────────────────────────────────────────────────────

const twinOf = (side) => (side === 'site' ? 'corpus' : 'site');

/**
 * `./a/b.ts:12` → `a/b.ts`. L'ancora di riga puo' avere la `L` davanti ai
 * numeri (`a/b.ts:L12`, `a/b.ts:L12-L20`): e' la forma con cui il reviewer cita
 * i file nei finding, e senza toglierla il path non supera la validazione e il
 * bullet resta senza instradamento.
 */
export function normalizeCitedPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/:L?\d+(?:[-:]L?\d+)*$/, '');
}

// I nomi di una voce sui due lati: stessa regola di `entryPaths()` in
// `bin/where-to-fix-lib.mjs` (root del workspace).
function entryNames(entry) {
  if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) return null;
  const manifestPath = normalizeCitedPath(entry.path);
  const declared = typeof entry.sitePath === 'string' && entry.sitePath.trim()
    ? normalizeCitedPath(entry.sitePath)
    : null;
  if (entry.mode === 'not-ported') return { corpus: null, site: declared || manifestPath };
  const corpusOnly = entry.mode === 'corpus-only' || entry.mode === 'corpus-only-pending';
  return { corpus: manifestPath, site: declared || (corpusOnly ? null : manifestPath) };
}

function lookup(fn, target) {
  if (typeof fn !== 'function') return null;
  try {
    const result = fn(target);
    return result === true || result === false ? result : null;
  } catch {
    return null;
  }
}

/**
 * Dove si corregge un path citato da un bullet.
 *
 * @param {{
 *   path: string,
 *   side: 'site'|'corpus',
 *   manifestFiles: Array<{path:string, sitePath?:string, mode:string}>|null,
 *   existsHere?: (p: string) => boolean|null,
 *   existsTwin?: (p: string) => boolean|null,
 * }} input
 * @returns {{repo: 'site'|'corpus'|'unknown', targetPath: string, why: string}}
 */
export function mirrorRoute({ path: cited, side, manifestFiles, existsHere, existsTwin }) {
  const target = normalizeCitedPath(cited);
  if (side !== 'site' && side !== 'corpus') {
    return { repo: 'unknown', targetPath: target, why: 'unknown-side' };
  }
  if (!Array.isArray(manifestFiles)) {
    return { repo: 'unknown', targetPath: target, why: 'manifest-unavailable' };
  }
  const twin = twinOf(side);

  // Prima il nome sul lato della PR, poi quello del gemello: un bullet del
  // sito può citare `host/batchWrite.ts` (nome corpus di un file `identical`).
  let matches = [];
  let matchedBy = side;
  for (const nameSide of [side, twin]) {
    matches = manifestFiles.filter((entry) => entryNames(entry)?.[nameSide] === target);
    if (matches.length > 0) {
      matchedBy = nameSide;
      break;
    }
  }

  // Il path corrisponde solo al nome che una voce ha SUL GEMELLO. Se un file
  // con quel path esiste anche qui, è un omonimo senza voce su questo lato
  // (`scripts/ci/redflag-doc-sections.mjs` esiste sul sito ed è `corpus-only`
  // nel manifest): la voce non parla di lui, e `bin/where-to-fix` da qui
  // risponde «nessun vincolo». Senza una risposta certa non si instrada.
  if (matches.length > 0 && matchedBy === twin) {
    const here = lookup(existsHere, target);
    if (here === true) return { repo: side, targetPath: target, why: 'no-entry:exists-here' };
    if (here === null) return { repo: 'unknown', targetPath: target, why: 'manifest:twin-name:here-lookup-failed' };
  }

  if (matches.length > 0) {
    const routes = matches.map((entry) => {
      const names = entryNames(entry);
      switch (entry.mode) {
        case 'identical':
        case 'not-ported':
        case 'corpus-only-pending':
          return { repo: 'site', targetPath: names.site || names.corpus, why: `manifest:${entry.mode}` };
        case 'corpus-only':
          return { repo: 'corpus', targetPath: names.corpus, why: 'manifest:corpus-only' };
        case 'adapted':
          return null;
        default:
          return { repo: 'unknown', targetPath: target, why: `manifest:unknown-mode:${entry.mode}` };
      }
    });
    if (routes.every((route) => route === null)) {
      // `adapted`: le due copie sono file diversi. Vale quella che il bullet
      // cita davvero, cioè il repository in cui quel path esiste.
      if (matchedBy === side && lookup(existsHere, target) === true) {
        return { repo: side, targetPath: target, why: 'manifest:adapted:exists-here' };
      }
      if (lookup(existsTwin, target) === true) {
        return { repo: twin, targetPath: target, why: 'manifest:adapted:exists-twin' };
      }
      return { repo: 'unknown', targetPath: target, why: 'manifest:adapted:not-found' };
    }
    const distinct = new Set(routes.map((route) => (route ? `${route.repo}\n${route.targetPath}` : 'adapted')));
    if (distinct.size > 1) {
      return { repo: 'unknown', targetPath: target, why: 'manifest:conflict' };
    }
    return routes[0];
  }

  // Nessuna voce: nessun vincolo di mirror, decide l'esistenza.
  const here = lookup(existsHere, target);
  if (here === true) return { repo: side, targetPath: target, why: 'no-entry:exists-here' };
  if (here === null) return { repo: 'unknown', targetPath: target, why: 'no-entry:here-lookup-failed' };
  const there = lookup(existsTwin, target);
  if (there === true) return { repo: twin, targetPath: target, why: 'no-entry:exists-twin' };
  if (there === null) return { repo: 'unknown', targetPath: target, why: 'no-entry:twin-lookup-failed' };
  return { repo: 'unknown', targetPath: target, why: 'no-entry:not-found' };
}

const SAFE_PATH_RE = /^[A-Za-z0-9_@()[\]+.-]+(?:\/[A-Za-z0-9_@()[\]+.-]+)+$/;
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * I nomi nella root che il manifest di mirror dichiara, su uno dei due lati
 * (`FOLLOWUP.md`, `REVIEW.md`, `AGENTS.md`, `ISSUES.md`: tutti `adapted`).
 *
 * Perché il manifest e non l'elenco dei file tracciati nella root: un nome
 * senza `/` fra backtick è spesso un identificatore (`res.json`) o un file che
 * esiste in entrambi i repository senza vincolo di mirror (`package.json`,
 * `README.md`), e instradarlo per sola esistenza è proprio ciò che questo
 * script esclude. I file nella root il cui repository NON è ovvio, cioè i
 * contratti condivisi, sono esattamente quelli che il manifest elenca: senza
 * una route il prompt li manderebbe sulla mappa «tutto il resto → sito»
 * anche quando il residuo è sulla copia del corpus.
 *
 * @param {Array<object>|null} manifestFiles
 * @returns {Set<string>}
 */
export function manifestRootFiles(manifestFiles) {
  const names = new Set();
  if (!Array.isArray(manifestFiles)) return names;
  for (const entry of manifestFiles) {
    const sides = entryNames(entry);
    for (const name of [sides?.site, sides?.corpus]) {
      if (name && !name.includes('/')) names.add(name);
    }
  }
  return names;
}

/**
 * I path citati fra backtick in un bullet: almeno una `/` (oppure un nome
 * nella root presente in `rootFiles`), un'estensione, nessuno spazio, nessun
 * glob e nessun segmento `..`.
 * @param {string} text
 * @param {{rootFiles?: Set<string>}} [options]
 * @returns {string[]}
 */
export function citedPaths(text, { rootFiles } = {}) {
  const found = [];
  for (const match of String(text ?? '').matchAll(/`([^`\n]+)`/g)) {
    const candidate = normalizeCitedPath(match[1]);
    const declaredRoot = rootFiles?.has(candidate) === true;
    if (!(declaredRoot || SAFE_PATH_RE.test(candidate)) || !FILE_EXT_RE.test(candidate)) continue;
    if (candidate.startsWith('-') || candidate.split('/').includes('..')) continue;
    if (!found.includes(candidate)) found.push(candidate);
  }
  return found;
}

// La sezione arriva fino a fine body: vi cadono dentro anche righe che non sono
// residui. Quelle di servizio si scartano; non sono materia di triage.
const ATTRIBUTION_TRAILER_RE = /^🤖\s+Generated with\b/u;
const CLOSING_REF_TRAILER_RE =
  /^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|addresses|supersedes|refs?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+[\s.]*$/i;
const FOLLOWUP_ITEM_TRAILER_RE = /^follow-up item:\s*FU-/i;
const isTrailer = (item) =>
  ATTRIBUTION_TRAILER_RE.test(item) || CLOSING_REF_TRAILER_RE.test(item) || FOLLOWUP_ITEM_TRAILER_RE.test(item);

// «Nessuno.», «**Nessuno**», «none»: la sezione dichiara di essere vuota. Vale
// SOLO se la dichiarazione è l'intero testo, con al più punteggiatura ed
// enfasi: ancorata all'inizio E alla fine. Ancorata solo all'inizio, «Nessuno:
// aggiornare `scripts/ci/foo.mjs`» usciva `reason: empty` e il triage lo
// scartava, mentre `isCandidateItem()` lo dichiara candidato. Qualunque altro
// testo dopo la parola — un'azione, un motivo, «dei sibling è stato corretto» —
// lo giudica l'oracolo condiviso, non un elenco di frasi «non residue».
const EMPTY_DECLARED_RE = /^[*_`]*(?:nessuno|niente|none|nothing)[*_`.:;,!—–\s-]*$/i;

// Una riga di lista, numerata compresa: decide `kind` delle sole righe che
// precedono il primo bullet, che il contratto non attacca a nessuna voce.
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const LEADING_MARKER_RE = /^[-*+][ \t]+/;

/**
 * Le voci di `## Non implementato` raggruppate con la regola del CONTRATTO:
 * `topLevelBullets()` di `scripts/lib/pr-body-sections-check.mjs`, non una
 * seconda regola scritta qui. Un sub-bullet e ogni riga non vuota sotto una
 * voce (`per scelta`, `blocked: ...`, `Motivo:` su una riga a sé) si leggono
 * con la voce: giudicata senza, la voce `per scelta` usciva candidata mentre il
 * contratto la dichiarava chiusa (review della PR corpus 2080). Stessa
 * sezione del contratto, quindi anche lo stesso confine: il primo heading,
 * `###` compreso, la chiude.
 *
 * Unica differenza, e solo in uscita: le righe di servizio (`Closes`/
 * `Addresses #N`, `Follow-up item:`, attribuzione) si tolgono PRIMA di
 * raggruppare, altrimenti diventerebbero la coda dell'ultima voce. Le righe
 * prima del primo bullet, che il contratto ignora, restano item a sé.
 *
 * @param {string} body
 * @returns {Array<{text: string, listLine: boolean}>}
 */
function sectionItems(body) {
  const section = nonImplementedSection(body);
  if (section === null) return [];
  const content = section
    .split('\n')
    .filter((line) => !isTrailer(line.trim().replace(LEADING_MARKER_RE, '').trim()))
    .join('\n');
  return topLevelBullets(content, { includePreamble: true }).map((item) => ({
    text: item.text.replace(LEADING_MARKER_RE, '').trim(),
    listLine: !item.preamble || LIST_MARKER_RE.test(item.text),
  }));
}

// Perché un item non è candidato. `closing-state` ed `empty` sono verdetti;
// `hard-exclude` è il match lessicale di `HARD_EXCLUDE_RES`, che l'oracolo
// dichiara sicuro solo come gate aggregato: bullet per bullet resta un indizio.
function nonCandidateReason(item, state) {
  const closes = state !== null && state !== 'blocked-technical'
    && (state === 'in-this-pr' || state === 'chained-pr' || decisionDeferralSpecificity(item).specific);
  return closes ? 'closing-state' : 'hard-exclude';
}

/**
 * Perché UN bullet non è candidato: `null` se lo è, altrimenti `empty`,
 * `closing-state` (verdetti) o `hard-exclude` (solo un indizio lessicale).
 * Il gate sul conio demota soltanto sui verdetti.
 * @param {string} text @returns {'empty'|'closing-state'|'hard-exclude'|null}
 */
export function nonCandidateVerdict(text) {
  const item = String(text ?? '');
  if (isCandidateItem(item)) return null;
  if (EMPTY_DECLARED_RE.test(item)) return 'empty';
  return nonCandidateReason(item, bulletState(item));
}

// ── Verifica rinviata alla CI della PR (`own-verification`) ───────────
//
// «Vitest in locale — blocked: il resource guard blocca vitest (swap > 85%);
// la CI di questa PR fa da oracolo». `bulletState()` dice `blocked-technical`
// e il bullet è candidato: misurato il 2026-10-03, 13 item su #10433 e 2 su
// #10283 nascono così. Se la run `tests` sull'head della PR ha eseguito quel
// test, l'item nasce già soddisfatto; se NON l'ha eseguito (la CI seleziona i
// test correlati, e i file live-data non girano nel gate PR: è il caso della
// PR 10221) l'item è lavoro vero. Lo stato scritto dall'autore non distingue i
// due casi: li distingue la lettura della run. Lo stato `blocked:` resta
// com'è — la classe e il lookup decidono solo `candidate`, mai il contratto.

// Riconoscimento STRETTO e solo sulla parte dopo `blocked:`. La guardia locale
// deve comparire insieme a cosa ha bloccato (`suite` compresa: «il resource
// guard blocca l'esecuzione…; la stessa suite viene verificata dal percorso CI
// della PR», FU-2026-09-30-005), oppure il rinvio esplicito alla CI come oracolo.
// `swap` da solo non è la guardia («lo swap del dominio»): vale solo accanto a
// una soglia in percentuale («swap > 85%», «swap all'89-92%»).
export const OWN_VERIFICATION_GUARD_RE = /\bresource[-\s]guard\b|\bguardia\s+(?:delle\s+)?risorse\b|\bswap\b[^.;\n]{0,40}?\d+\s*%/i;
export const OWN_VERIFICATION_SUBJECT_RE = /\b(?:vitest|tsc|tests?|suite)\b/i;
export const OWN_VERIFICATION_CI_ORACLE_RE = /\bla\s+CI\s+(?:di\s+questa\s+PR\s+)?(?:fa\s+da|è\s+l['’])\s*oracolo\b/i;
// Una prova che la run `tests` della PR non può dare resta lavoro sospeso,
// anche se il bullet nomina la guardia: deploy, verifica live, «run
// naturale», `live-data gates` (fuori dal gate PR per costruzione), e ogni
// rinvio a una run diversa da quella della PR — cron, run schedulata,
// post-merge, la «prossima run», nightly, dispatch manuale. «dopo il merge» da
// solo non basta a escludere: «la PR #10096 viene ribasata su questa dopo il
// merge» (bucket 10283) è un passo di processo, non una prova.
export const OWN_VERIFICATION_EXCLUDE_RE = /\bdeploy|\blive\b|\brun\s+naturale\b|\bproduzione\b|\bcron\b|\bschedul|\bpost[-\s]?merge\b|\bprossim[ao]\s+run\b|\bnightly\b|\bworkflow_dispatch\b/i;
// La guardia e il soggetto non bastano: il bullet deve rinviare alla CI della
// PR stessa (`CI`, «di questa PR», «della PR»). Tutti i 15 item misurati sui
// bucket 10433 e 10283 lo fanno; un rinvio ad altro resta lavoro sospeso.
export const OWN_VERIFICATION_PR_CI_RE = /\bCI\b|\bquesta\s+PR\b|\bdella\s+PR\b/;
const BLOCKED_DECLARATION_RE = /\bblocked\s*:/i;

/**
 * Vero se il bullet rinvia alla CI della PR una verifica che la guardia delle
 * risorse ha impedito in locale. Solo per lo stato `blocked-technical`.
 * @param {string} text @returns {boolean}
 */
export function isOwnVerificationBullet(text) {
  const item = String(text ?? '');
  if (bulletState(item) !== 'blocked-technical') return false;
  const declaration = BLOCKED_DECLARATION_RE.exec(item);
  if (!declaration) return false;
  const cause = item.slice(declaration.index + declaration[0].length);
  if (OWN_VERIFICATION_EXCLUDE_RE.test(cause)) return false;
  return (OWN_VERIFICATION_GUARD_RE.test(cause) && OWN_VERIFICATION_SUBJECT_RE.test(cause)
    && OWN_VERIFICATION_PR_CI_RE.test(cause))
    || OWN_VERIFICATION_CI_ORACLE_RE.test(cause);
}

const TEST_FILE_RE = /^(?:[A-Za-z0-9_@()[\]+.-]+\/)*[A-Za-z0-9_@()[\]+-][A-Za-z0-9_@()[\]+.-]*\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * I file di test nominati fra backtick nell'INTERO bullet (anche prima di
 * `blocked:`: «Esecuzione vitest locale di `x.test.ts`: blocked: …»), anche
 * dentro un comando (`npx vitest run tests/a.test.ts`). Il nome nudo
 * (`git-commit-data-append-only-sets.test.ts`, PR 10221) conta: ignorarlo
 * farebbe decidere il solo verde della run, che è proprio il caso nascosto.
 * @param {string} text @returns {string[]}
 */
export function namedTestFiles(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(/`([^`\n]+)`/g)) {
    for (const token of match[1].split(/\s+/)) {
      const candidate = normalizeCitedPath(token);
      if (!TEST_FILE_RE.test(candidate) || candidate.split('/').includes('..')) continue;
      if (!found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

// Una riga del log di `gh run view --log`: `<job>\t<step>\t<timestamp> <testo>`.
const RUN_LOG_PREFIX_RE = /^(?:[^\t\n]*\t){2}\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
// I colori del reporter: `gh run view --log` li stampa in notazione caret
// (`^[[32m`, due caratteri stampabili), non come byte ESC. Si tolgono entrambe.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]/g;
const LOGGED_TEST_PATH = String.raw`(\S+\.(?:test|spec)\.[cm]?[jt]sx?)`;
// Il reporter di vitest stampa una riga per file: `✓  node  tests/x.test.ts (3 tests) 12ms`
// (la parola dopo il segno è il project). Solo le righe che INIZIANO col segno:
// il body della PR stampato nel log nomina gli stessi file e non deve contare.
// Senza colori vitest stampa il project fra barre (`✓ |node| tests/x.test.ts`).
const VITEST_PROJECT = String.raw`(?:\|[\w-]+\|\s+|[a-z][\w-]*\s+)?`;
const VITEST_FILE_GREEN_RE = new RegExp(String.raw`^\s*✓\s+${VITEST_PROJECT}${LOGGED_TEST_PATH}\s+\(\d+\s+tests?\b`);
const VITEST_FILE_FAILED_RE = new RegExp(String.raw`^\s*(?:❯|×|✗|FAIL)\s+${VITEST_PROJECT}${LOGGED_TEST_PATH}(?=\s|$)`);

/**
 * L'esito per file del reporter vitest in un log di run.
 * @param {string} logText @returns {Map<string, 'green'|'failed'>}
 */
export function parseVitestFileResults(logText) {
  const results = new Map();
  for (const rawLine of String(logText ?? '').split('\n')) {
    const line = rawLine.replace(ANSI_RE, '').replace(RUN_LOG_PREFIX_RE, '');
    const failed = VITEST_FILE_FAILED_RE.exec(line);
    if (failed) {
      results.set(failed[1], 'failed');
      continue;
    }
    const green = VITEST_FILE_GREEN_RE.exec(line);
    if (green && results.get(green[1]) !== 'failed') results.set(green[1], 'green');
  }
  return results;
}

/**
 * Lo stato di un file nominato nei risultati di una run: un nome nudo vale per
 * il path loggato con lo stesso basename.
 * @returns {'green'|'failed'|'absent'}
 */
export function namedFileStatus(results, file) {
  const statuses = [];
  for (const [logged, status] of results) {
    const matches = file.includes('/') ? logged === file : logged.split('/').at(-1) === file;
    if (matches) statuses.push(status);
  }
  if (statuses.includes('failed')) return 'failed';
  return statuses.includes('green') ? 'green' : 'absent';
}

const OWN_VERIFICATION_VERDICTS = new Set(['executed-green', 'not-executed', 'unknown']);

// Il runner e la cartella dei test per lato: il sito usa vitest sotto
// `tests/`, il corpus `node --test` sotto `generator/tests/` (lo script scende
// identico nel corpus e lì gira con `--side corpus`).
const TEST_RUNNER_BY_SIDE = {
  site: { command: 'npx vitest run', testsDir: 'tests' },
  corpus: { command: 'node --test', testsDir: 'generator/tests' },
};

function ownVerificationOf(item, { pr, side, mergeRunVerdict, existsHere }) {
  const runner = TEST_RUNNER_BY_SIDE[side] ?? TEST_RUNNER_BY_SIDE.site;
  const testFiles = namedTestFiles(item);
  let result;
  try {
    result = typeof mergeRunVerdict === 'function' ? mergeRunVerdict({ pr, testFiles }) : null;
  } catch (error) {
    result = { verdict: 'unknown', why: `lookup-error: ${error?.message || error}` };
  }
  const verdict = OWN_VERIFICATION_VERDICTS.has(result?.verdict) ? result.verdict : 'unknown';
  const ownVerification = {
    verdict,
    runId: result?.runId ?? null,
    testFiles,
    ...(result?.files ? { files: result.files } : {}),
    why: result?.why ?? (result ? 'invalid-verdict' : 'lookup-unavailable'),
  };
  if (verdict !== 'executed-green' && testFiles.length > 0) {
    // La scheda dell'item: un comando che nomina il referente (con una `/`,
    // come chiede la regola D3). Un nome nudo diventa `<cartella dei test>/<nome>`
    // solo se quel file esiste davvero qui.
    const referents = testFiles.map((file) => {
      const inTestsDir = `${runner.testsDir}/${file}`;
      return !file.includes('/') && lookup(existsHere, inTestsDir) === true ? inTestsDir : file;
    });
    ownVerification.command = `${runner.command} ${referents.join(' ')}`;
  }
  return ownVerification;
}

/**
 * Classifica e instrada le righe di `## Non implementato (ancora)`.
 *
 * `kind`: `bullet` (voce di lista: materia di conio), `empty-declared`
 * («Nessuno» da solo, al più con punteggiatura: mai candidato), `prose` (riga
 * non di lista prima del primo bullet: una nota, il bundle non decide per lei).
 * Sub-bullet e continuazioni si accodano alla voce che li precede con la regola
 * del contratto (`sectionItems()`). Le righe di servizio (`Closes|Addresses
 * #N`, `Follow-up item:`, attribuzione) non compaiono.
 *
 * @param {{
 *   pr: {body?: string},
 *   side: 'site'|'corpus',
 *   manifestFiles: Array<object>|null,
 *   existsHere?: (p: string) => boolean|null,
 *   existsTwin?: (p: string) => boolean|null,
 *   mergeRunVerdict?: (q: {pr: object, testFiles: string[]}) =>
 *     {verdict: 'executed-green'|'not-executed'|'unknown', runId?: number|null, why?: string, files?: object[]},
 * }} input
 * @returns {Array<{text: string, kind: 'bullet'|'empty-declared'|'prose', state: string|null,
 *   candidate: boolean, reason: 'closing-state'|'hard-exclude'|'empty'|'verified-by-merge-run'|null,
 *   routes: Array<{path: string, repo: string, targetPath: string, why: string}>,
 *   ownVerification?: {verdict: string, runId: number|null, testFiles: string[], why: string, command?: string}}>}
 *
 * `ownVerification` compare solo sui bullet candidati che rinviano alla CI
 * della PR una verifica bloccata in locale (`isOwnVerificationBullet()`):
 * `executed-green` li toglie dai candidati con `reason: verified-by-merge-run`;
 * `not-executed`/`unknown` li lascia candidati, con il `command` per la scheda.
 * Senza `mergeRunVerdict` il verdetto è `unknown`: mai un verde per default.
 */
export function classifyCandidateBullets({ pr, side, manifestFiles, existsHere, existsTwin, mergeRunVerdict }) {
  const rootFiles = manifestRootFiles(manifestFiles);
  return sectionItems(pr?.body)
    .map(({ text: item, listLine }) => {
      const state = bulletState(item);
      if (EMPTY_DECLARED_RE.test(item)) {
        return { text: item, kind: 'empty-declared', state, candidate: false, reason: 'empty', routes: [] };
      }
      let candidate = isCandidateItem(item);
      let reason = candidate ? null : nonCandidateReason(item, state);
      const ownVerification = candidate && listLine && isOwnVerificationBullet(item)
        ? ownVerificationOf(item, { pr, side, mergeRunVerdict, existsHere })
        : null;
      if (ownVerification?.verdict === 'executed-green') {
        candidate = false;
        reason = 'verified-by-merge-run';
      }
      // Una riga che non si conia non ha un bersaglio da instradare: niente
      // lookup, quindi niente chiamate al gemello.
      const routes = candidate
        ? citedPaths(item, { rootFiles }).map((cited) => ({
          path: cited,
          ...mirrorRoute({ path: cited, side, manifestFiles, existsHere, existsTwin }),
        }))
        : [];
      return {
        text: item,
        kind: listLine ? 'bullet' : 'prose',
        state,
        candidate,
        reason,
        routes,
        ...(ownVerification ? { ownVerification } : {}),
      };
    });
}

/**
 * La sezione del bundle. `entries`: `{ number, bullets }` oppure `{ number, error }`.
 * @param {Array<{number: number|string, bullets?: object[], error?: string}>} entries
 * @param {{manifestOk: boolean, repos?: {site: string, corpus: string}}} meta
 */
/**
 * Le regole con cui il triage legge la sezione. Stanno QUI, nel testo generato
 * accanto ai dati che governano, e non nel prompt del workflow: GitHub rifiuta
 * un prompt block scalar oltre 20.000 caratteri (`PROMPT_SCALAR_LIMIT` in
 * `scripts/ci/validate-modified-workflows.mjs`), e il prompt di
 * `post-merge-followup.yml` ci era arrivato sopra portandosele dentro. Nel
 * prompt resta il riassunto vincolante; il dettaglio viaggia col bundle.
 */
export const CANDIDATE_BULLETS_READING_RULES = Object.freeze([
  '### Regole di lettura',
  '',
  '- `candidate: false` con `reason: closing-state` (`in questa PR` · `PR concatenata #N` · `per scelta` / «falso positivo» · `by construction` · `blocked: decisione del proprietario`) o `reason: empty` («Nessuno» da solo, senza altro testo) → NON creare issue: decide questa sezione, non una rilettura.',
  '- `candidate: false` con `reason: hard-exclude` → è un match LESSICALE, non un verdetto: il triage applica le proprie regole hard-exclude, compresa l\'eccezione del residuo che mescola una prova live con un\'edit concreta (quello resta actionable).',
  '- `candidate: true` significa AMMISSIBILE, non «da coniare»: l\'item passa comunque dai filtri successivi (hard-exclude, condizione di accettazione, dedup, in-flight overlap).',
  '- `candidate: true` con `blocked: <causa>` → resta candidato; la causa va nel campo `Blocked on:` dell\'item. Se la causa NON è di codice (fonte esterna, terzi, decisione attesa) l\'item si conia con `State: blocked`: resta tracciato e non entra nella selezione del fixer.',
  '- `candidate: true` senza stato → resta candidato (fail-safe: un residuo non qualificato è lavoro potenzialmente dovuto, e tacerlo è peggio che generare una traccia).',
  '- `candidate: false` con `reason: verified-by-merge-run` (verifica rinviata alla CI della PR, `ownVerification.verdict: executed-green`: la run `tests` sull\'head della PR è verde e ha eseguito verdi i file di test citati) → NON creare issue; il commento di triage cita la run `ownVerification.runId`. Con `ownVerification.verdict: not-executed|unknown` il bullet resta candidato: se lo conii, la scheda dell\'item porta `COMANDO: <ownVerification.command>` quando c\'è.',
  '- Solo `kind: bullet` è materia di conio decisa da questa sezione. `kind: prose` è una riga non di lista prima del primo bullet (una nota; le continuazioni sono già dentro la voce, come le legge il contratto): va letta come contesto e coniata solo se da sola descrive lavoro residuo. Le righe di servizio (`Closes`/`Addresses #N`, `Follow-up item:`) non sono in questa sezione e non si coniano.',
]);

export function renderCandidateBulletsSection(entries, { manifestOk, repos = DEFAULT_REPOS }) {
  const lines = [
    '## Candidate bullets',
    '',
    'Righe di `## Non implementato (ancora)` già classificate da `scripts/ci/followup-candidate-bullets.mjs`.',
    '`kind: bullet` = voce di lista con le sue continuazioni; `empty-declared` = «Nessuno» da solo; `prose` = riga non di lista prima del primo bullet (contesto).',
    '`candidate: false` con `reason: closing-state|empty|verified-by-merge-run` = non coniare; `reason: hard-exclude` = match lessicale, da confermare.',
    '`candidate: true` = ammissibile, soggetto ai filtri del triage. `routes[].repo` + `targetPath` = `Target repository` + `Target file`',
    `(\`site\` = ${repos.site}, \`corpus\` = ${repos.corpus}, \`unknown\` = non verificato).`,
    `Manifest di mirror: ${manifestOk ? 'letto' : 'NON leggibile (ogni route è `unknown`)'}.`,
    '',
    ...CANDIDATE_BULLETS_READING_RULES,
    '',
  ];
  for (const entry of entries) {
    lines.push(`### PR #${entry.number}`, '```json');
    lines.push(JSON.stringify(entry.error ? { error: entry.error } : entry.bullets, null, 1));
    lines.push('```', '');
  }
  return lines.join('\n');
}

// ── I/O ─────────────────────────────────────────────────────────────

function ghApi(args) {
  return execFileSync('gh', ['api', ...args], {
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const contentsUrl = (repo, filePath) =>
  `repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=main`;

/** Il manifest dal repository del corpus, o `null` se non si legge. */
export function fetchManifestFiles(corpusRepo, api = ghApi) {
  try {
    const raw = api(['-H', 'Accept: application/vnd.github.raw', contentsUrl(corpusRepo, MANIFEST_PATH)]);
    const files = JSON.parse(raw)?.files;
    return Array.isArray(files) ? files : null;
  } catch {
    return null;
  }
}

export function readManifestFile(file) {
  try {
    const files = JSON.parse(fs.readFileSync(file, 'utf8'))?.files;
    return Array.isArray(files) ? files : null;
  } catch {
    return null;
  }
}

/** `git cat-file -e HEAD:<path>` nel checkout corrente. */
export function gitExistsHere(filePath) {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${filePath}`], { stdio: 'ignore' });
    return true;
  } catch (error) {
    // Uno status numerico è la risposta di git («non esiste»); l'assenza di
    // status è un guasto del processo, cioè «non lo so».
    return typeof error?.status === 'number' ? false : null;
  }
}

/**
 * Lookup `contents` sul gemello con cache e tetto. 404 → `false`; qualunque
 * altro errore, o il tetto raggiunto → `null` (→ `unknown`, mai un verdetto).
 */
export function createTwinLookup({ repo, cap = DEFAULT_TWIN_LOOKUP_CAP, api = ghApi }) {
  const cache = new Map();
  let calls = 0;
  return (filePath) => {
    if (cache.has(filePath)) return cache.get(filePath);
    if (calls >= cap) return null;
    calls += 1;
    let result;
    try {
      api(['--silent', contentsUrl(repo, filePath)]);
      result = true;
    } catch (error) {
      const detail = `${error?.stderr ?? ''}${error?.message ?? ''}`;
      result = /HTTP 404|Not Found/i.test(detail) ? false : null;
    }
    cache.set(filePath, result);
    return result;
  };
}

export const DEFAULT_TESTS_WORKFLOW = 'tests.yml';
const DEFAULT_RUN_LOG_CAP = 6;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;

function ghCli(args) {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * `mergeRunVerdict({ pr, testFiles })` per i bullet `own-verification`: legge
 * la run del workflow `tests` sull'head SHA della PR (`pr.headRefOid`).
 *
 * - nessun file nominato: `executed-green` se una run completata è `success`
 *   (è l'oracolo che il bullet stesso dichiara);
 * - file nominati: `executed-green` solo se in UNA run `success` ogni file ha
 *   la sua riga verde del reporter vitest. Una run verde che non l'ha eseguito
 *   (selezione dei test correlati, file live-data fuori dal gate PR) dà
 *   `not-executed`: il test è ancora da eseguire;
 * - nessuna run `success` → `not-executed` (`why: run-<conclusion>`);
 * - qualunque errore, run assente, tetto dei log raggiunto → `unknown`.
 *
 * Una `gh run list` per SHA e una `gh run view --log` per run, entrambe in
 * cache; le letture dei log hanno un tetto per batch (`logCap`): oltre, il
 * verdetto è `unknown`, mai un verde.
 */
export function createMergeRunLookup({
  repo, workflow = DEFAULT_TESTS_WORKFLOW, logCap = DEFAULT_RUN_LOG_CAP, gh = ghCli,
}) {
  const runsBySha = new Map();
  const resultsByRun = new Map();
  let logReads = 0;

  const listRuns = (sha) => {
    if (!runsBySha.has(sha)) {
      let runs = null;
      try {
        const parsed = JSON.parse(gh([
          'run', 'list', '--repo', repo, '--workflow', workflow, '--commit', sha,
          '--limit', '20', '--json', 'databaseId,conclusion,status,createdAt',
        ]));
        runs = Array.isArray(parsed) ? parsed : null;
      } catch {
        runs = null;
      }
      runsBySha.set(sha, runs);
    }
    return runsBySha.get(sha);
  };

  // `undefined` = tetto raggiunto (non letto, non in cache); `null` = errore.
  const runResults = (runId) => {
    if (resultsByRun.has(runId)) return resultsByRun.get(runId);
    if (logReads >= logCap) return undefined;
    logReads += 1;
    let results = null;
    try {
      results = parseVitestFileResults(gh(['run', 'view', String(runId), '--repo', repo, '--log']));
    } catch {
      results = null;
    }
    resultsByRun.set(runId, results);
    return results;
  };

  return ({ pr, testFiles = [] }) => {
    const sha = typeof pr?.headRefOid === 'string' && HEAD_SHA_RE.test(pr.headRefOid) ? pr.headRefOid : null;
    if (!sha) return { verdict: 'unknown', runId: null, why: 'head-sha-unavailable' };
    const runs = listRuns(sha);
    if (!runs) return { verdict: 'unknown', runId: null, why: 'run-list-failed' };
    const completed = runs
      .filter((run) => run?.status === 'completed' && Number.isInteger(run.databaseId))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    if (completed.length === 0) return { verdict: 'unknown', runId: null, why: 'no-completed-run' };
    const green = completed.filter((run) => run.conclusion === 'success');
    if (green.length === 0) {
      return { verdict: 'not-executed', runId: completed[0].databaseId, why: `run-${completed[0].conclusion || 'unknown'}` };
    }
    if (testFiles.length === 0) return { verdict: 'executed-green', runId: green[0].databaseId, why: 'run-success' };

    let firstFiles = null;
    let firstRunId = green[0].databaseId;
    let incomplete = null;
    for (const run of green) {
      const results = runResults(run.databaseId);
      if (results === undefined) {
        incomplete = 'log-cap-reached';
        break;
      }
      if (results === null) {
        incomplete = 'log-read-failed';
        continue;
      }
      const files = testFiles.map((file) => ({ file, status: namedFileStatus(results, file) }));
      if (files.every((entry) => entry.status === 'green')) {
        return { verdict: 'executed-green', runId: run.databaseId, why: 'files-green-in-log', files };
      }
      if (!firstFiles) {
        firstFiles = files;
        firstRunId = run.databaseId;
      }
    }
    if (incomplete) {
      return { verdict: 'unknown', runId: firstRunId, why: incomplete, ...(firstFiles ? { files: firstFiles } : {}) };
    }
    return { verdict: 'not-executed', runId: firstRunId, why: 'files-not-green-in-log', files: firstFiles };
  };
}

function parseArgs(argv) {
  const options = { side: process.env.FOLLOWUP_SIDE || 'site', manifest: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--side') options.side = argv[++i];
    else if (argv[i] === '--manifest') options.manifest = argv[++i];
    else options.files.push(argv[i]);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const { side, manifest, files } = parseArgs(argv);
  if (side !== 'site' && side !== 'corpus') {
    console.error(`followup-candidate-bullets: --side deve essere site|corpus (ricevuto: ${side})`);
    return 2;
  }
  const repos = {
    site: process.env.FOLLOWUP_SITE_REPO || DEFAULT_REPOS.site,
    corpus: process.env.FOLLOWUP_CORPUS_REPO || DEFAULT_REPOS.corpus,
  };
  const manifestFiles = manifest ? readManifestFile(manifest) : fetchManifestFiles(repos.corpus);
  if (!manifestFiles) {
    console.error('::warning::followup-candidate-bullets: manifest di mirror non leggibile, ogni route è unknown');
  }
  const cap = Number.parseInt(process.env.FOLLOWUP_TWIN_LOOKUP_CAP || '', 10);
  const existsTwin = createTwinLookup({
    repo: repos[twinOf(side)],
    cap: Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_TWIN_LOOKUP_CAP,
  });

  // Il lookup della run `tests` è cablato sul sito. Sul corpus il workflow ha
  // un altro nome: si accende solo se `FOLLOWUP_TESTS_WORKFLOW` lo dichiara,
  // altrimenti i bullet `own-verification` restano `unknown`, cioè candidati.
  const testsWorkflow = process.env.FOLLOWUP_TESTS_WORKFLOW || (side === 'site' ? DEFAULT_TESTS_WORKFLOW : '');
  const logCap = Number.parseInt(process.env.FOLLOWUP_MERGE_RUN_LOG_CAP || '', 10);
  const mergeRunVerdict = testsWorkflow
    ? createMergeRunLookup({
      repo: repos[side],
      workflow: testsWorkflow,
      logCap: Number.isInteger(logCap) && logCap >= 0 ? logCap : DEFAULT_RUN_LOG_CAP,
    })
    : null;

  const entries = files.map((file) => {
    const fallbackNumber = /(\d+)\.json$/.exec(path.basename(file))?.[1] ?? file;
    try {
      const pr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof pr?.body !== 'string') return { number: pr?.number ?? fallbackNumber, error: 'pr-body-unavailable' };
      return {
        number: pr.number ?? fallbackNumber,
        bullets: classifyCandidateBullets({
          pr, side, manifestFiles, existsHere: gitExistsHere, existsTwin, mergeRunVerdict,
        }),
      };
    } catch (error) {
      return { number: fallbackNumber, error: `pr-json-unreadable: ${error?.message || error}` };
    }
  });
  process.stdout.write(`${renderCandidateBulletsSection(entries, { manifestOk: Boolean(manifestFiles), repos })}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
