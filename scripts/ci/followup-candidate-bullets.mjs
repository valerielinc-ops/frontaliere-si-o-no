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
 * Env: FOLLOWUP_SITE_REPO, FOLLOWUP_CORPUS_REPO (slug), FOLLOWUP_TWIN_LOOKUP_CAP.
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
 * }} input
 * @returns {Array<{text: string, kind: 'bullet'|'empty-declared'|'prose', state: string|null,
 *   candidate: boolean, reason: 'closing-state'|'hard-exclude'|'empty'|null,
 *   routes: Array<{path: string, repo: string, targetPath: string, why: string}>}>}
 */
export function classifyCandidateBullets({ pr, side, manifestFiles, existsHere, existsTwin }) {
  const rootFiles = manifestRootFiles(manifestFiles);
  return sectionItems(pr?.body)
    .map(({ text: item, listLine }) => {
      const state = bulletState(item);
      if (EMPTY_DECLARED_RE.test(item)) {
        return { text: item, kind: 'empty-declared', state, candidate: false, reason: 'empty', routes: [] };
      }
      const candidate = isCandidateItem(item);
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
        reason: candidate ? null : nonCandidateReason(item, state),
        routes,
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
  '- Solo `kind: bullet` è materia di conio decisa da questa sezione. `kind: prose` è una riga non di lista prima del primo bullet (una nota; le continuazioni sono già dentro la voce, come le legge il contratto): va letta come contesto e coniata solo se da sola descrive lavoro residuo. Le righe di servizio (`Closes`/`Addresses #N`, `Follow-up item:`) non sono in questa sezione e non si coniano.',
]);

export function renderCandidateBulletsSection(entries, { manifestOk, repos = DEFAULT_REPOS }) {
  const lines = [
    '## Candidate bullets',
    '',
    'Righe di `## Non implementato (ancora)` già classificate da `scripts/ci/followup-candidate-bullets.mjs`.',
    '`kind: bullet` = voce di lista con le sue continuazioni; `empty-declared` = «Nessuno» da solo; `prose` = riga non di lista prima del primo bullet (contesto).',
    '`candidate: false` con `reason: closing-state|empty` = non coniare; `reason: hard-exclude` = match lessicale, da confermare.',
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
  // Un 404 dice «non c'e'» solo se il gemello si legge con questo token: l'API
  // risponde 404 anche a un token senza accesso. Una prova del ref per run,
  // solo dopo il primo 404; se non risponde ogni 404 vale `null`.
  let readable;
  const twinReadable = () => {
    if (readable === undefined) {
      try {
        api(['--silent', `repos/${repo}/commits/main`]);
        readable = true;
      } catch {
        readable = false;
      }
    }
    return readable;
  };
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
      result = /HTTP 404|Not Found/i.test(detail) && twinReadable() ? false : null;
    }
    cache.set(filePath, result);
    return result;
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

  const entries = files.map((file) => {
    const fallbackNumber = /(\d+)\.json$/.exec(path.basename(file))?.[1] ?? file;
    try {
      const pr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof pr?.body !== 'string') return { number: pr?.number ?? fallbackNumber, error: 'pr-body-unavailable' };
      return {
        number: pr.number ?? fallbackNumber,
        bullets: classifyCandidateBullets({ pr, side, manifestFiles, existsHere: gitExistsHere, existsTwin }),
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
