#!/usr/bin/env node
/**
 * decompose-route-check.mjs — osservatore deterministico (zero-Claude) dello
 * stadio decompose: una figlia aperta nel SITO deve nominare file del sito.
 *
 * Il difetto. Il job `decompose` di `issue-decompose.yml` fa creare le figlie
 * all'agente e dopo non c'era alcun passo che controllasse DOVE vive il file
 * nominato dalla scheda. Il 02-10 il decompose ha aperto nel sito la 10925
 * (`scripts/ci/generator-ci-gate.mjs`) e la 10923 (`scripts/lib/corpus-floors.mjs`):
 * file assenti nel sito, presenti nel corpus e lì già corretti il 22-24/09.
 * Entrambe le schede avevano come FIX «ritargettare al repository owner-correct»,
 * cioè una figlia che nessun fixer del sito può chiudere. DECISIONS 2026-09-23:
 * la issue si crea o si migra nel repository proprietario.
 *
 * La prevenzione vive nel prompt del decompose (routing nel corpus prima della
 * creazione). Questo script è il backstop che vede la figlia sfuggita:
 *   - legge le figlie dal marker `DECOMPOSED_INTO` del padre (stesso parser del
 *     PARENT-CLOSE del drainer, `decomposedChildNumbers`, importato dal modulo
 *     puro `lib/parent-close-recurrence.mjs` e non dal drainer: il job
 *     `decompose` gira senza `npm ci` e con un profilo sparse ristretto);
 *   - estrae dal corpo i token con forma di path del repository (`extractRepoPaths`);
 *   - MISROUTED se e solo se almeno un path è ASSENTE nel sito e PRESENTE su
 *     `main` del corpus, e nessun path nominato esiste nel sito (una figlia
 *     che tocca anche file del sito resta del sito). Un path assente in
 *     entrambi è un file nuovo: nessuna decisione. Prima di tutto una sonda su un path che nel corpus esiste di
 *     certo: se fallisce, il corpus non è leggibile con questo token e la run
 *     non decide niente (una riga di log, zero scritture);
 *   - su una figlia misrouted: label `keep-open` (in `FIXER_EXEMPT_LABELS`:
 *     fixer e triage la saltano), via `agent:fix`/`agent:fix-queued`/
 *     `agent:decompose-queued`, richiesta di migrazione sul digest del
 *     proprietario, marker `DECOMPOSE_MISROUTED` sulla figlia. Mai
 *     `automation-deferred` (rientrerebbe nello sweep), mai chiusure, mai issue
 *     in altri repository.
 *
 * Esce SEMPRE 0. Conteggio nello step summary e `misrouted=<n>` su GITHUB_OUTPUT.
 *
 * Env: ISSUE_NUMBER (padre), GH_REPO (sito, default GITHUB_REPOSITORY),
 * GH_TOKEN, CORPUS_REPO (default il corpus), DRY_RUN=1 → nessuna scrittura.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decomposedChildNumbers } from './lib/parent-close-recurrence.mjs';

export const CORPUS_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
/** Path che nel corpus esiste di certo (manifest del mirror): la sonda di leggibilità. */
export const CORPUS_PROBE_PATH = 'scripts/ci/loop-sync-manifest.json';
export const OWNER_DIGEST_TITLE = '🧭 Decisioni del proprietario — digest';
export const PIN_LABEL = 'keep-open';
export const ROUTING_LABELS = Object.freeze(['agent:fix', 'agent:fix-queued', 'agent:decompose-queued']);
export const MISROUTED_MARKER_RE = /<!--\s*DECOMPOSE_MISROUTED:/;
// `engine/` e `host/` esistono solo nel corpus (host/ è la metà del
// SiteShellContract); `services/` esiste in entrambi e decide l'esistenza.
export const REPO_PATH_PREFIXES = Object.freeze([
  'scripts', '.github', 'tests', 'generator', 'packages', 'functions', 'build-plugins',
  'engine', 'host', 'services',
]);

const PREFIX_ALT = REPO_PATH_PREFIXES.map((p) => p.replace(/\./g, '\\.')).join('|');
// Un token che inizia con uno dei prefissi e finisce con un'estensione. Il
// lookbehind esclude i path annidati in un URL o in un altro path (`blob/main/scripts/…`),
// il lookahead taglia `:riga`, la punteggiatura finale e i backtick.
const REPO_PATH_RE = new RegExp(
  `(?<![\\w./-])((?:${PREFIX_ALT})/[\\w./-]*\\w\\.[A-Za-z0-9]{1,6})(?![\\w/-])`,
  'g',
);

/** Path del repository nominati in un corpo di issue (unici, ordinati). Pura. */
export function extractRepoPaths(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(REPO_PATH_RE)) {
    const p = m[1];
    if (p.includes('..') || p.includes('//')) continue;
    out.add(p);
  }
  return [...out].sort();
}

