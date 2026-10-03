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
import { bulletState, decisionDeferralSpecificity } from '../lib/pr-body-sections-check.mjs';
import { extractNonImplementedItems, isCandidateItem } from './followup-has-candidates.mjs';

export const MANIFEST_PATH = 'scripts/ci/loop-sync-manifest.json';
const DEFAULT_REPOS = Object.freeze({
  site: 'valerielinc-ops/frontaliere-si-o-no',
  corpus: 'nanakokyobashi-rgb/frontaliere-articles',
});
const DEFAULT_TWIN_LOOKUP_CAP = 40;

// ── Logica pura ─────────────────────────────────────────────────────

const twinOf = (side) => (side === 'site' ? 'corpus' : 'site');

/** `./a/b.ts:12` → `a/b.ts`. */
export function normalizeCitedPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/:\d+(?:[-:]\d+)*$/, '');
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
 * I path citati fra backtick in un bullet: almeno una `/`, un'estensione,
 * nessuno spazio, nessun glob e nessun segmento `..`.
 * @param {string} text
 * @returns {string[]}
 */
export function citedPaths(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(/`([^`\n]+)`/g)) {
    const candidate = normalizeCitedPath(match[1]);
    if (!SAFE_PATH_RE.test(candidate) || !FILE_EXT_RE.test(candidate)) continue;
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

// «Nessuno — snapshot automatizzato, senza residui.»: la sezione dichiara di
// essere vuota e ne dà il motivo. La parola deve essere seguita da un segno,
// non da altro testo: «Nessuno dei sibling è stato corretto» resta un residuo.
const EMPTY_DECLARED_RE = /^[*_`]*(?:nessuno|niente|none|nothing)[*_`]*\s*(?:$|[.:;,(—–-])/i;

const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
// Stessa normalizzazione di `extractNonImplementedItems()`: serve solo a
// riconoscere, fra gli item che l'oracolo restituisce, quelli nati da una riga
// di lista.
const oracleForm = (line) => line.replace(/^\s*[-*]\s+/, '').trim();

function listItemForms(body) {
  const forms = new Set();
  for (const line of String(body ?? '').split('\n')) {
    if (LIST_MARKER_RE.test(line)) forms.add(oracleForm(line));
  }
  return forms;
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
 * Classifica e instrada le righe di `## Non implementato (ancora)`.
 *
 * `kind`: `bullet` (riga di lista: materia di conio), `empty-declared`
 * («Nessuno» con motivo: mai candidato), `prose` (riga non di lista:
 * continuazione o nota, il bundle non decide per lei). Le righe di servizio
 * (`Closes|Addresses #N`, `Follow-up item:`, attribuzione) non compaiono.
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
  const listForms = listItemForms(pr?.body);
  return extractNonImplementedItems(pr?.body)
    .filter((item) => !isTrailer(item))
    .map((item) => {
      const state = bulletState(item);
      if (EMPTY_DECLARED_RE.test(item)) {
        return { text: item, kind: 'empty-declared', state, candidate: false, reason: 'empty', routes: [] };
      }
      const candidate = isCandidateItem(item);
      // Una riga che non si conia non ha un bersaglio da instradare: niente
      // lookup, quindi niente chiamate al gemello.
      const routes = candidate
        ? citedPaths(item).map((cited) => ({
          path: cited,
          ...mirrorRoute({ path: cited, side, manifestFiles, existsHere, existsTwin }),
        }))
        : [];
      return {
        text: item,
        kind: listForms.has(item) ? 'bullet' : 'prose',
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
export function renderCandidateBulletsSection(entries, { manifestOk, repos = DEFAULT_REPOS }) {
  const lines = [
    '## Candidate bullets',
    '',
    'Righe di `## Non implementato (ancora)` già classificate da `scripts/ci/followup-candidate-bullets.mjs`.',
    '`kind: bullet` = riga di lista; `empty-declared` = «Nessuno» con motivo; `prose` = riga non di lista (contesto).',
    '`candidate: false` con `reason: closing-state|empty` = non coniare; `reason: hard-exclude` = match lessicale, da confermare.',
    '`candidate: true` = ammissibile, soggetto ai filtri del triage. `routes[].repo` + `targetPath` = `Target repository` + `Target file`',
    `(\`site\` = ${repos.site}, \`corpus\` = ${repos.corpus}, \`unknown\` = non verificato).`,
    `Manifest di mirror: ${manifestOk ? 'letto' : 'NON leggibile (ogni route è `unknown`)'}.`,
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