/**
 * Verdetto di instradamento di una figlia. Pura.
 *
 * Basta UN path presente nel sito perché la figlia resti del sito: una scheda
 * che porta nel sito un costrutto del corpus (o lo cita come riferimento)
 * nomina legittimamente anche file che vivono solo lì, e pinnarla la
 * toglierebbe dalla coda di fix senza motivo. Misrouted è la figlia i cui
 * file esistenti vivono TUTTI solo nel corpus (10925, 10923); i path assenti
 * in entrambi sono file nuovi e non pesano.
 * @param {string[]} paths
 * @param {Record<string, boolean|null>} siteHas   true/false; null = non letto
 * @param {Record<string, boolean|null>} corpusHas true/false; null = non letto
 * @returns {{verdict: 'misrouted'|'ok'|'no-paths', corpusOnly: string[]}}
 */
export function classifyChildRoute(paths, siteHas, corpusHas) {
  if (!paths.length) return { verdict: 'no-paths', corpusOnly: [] };
  const corpusOnly = paths.filter((p) => siteHas[p] === false && corpusHas[p] === true);
  if (paths.some((p) => siteHas[p] === true)) return { verdict: 'ok', corpusOnly };
  return { verdict: corpusOnly.length ? 'misrouted' : 'ok', corpusOnly };
}

export function misroutedComment(paths, corpusRepo = CORPUS_REPOSITORY) {
  return [
    `<!-- DECOMPOSE_MISROUTED: paths=${paths.join(',')} repo=${corpusRepo} -->`,
    '🧭 **Figlia aperta nel repository sbagliato** (osservatore deterministico `decompose-route-check`).',
    '',
    `I file che questa scheda nomina non esistono in questo repository ed esistono su \`main\` di \`${corpusRepo}\`:`,
    ...paths.map((p) => `- \`${p}\``),
    '',
    `Il fixer del sito non può chiuderla: la issue va migrata nel corpus (DECISIONS 2026-09-23) e questa chiusa con evidenza. Pinnata con \`${PIN_LABEL}\` e tolta dalla coda di fix; la migrazione è chiesta sul digest del proprietario.`,
  ].join('\n');
}

export function migrationRequestComment(issueNumber, paths, corpusRepo = CORPUS_REPOSITORY) {
  return [
    `<!-- DECOMPOSE_MIGRATION_REQUEST: issue=${issueNumber} -->`,
    `Decompose: figlia aperta nel repository sbagliato (file presenti solo nel corpus) — #${issueNumber}.`,
    `Migrare nel corpus \`${corpusRepo}\` e chiudere l'errata con evidenza. File: ${paths.map((p) => `\`${p}\``).join(', ')}.`,
  ].join('\n');
}

const labelNames = (labels) => (labels || []).map((l) => String(typeof l === 'string' ? l : l?.name ?? ''));

/**
 * Esegue il controllo. Tutto l'I/O passa da `io`, così i test lo sostituiscono.
 * io: parentComments(n) → [{body}], child(n) → {number,state,body,labels,comments}|null,
 *     siteHas(path) → bool|null, corpusHas(path) → bool|null, findDigest() → number|null,
 *     comment(n, body), editLabels(n, {add, remove}), log(line)
 */
export function runRouteCheck({ parentNumber, io, dryRun = false, corpusRepo = CORPUS_REPOSITORY }) {
  const result = { children: 0, checked: 0, misrouted: [], undecided: false, writes: 0 };
  let kids;
  try {
    kids = decomposedChildNumbers(io.parentComments(parentNumber) || []);
  } catch (e) {
    io.log(`commenti del padre #${parentNumber} illeggibili (${e.message}): nessuna decisione.`);
    result.undecided = true;
    return result;
  }
  result.children = kids.length;
  if (!kids.length) {
    io.log(`#${parentNumber}: nessun marker DECOMPOSED_INTO, niente da controllare.`);
    return result;
  }
  if (io.corpusHas(CORPUS_PROBE_PATH) !== true) {
    io.log(`sonda del corpus fallita (${corpusRepo}:${CORPUS_PROBE_PATH} non leggibile con questo token): nessuna decisione per questa run.`);
    result.undecided = true;
    return result;
  }
  const write = (fn) => {
    if (dryRun) return;
    fn();
    result.writes += 1;
  };
  for (const n of kids) {
    const child = io.child(n);
    if (!child) { io.log(`#${n}: illeggibile, salto.`); continue; }
    if (String(child.state || '').toUpperCase() !== 'OPEN') continue;
    if ((child.comments || []).some((c) => MISROUTED_MARKER_RE.test(String(c?.body || '')))) {
      io.log(`#${n}: già marcata DECOMPOSE_MISROUTED, salto.`);
      continue;
    }
    result.checked += 1;
    const paths = extractRepoPaths(child.body);
    const siteHas = {};
    const corpusHas = {};
    for (const p of paths) siteHas[p] = io.siteHas(p);
    // Un path del sito decide già «ok»: il corpus si interroga solo se serve.
    const anySite = paths.some((p) => siteHas[p] === true);
    for (const p of paths) corpusHas[p] = !anySite && siteHas[p] === false ? io.corpusHas(p) : null;
    const { verdict, corpusOnly } = classifyChildRoute(paths, siteHas, corpusHas);
    io.log(`#${n}: ${verdict}${corpusOnly.length ? ` (${corpusOnly.join(', ')})` : ''}`);
    if (verdict !== 'misrouted') continue;
    result.misrouted.push({ number: n, paths: corpusOnly });
    // Una scrittura che fallisce (label mancante, 5xx) resta confinata a
    // questa figlia: le altre vanno comunque controllate, e senza il marker
    // finale il ri-lancio successivo ritenta da capo.
    try {
      const present = new Set(labelNames(child.labels));
      const remove = ROUTING_LABELS.filter((l) => present.has(l));
      write(() => io.editLabels(n, { add: [PIN_LABEL], remove }));
      const digest = io.findDigest();
      if (digest) write(() => io.comment(digest, migrationRequestComment(n, corpusOnly, corpusRepo)));
      else io.log(`digest «${OWNER_DIGEST_TITLE}» assente: richiesta di migrazione per #${n} non postata.`);
      // Il marker sulla figlia va per ultimo: è il record di «fatto» che rende
      // idempotente un ri-lancio.
      write(() => io.comment(n, misroutedComment(corpusOnly, corpusRepo)));
    } catch (e) {
      io.log(`#${n}: scrittura fallita (${e?.message || e}), proseguo con le altre figlie.`);
    }
  }
  return result;
}

// ─── I/O reale (gh + git) ─────────────────────────────────────────────────

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}

function siteHasPath(p) {
  // `ls-tree` legge solo gli alberi: in un checkout blobless non scarica blob
  // e vede anche i path esclusi dal profilo sparse.
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', '--', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').includes(p);
  } catch {
    return null;
  }
}

function corpusHasPath(corpusRepo, p) {
  const encoded = p.split('/').map(encodeURIComponent).join('/');
  try {
    execFileSync('gh', ['api', `repos/${corpusRepo}/contents/${encoded}?ref=main`, '--jq', '.sha'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (e) {
    const err = `${e?.stderr || ''} ${e?.stdout || ''}`;
    return /HTTP 404|Not Found/i.test(err) ? false : null;
  }
}

function realIo({ repo, corpusRepo }) {
  return {
    parentComments: (n) => ghJson(['issue', 'view', String(n), '--repo', repo, '--json', 'comments']).comments,
    child: (n) => {
      try {
        return ghJson(['issue', 'view', String(n), '--repo', repo, '--json', 'number,state,body,labels,comments']);
      } catch {
        return null;
      }
    },
    siteHas: siteHasPath,
    corpusHas: (p) => corpusHasPath(corpusRepo, p),
    findDigest: () => {
      try {
        const rows = ghJson(['issue', 'list', '--repo', repo, '--state', 'open', '--search', `"${OWNER_DIGEST_TITLE}" in:title`, '--json', 'number,title', '--limit', '20']);
        return rows.find((r) => r.title === OWNER_DIGEST_TITLE)?.number ?? null;
      } catch {
        return null;
      }
    },
    comment: (n, body) => {
      execFileSync('gh', ['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], { input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    },
    editLabels: (n, { add, remove }) => {
      const args = ['issue', 'edit', String(n), '--repo', repo];
      for (const l of add) args.push('--add-label', l);
      for (const l of remove) args.push('--remove-label', l);
      execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    },
    log: (line) => console.log(line),
  };
}

function main() {
  const parent = Number(process.env.ISSUE_NUMBER);
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const corpusRepo = process.env.CORPUS_REPO || CORPUS_REPOSITORY;
  let result = { children: 0, checked: 0, misrouted: [], undecided: true, writes: 0 };
  if (!Number.isInteger(parent) || parent <= 0 || !repo) {
    console.log('ISSUE_NUMBER o GH_REPO mancanti: nessuna decisione.');
  } else {
    try {
      result = runRouteCheck({ parentNumber: parent, io: realIo({ repo, corpusRepo }), dryRun: process.env.DRY_RUN === '1', corpusRepo });
    } catch (e) {
      console.log(`decompose-route-check: errore (${e.message}), nessuna ulteriore decisione.`);
    }
  }
  const n = result.misrouted.length;
  const summary = [
    '### Decompose route check',
    `figlie=${result.children} controllate=${result.checked} misrouted=${n}${result.undecided ? ' (nessuna decisione)' : ''}`,
    ...result.misrouted.map((m) => `- #${m.number}: ${m.paths.join(', ')}`),
  ].join('\n');
  console.log(summary);
  try {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `misrouted=${n}\n`);
  } catch { /* osservatore: mai rosso */ }
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (isMain) main();
