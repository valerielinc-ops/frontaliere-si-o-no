#!/usr/bin/env node
/**
 * reconcile-conflict-handoffs.mjs — chiude gli hand-off di conflitto il cui
 * lavoro e' gia' fatto (zero-Claude).
 *
 * `pr-autorebase.mjs` apre «Conflitto con main[ dopo LGTM]: riapplicare la PR
 * #N su main» e la affida a issue-fix. L'unica via di chiusura era il `Closes`
 * della PR di riapplicazione. Quando invece il conflitto rientra sul branch
 * originale e #N mergia, nessuno la chiudeva: il pre-flight di issue-fix
 * toglieva `agent:fix` e «non chiudo», il drainer gira con
 * `FOLLOWUP_NO_AUTOCLOSE=1`, il bridge del fixer non puo' chiudere issue.
 * Misurato il 2026-10-01: 5 hand-off aperti su 8 avevano la PR di origine gia'
 * mergiata (#10383 #10385 #10444 #10536 #10657), piu' un duplicato nato da due
 * run concorrenti di pr-autorebase (#10587 di #10586). Il pre-flight ora chiude
 * da se' (`closeResolvedHandoff`), ma gira solo quando issue-fix parte: questo
 * sweep copre gli hand-off che nessuno rilancia.
 *
 * Ogni tick (followup-drainer.yml, prima del drain) per ogni hand-off aperto:
 *   1. duplicati della stessa PR di origine → resta quella con un claim o una
 *      PR in volo, poi quella instradata al fixer, poi la piu' vecchia
 *      (`electHandoffKeeper`); le altre chiuse `duplicate`, ma non prima di
 *      `MIN_DUPLICATE_AGE_MINUTES` dalla loro creazione;
 *   2. una PR mergiata dichiara `Closes #<issue>` o `Supersedes #N` → chiusa
 *      `completed` (riapplicazione mergiata, keyword non eseguita da GitHub);
 *   3. la PR di origine e' MERGED → chiusa `completed`;
 *   4. la PR di origine e' OPEN, il conflitto e' rientrato (`handoffResolution`,
 *      la stessa regola del pre-flight: mergeable E `has-conflicts` tolta da
 *      pr-autorebase dopo l'apertura dell'hand-off, cioe' merge-tree pulito) e
 *      nessuna PR la sta riapplicando → chiusa `completed`;
 *   5. la PR di origine e' CLOSED senza merge da piu' di 24 ore e nessuna PR la
 *      riapplica: patch applicata su main hunk per hunk → `completed`; altrimenti
 *      `not planned` (superato) solo se l'hand-off non e' instradato e le issue
 *      che l'origine chiudeva non restano orfane (`decideClosedOrigin`);
 *   altrimenti resta aperta: c'e' ancora un contributo da riapplicare.
 * Solo segnali deterministici: stato GitHub della PR, eventi della label
 * `has-conflicts` scritta da merge-tree, keyword di una PR mergiata e, per
 * un'origine chiusa, l'applicazione al contrario di OGNI hunk su main (mai
 * una soglia, mai la sola presenza delle righe). Un hand-off con `agent:in-progress` non si tocca (il
 * fixer ci sta lavorando: decide il tick dopo), e la label si rilegge dal vivo
 * subito prima di chiudere. Qualunque lettura fallita → la issue resta com'e'.
 *
 * Uso:  node scripts/ci/reconcile-conflict-handoffs.mjs
 * Env:  GH_TOKEN (issues: write, pull-requests: read, contents: read), GH_REPO o
 *       GITHUB_REPOSITORY, DRY_RUN=1 (solo log), CI_JOB_DEADLINE_EPOCH.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conflictClearedAfter,
  conflictHandoffExpectedHead,
  conflictHandoffOriginPr,
  conflictLabelEventsArgs,
  handoffResolution,
  parseConflictLabelEvents,
} from './check-issue-already-resolved.mjs';
import { closedIssueRefs } from './followup-resolution-match.mjs';
import { runBudgetFromEnv } from './lib/run-budget.mjs';
import { CLAIM_LABEL } from './stale-claim-detector.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

export const RECONCILE_MARKER = '<!-- CONFLICT_HANDOFF_RECONCILE -->';
// Bound per run (AGENTS.md no-silent-cap: le eccedenze sono loggate e restano
// al tick successivo, 20 minuti dopo).
export const MAX_CLOSES_PER_RUN = 20;
// Le PR mergiate lette per riconoscere una riapplicazione. Un hand-off vive
// ore, non settimane: una riapplicazione piu' vecchia di questa finestra ha
// gia' chiuso la sua issue con il `Closes` di GitHub.
export const MERGED_PR_WINDOW = 200;

function gh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function ghJson(args) {
  const raw = gh(args);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const numberRef = (n) => `#${Number(n)}(?!\\d)`;

/**
 * Una PR (titolo + body) dichiara di chiudere la issue? Stesso parser del
 * segnale «PR mergiata con keyword» del pre-flight (`closedIssueRefs`), che
 * legge anche `Closes #a #b` e il titolo. Pura.
 */
export function declaresClosing(text, issueNumber) {
  return closedIssueRefs(String(text || '')).includes(Number(issueNumber));
}

const prText = (pr) => `${pr?.title || ''}\n${pr?.body || ''}`;

/** Una PR (body) dichiara di sostituire la PR di origine? Pura. */
export function declaresSupersede(body, originNumber) {
  return new RegExp(`\\bsupersedes\\s+${numberRef(originNumber)}`, 'i').test(String(body || ''));
}

/**
 * La PR aperta che sta riapplicando l'hand-off, se c'e': il branch del fixer
 * (`fix/issue-<issue>`) o una keyword verso la issue o la PR di origine. La PR
 * di origine stessa non conta. Pura.
 */
export function reapplyInFlight(openPrs, { issueNumber, originNumber }) {
  return (openPrs || []).find((pr) => Number(pr?.number) !== Number(originNumber) && (
    new RegExp(`(^|/)issue-${Number(issueNumber)}$`).test(String(pr?.headRefName || ''))
    || declaresClosing(prText(pr), issueNumber)
    || declaresSupersede(prText(pr), originNumber)
  )) || null;
}

const labelNames = (issue) => (issue?.labels || [])
  .map((label) => (typeof label === 'string' ? label : label?.name))
  .filter(Boolean);

/** L'hand-off ha lavoro avviato: un claim del fixer o una PR che lo riapplica. Pura. */
export function handoffBusy(issue, originNumber, openPrs) {
  return labelNames(issue).includes(CLAIM_LABEL)
    || reapplyInFlight(openPrs, { issueNumber: issue?.number, originNumber }) !== null;
}

// Label con cui una issue e' in mano al fixer (subito o in coda).
export const ROUTING_LABELS = ['agent:fix', 'agent:fix-queued'];

/** L'hand-off e' instradato al fixer (`agent:fix` o `agent:fix-queued`). Pura. */
export function handoffRouted(issue) {
  return labelNames(issue).some((name) => ROUTING_LABELS.includes(name));
}

/**
 * Chi resta fra gli hand-off della stessa PR di origine: (1) chi ha lavoro
 * avviato (`handoffBusy`), (2) chi e' instradato al fixer, (3) il numero piu'
 * basso. Pura e deterministica: due run concorrenti eleggono la stessa.
 *
 * #11147 (03-10): il keeper era «busy, altrimenti il piu' vecchio», cosi' ha
 * tenuto #11151, mai instradata, e chiuso come duplicate #11154 e #11156 appena
 * create, prima che ricevessero `agent:fix`. pr-autorebase, che usa la stessa
 * elezione, ne riapriva un'altra a ogni giro.
 */
export function electHandoffKeeper(members, origin, openPrs = []) {
  const sorted = [...(members || [])].sort((a, b) => Number(a.number) - Number(b.number));
  return sorted.find((issue) => handoffBusy(issue, origin, openPrs))
    || sorted.find(handoffRouted)
    || sorted[0]
    || null;
}

/**
 * Raggruppa gli hand-off aperti per PR di origine ed elegge chi resta con
 * `electHandoffKeeper`. Gli altri sono duplicati. Pura.
 *
 * @returns {Array<{ origin: number, keeper: object, duplicates: object[] }>}
 */
export function groupHandoffs(issues, openPrs = []) {
  const groups = new Map();
  for (const issue of issues || []) {
    const origin = conflictHandoffOriginPr(issue?.title);
    if (origin === null) continue;
    if (!groups.has(origin)) groups.set(origin, []);
    groups.get(origin).push(issue);
  }
  return [...groups.entries()].map(([origin, members]) => {
    const sorted = [...members].sort((a, b) => Number(a.number) - Number(b.number));
    const keeper = electHandoffKeeper(sorted, origin, openPrs);
    return { origin, keeper, duplicates: sorted.filter((issue) => issue !== keeper) };
  });
}

// Un duplicato piu' giovane di cosi' non si chiude: e' la finestra in cui
// pr-autorebase lo ha appena creato e gli sta ancora applicando `agent:fix`
// (su #11157 la label e' arrivata 54 s dopo la creazione). Chiuderlo li'
// faceva ripartire l'hand-off al giro dopo.
export const MIN_DUPLICATE_AGE_MINUTES = 10;

/**
 * Il duplicato e' abbastanza vecchio da essere chiuso? `created_at` assente o
 * illeggibile → conta come vecchio (comportamento di prima). Pura.
 */
export function duplicateOldEnough(issue, now = Date.now()) {
  const created = Date.parse(issue?.created_at ?? issue?.createdAt ?? '');
  if (!Number.isFinite(created)) return true;
  return Number(now) - created >= MIN_DUPLICATE_AGE_MINUTES * 60_000;
}

/**
 * Quali duplicati di un gruppo chiudere adesso. Il filtro d'eta' vive qui, al
 * momento della chiusura, non in `groupHandoffs` (che resta il contratto del
 * gemello del corpus). Pura.
 *   - lavoro avviato anche sul duplicato (due run parallele), o PR aperte
 *     illeggibili → nessuno dei due si butta, decide il tick dopo;
 *   - creato da meno di `MIN_DUPLICATE_AGE_MINUTES` → pr-autorebase gli sta
 *     ancora applicando `agent:fix`.
 * @returns {{ close: object[], deferred: Array<{ issue: object, why: string }> }}
 */
export function planDuplicateClosures({ origin, duplicates }, openPrs, now = Date.now()) {
  const close = [];
  const deferred = [];
  for (const dup of duplicates || []) {
    if (!Array.isArray(openPrs) || handoffBusy(dup, origin, openPrs)) {
      deferred.push({ issue: dup, why: 'con lavoro avviato (o PR aperte illeggibili)' });
    } else if (!duplicateOldEnough(dup, now)) {
      deferred.push({ issue: dup, why: `creato da meno di ${MIN_DUPLICATE_AGE_MINUTES} minuti` });
    } else {
      close.push(dup);
    }
  }
  return { close, deferred };
}

const normalizeLine = (line) => String(line).trim().replace(/\s+/g, ' ');

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Gli hunk di una patch di `pulls/<n>/files`, o `{ error }` se la patch non e'
 * leggibile per intero. Pura. Per ogni hunk:
 *   - `newSide`: le righe del NUOVO lato (contesto + aggiunte) nell'ordine,
 *     normalizzate come `normalizeLine`;
 *   - `added`: le righe aggiunte non vuote (per il conteggio del commento);
 *   - `anchorStart`/`anchorEnd`: una rimozione prima della prima (o dopo
 *     l'ultima) riga del nuovo lato. Senza una riga che la delimiti, la sua
 *     assenza su main si dimostra solo se l'hunk sta all'inizio (o alla fine)
 *     del file, come fa `git apply` con un hunk senza contesto su quel lato.
 * Le righe si contano contro l'intestazione `@@ -a,b +c,d @@`: una patch piu'
 * corta di quanto dichiara e' troncata, una riga che non e' contesto,
 * aggiunta, rimozione o `\ No newline…` la rende illeggibile.
 */
export function parsePatchHunks(patch) {
  const hunks = [];
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  let seenRemoval = false;
  const close = () => {
    if (current === null) return null;
    if (oldLeft !== 0 || newLeft !== 0) return `hunk ${hunks.length + 1} troncato (mancano ${oldLeft} righe vecchie e ${newLeft} nuove)`;
    hunks.push(current);
    current = null;
    return null;
  };
  // L'intestazione `+++ b/…` puo' stare solo prima del primo `@@` (la patch di
  // `pulls/<n>/files` non la porta): dentro un hunk ogni `+` e' una riga
  // aggiunta, anche `++i;` (che diventa `+++i;`).
  for (const line of String(patch ?? '').split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      const error = close();
      if (error) return { error };
      current = { header: line.slice(0, line.indexOf('@@', 2) + 2), newSide: [], added: [], anchorStart: false, anchorEnd: false };
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLeft = header[2] === undefined ? 1 : Number(header[2]);
      seenRemoval = false;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('\\')) continue;
    if (oldLeft === 0 && newLeft === 0) {
      // Fine dell'hunk: resta solo il ritorno a capo finale della patch.
      if (line === '') continue;
      return { error: `riga oltre la lunghezza dichiarata dall'hunk ${hunks.length + 1}` };
    }
    // Una riga vuota dentro l'hunk e' una riga di contesto vuota a cui un
    // passaggio intermedio ha tolto lo spazio iniziale.
    const marker = line === '' ? ' ' : line[0];
    const text = line.slice(1);
    if (marker === ' ') {
      if (oldLeft === 0 || newLeft === 0) return { error: `hunk ${hunks.length + 1} piu' lungo di quanto dichiara` };
      oldLeft -= 1;
      newLeft -= 1;
      if (seenRemoval && current.newSide.length === 0) current.anchorStart = true;
      seenRemoval = false;
      current.newSide.push(normalizeLine(text));
    } else if (marker === '+') {
      if (newLeft === 0) return { error: `hunk ${hunks.length + 1} piu' lungo di quanto dichiara` };
      newLeft -= 1;
      if (seenRemoval && current.newSide.length === 0) current.anchorStart = true;
      seenRemoval = false;
      const normalized = normalizeLine(text);
      current.newSide.push(normalized);
      if (normalized !== '') current.added.push(normalized);
    } else if (marker === '-') {
      if (oldLeft === 0) return { error: `hunk ${hunks.length + 1} piu' lungo di quanto dichiara` };
      oldLeft -= 1;
      seenRemoval = true;
    } else {
      return { error: `riga estranea nell'hunk ${hunks.length + 1}` };
    }
    if (oldLeft === 0 && newLeft === 0 && seenRemoval) {
      if (current.newSide.length === 0) current.anchorStart = true;
      current.anchorEnd = true;
    }
  }
  const error = close();
  if (error) return { error };
  if (hunks.length === 0) return { error: 'nessun hunk @@ nella patch' };
  return { hunks };
}

/**
 * Le righe di un file normalizzate, senza la riga vuota che `split` produce
 * dopo l'ultimo ritorno a capo (altrimenti un hunk ancorato alla fine non
 * troverebbe mai la fine). Pura.
 */
function fileLines(text) {
  const lines = String(text).split('\n').map(normalizeLine);
  if (lines.length > 0 && lines[lines.length - 1] === '' && /\n$/.test(String(text))) lines.pop();
  return lines;
}

/**
 * Il primo indice `>= from` in cui `needle` compare contiguo in `haystack`,
 * rispettando le ancore, oppure -1. Pura.
 */
function findContiguous(haystack, needle, from, { anchorStart, anchorEnd }) {
  const last = haystack.length - needle.length;
  for (let i = from; i <= last; i += 1) {
    if (anchorStart && i !== 0) return -1;
    if (anchorEnd && i !== last) continue;
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Il contenuto della PR di origine e' su `main`? Pura: `readMainFile(path)`
 * restituisce il testo del file su `main` o `null` (assente o illeggibile).
 *
 * `files` = `[{ filename, status, patch }]` di `pulls/<n>/files`. La prova e'
 * un'APPLICAZIONE AL CONTRARIO, non una presenza di righe: per ogni file la
 * patch deve essere leggibile per intero (`parsePatchHunks`: righe contate
 * contro le intestazioni `@@`, quindi una patch troncata non passa), e il nuovo
 * lato di OGNI hunk (contesto + aggiunte, nell'ordine) deve comparire CONTIGUO
 * fra le righe del file su `main`, ogni hunk dopo la fine del precedente:
 * posizioni distinte, ordine della patch, molteplicita' (due righe identiche
 * aggiunte chiedono due occorrenze). Il confronto e' a meno dei soli spazi
 * (bordi e sequenze ridotti a uno: misurato sulla PR #10865, una riga di
 * commento con due spazi poi normalizzati da #11201). Niente soglie: o tutti
 * gli hunk, o non provato.
 *
 * Prima (fino alla review del corpus sulla PR di trasporto 2090) la prova era
 * un `Set` delle righe di main: una riga aggiunta presente solo nel contesto di
 * un altro hunk, o aggiunta due volte e presente una, rendeva «su main» una PR
 * mai applicata, e l'hand-off si chiudeva `completed`.
 *
 * Restano non dimostrabili, quindi non provati: un file `removed`, un file
 * senza `patch` (binario o troppo grande) e un file senza righe aggiunte non
 * vuote (sola rimozione).
 *
 * Il marker `ALREADY_FIXED_ROUTED` non e' questa prova: certifica una run verde
 * qualunque su main (#10731: marker presente, 0/56 righe della PR #10467 su
 * main, che aveva scelto un'altra strada).
 *
 * @returns {{ proven: true, checked: number, files: string[] } | { proven: false, reason: string }}
 */
export function originContentOnMain(files, readMainFile) {
  if (!Array.isArray(files) || files.length === 0) return { proven: false, reason: 'elenco dei file della PR vuoto o illeggibile' };
  let checked = 0;
  const names = [];
  for (const file of files) {
    const name = String(file?.filename || '');
    if (!name) return { proven: false, reason: 'file senza nome nella PR' };
    if (String(file?.status || '') === 'removed') return { proven: false, reason: `${name}: rimosso dalla PR, rimozione non dimostrabile` };
    if (typeof file?.patch !== 'string' || file.patch === '') return { proven: false, reason: `${name}: patch assente (binario o troppo grande)` };
    const parsed = parsePatchHunks(file.patch);
    if (parsed.error) return { proven: false, reason: `${name}: patch illeggibile (${parsed.error})` };
    const added = parsed.hunks.reduce((n, hunk) => n + hunk.added.length, 0);
    if (added === 0) return { proven: false, reason: `${name}: nessuna riga aggiunta, rimozione non dimostrabile` };
    let main;
    try {
      main = readMainFile(name);
    } catch {
      main = null;
    }
    if (typeof main !== 'string') return { proven: false, reason: `${name}: assente o illeggibile su main` };
    const mainLines = fileLines(main);
    let from = 0;
    for (const [index, hunk] of parsed.hunks.entries()) {
      const at = hunk.newSide.length === 0 ? -1 : findContiguous(mainLines, hunk.newSide, from, hunk);
      if (at < 0) {
        return { proven: false, reason: `${name}: hunk ${index + 1}/${parsed.hunks.length} (${hunk.header}) non applicato su main nell'ordine della patch` };
      }
      from = at + hunk.newSide.length;
    }
    checked += added;
    names.push(name);
  }
  return { proven: true, checked, files: names };
}

// Un'origine chiusa da meno di cosi' puo' ancora essere riaperta o riapplicata
// dal suo autore: l'hand-off resta com'e'.
export const ORIGIN_CLOSED_GRACE_HOURS = 24;

// Una issue che la PR di origine chiudeva e' «non orfana» se e' chiusa o se
// porta una di queste label (instradata o parcheggiata in modo esplicito).
export const ORIGIN_ISSUE_PARKED_LABELS = ['fu-parked', 'automation-deferred', 'needs-human'];

/** La issue non resta orfana: chiusa, oppure instradata o parcheggiata. Pura. */
export function originIssueAccountedFor(issue) {
  const state = String(issue?.state || '').toUpperCase();
  if (state === 'CLOSED') return true;
  if (state !== 'OPEN' || !Array.isArray(issue?.labels)) return false;
  return labelNames(issue).some((name) => name.startsWith('agent:fix') || ORIGIN_ISSUE_PARKED_LABELS.includes(name));
}

/**
 * La PR di origine e' CHIUSA (non mergiata) da piu' della grazia? `closedAt`
 * assente o illeggibile → no. Pura.
 */
export function originClosedPastGrace(origin, now = Date.now()) {
  if (String(origin?.state || '').toUpperCase() !== 'CLOSED') return false;
  const closed = Date.parse(origin?.closedAt ?? '');
  if (!Number.isFinite(closed)) return false;
  return Number(now) - closed >= ORIGIN_CLOSED_GRACE_HOURS * 3_600_000;
}

/**
 * Ramo «PR di origine chiusa senza merge» di `decideHandoff`, dopo claim e
 * riapplicazione mergiata (che restano prioritari). Prima di questo ramo
 * l'hand-off restava aperto per sempre (#10960, #10873, #10731). Pura.
 *   - chiusa da meno della grazia, o `closedAt` illeggibile → keep `origin-closed`;
 *   - una PR aperta la sta riapplicando → keep;
 *   - patch provata su main hunk per hunk → close `completed`;
 *   - altrimenti l'hand-off e' SUPERATO (close `not planned`) solo se non e'
 *     instradato al fixer e ogni issue che l'origine chiudeva e' chiusa,
 *     instradata o parcheggiata: il lavoro non resta orfano.
 * Il marker `ALREADY_FIXED_ROUTED` e la label `orphaned` non entrano: il primo
 * non prova il contenuto (#10731), la seconda dice solo chi ha chiuso la PR.
 */
function decideClosedOrigin({ issue, origin, openPrs, originNumber, contentProof, originIssues, now }) {
  if (!originClosedPastGrace(origin, now)) return { action: 'keep', reason: 'origin-closed' };
  if (!Array.isArray(openPrs)) return { action: 'keep', reason: 'open-prs-unreadable' };
  const inFlight = reapplyInFlight(openPrs, { issueNumber: issue.number, originNumber });
  if (inFlight) return { action: 'keep', reason: 'reapply-in-flight', pr: Number(inFlight.number) };
  // Nessun verdetto (elenco dei file della PR illeggibile): non si puo' dire
  // ne' «su main» ne' «superato».
  if (!contentProof || typeof contentProof.proven !== 'boolean') return { action: 'keep', reason: 'origin-content-unchecked' };
  if (contentProof.proven === true) return { action: 'close', reason: 'origin-closed-content-on-main', pr: originNumber };
  if (handoffRouted(issue)) return { action: 'keep', reason: 'origin-closed-handoff-routed' };
  if (!Array.isArray(originIssues) || !originIssues.every(originIssueAccountedFor)) {
    return { action: 'keep', reason: 'origin-closed-issue-not-requeued' };
  }
  return { action: 'close', reason: 'origin-closed-superseded', pr: originNumber };
}

/**
 * Decisione su un hand-off (il keeper del suo gruppo). Pura: tutto l'input e'
 * gia' letto.
 *
 * @param {object} p
 * @param {{number:number, title:string, body:string, labels:any[]}} p.issue
 * @param {object|null} p.origin  `gh pr view --json state,mergedAt,mergeable,mergeStateStatus,headRefOid,labels`
 * @param {Array<{number:number, title?:string, body:string}>|null} p.mergedPrs
 * @param {Array<{number:number, headRefName:string, title?:string, body:string}>|null} p.openPrs
 * @param {Array<object>|null} [p.conflictEvents]  eventi `has-conflicts` della PR di origine (`parseConflictLabelEvents`)
 * @param {{proven: boolean, checked?: number, files?: string[], reason?: string}|null} [p.contentProof]
 *   `originContentOnMain` sulla PR di origine CHIUSA (letta solo dopo la grazia)
 * @param {Array<{number:number, state:string, labels:any[]}|null>|null} [p.originIssues]
 *   le issue che la PR di origine dichiarava di chiudere, lette dal vivo
 * @param {number} [p.now]
 * @returns {{ action: 'close'|'keep', reason: string, pr?: number }}
 */
export function decideHandoff({
  issue, origin, mergedPrs, openPrs, conflictEvents = null,
  contentProof = null, originIssues = null, now = Date.now(),
}) {
  const originNumber = conflictHandoffOriginPr(issue?.title);
  if (originNumber === null) return { action: 'keep', reason: 'not-a-handoff' };
  if (labelNames(issue).includes(CLAIM_LABEL)) return { action: 'keep', reason: 'claim-active' };

  if (Array.isArray(mergedPrs)) {
    const replacement = mergedPrs.find((pr) => Number(pr?.number) !== originNumber && (
      declaresClosing(prText(pr), issue.number) || declaresSupersede(prText(pr), originNumber)
    ));
    if (replacement) return { action: 'close', reason: 'reapplied', pr: Number(replacement.number) };
  }

  const state = String(origin?.state || '').toUpperCase();
  if (!state) return { action: 'keep', reason: 'origin-unreadable' };
  if (state === 'MERGED') return { action: 'close', reason: 'origin-merged', pr: originNumber };
  if (state === 'CLOSED') {
    return decideClosedOrigin({ issue, origin, openPrs, originNumber, contentProof, originIssues, now });
  }
  if (state !== 'OPEN') return { action: 'keep', reason: `origin-${state.toLowerCase()}` };

  // Una PR aperta lo sta gia' riapplicando: chi mergia per primo decide, e una
  // lista illeggibile vale «forse in volo».
  if (!Array.isArray(openPrs)) return { action: 'keep', reason: 'open-prs-unreadable' };
  const inFlight = reapplyInFlight(openPrs, { issueNumber: issue.number, originNumber });
  if (inFlight) return { action: 'keep', reason: 'reapply-in-flight', pr: Number(inFlight.number) };

  const verdict = handoffResolution(origin, {
    expectedHead: conflictHandoffExpectedHead(issue.body),
    conflictClearedAfterOpen: conflictClearedAfter(conflictEvents, issue.created_at ?? issue.createdAt),
  });
  if (verdict.resolved) return { action: 'close', reason: verdict.reason, pr: originNumber };
  return { action: 'keep', reason: verdict.reason };
}

// Motivi chiusi come «not planned» invece che «completed».
export const NOT_PLANNED_REASONS = new Set(['origin-closed-superseded']);

/** Testo del commento di chiusura. Puro. */
export function closingComment({ reason, pr, originNumber, keeper, contentProof = null, originIssues = null }) {
  const proofFiles = (contentProof?.files || []).map((f) => `\`${f}\``).join(', ');
  const issuesList = (originIssues || [])
    .filter(Boolean)
    .map((i) => `#${i.number} (${String(i.state || '').toUpperCase() === 'CLOSED' ? 'chiusa' : `aperta, ${labelNames(i).join(', ')}`})`)
    .join(', ');
  const why = {
    duplicate: `è un duplicato di #${keeper}: stesso hand-off della PR #${originNumber}, aperto da una seconda run concorrente di \`pr-autorebase\`. Il lavoro prosegue su #${keeper}.`,
    reapplied: `la PR **#${pr}**, già mergiata, riapplica la PR #${originNumber} (\`Closes\`/\`Supersedes\`), ma GitHub non ha chiuso questa issue.`,
    'origin-merged': `la PR di origine **#${originNumber}** è stata mergiata: il conflitto è stato risolto sul suo branch e il contributo è su \`main\`. Una riapplicazione sarebbe un duplicato.`,
    'conflict-resolved': `la PR di origine **#${originNumber}** è di nuovo mergeable sulla stessa HEAD e \`pr-autorebase\` ha tolto \`has-conflicts\` dopo l'apertura di questo hand-off (merge-tree pulito): il conflitto è rientrato e la PR prosegue nel proprio ciclo di review e merge.`,
    'conflict-resolved-new-head': `la PR di origine **#${originNumber}** ha una HEAD nuova, mergeable, e \`pr-autorebase\` ha tolto \`has-conflicts\` dopo l'apertura di questo hand-off (merge-tree pulito): il conflitto è stato risolto sul suo branch, che prosegue nel proprio ciclo di review e merge.`,
    'origin-closed-content-on-main': `la PR di origine **#${originNumber}** è stata chiusa senza merge da più di ${ORIGIN_CLOSED_GRACE_HOURS} ore, ma il suo contenuto è già su \`main\`: tutte le ${contentProof?.checked ?? '?'} righe aggiunte non vuote dei suoi file (${proofFiles || 'elenco non disponibile'}) compaiono nei file su \`main\` con il loro contesto, hunk per hunk e nell'ordine della patch.`,
    'origin-closed-superseded': `la PR di origine **#${originNumber}** è stata chiusa senza merge da più di ${ORIGIN_CLOSED_GRACE_HOURS} ore e il contenuto della PR di origine NON risulta su main (${contentProof?.reason || 'verifica hunk per hunk non superata'}): l'hand-off è superato, non completato. Nessuno lo sta riapplicando, non è instradato al fixer e le issue che la PR di origine dichiarava di risolvere non restano orfane: ${issuesList || 'la PR non ne dichiarava'}.`,
  }[reason];
  let outcome = 'Chiusa come **completed**: non resta nessun contributo da riapplicare. Se la PR di origine torna in conflitto su una HEAD nuova, `pr-autorebase` apre un hand-off nuovo.';
  if (reason === 'duplicate') outcome = 'Chiusa come **duplicate**.';
  if (NOT_PLANNED_REASONS.has(reason)) outcome = 'Chiusa come **not planned**: il lavoro, se serve ancora, prosegue sulle issue elencate sopra. Se la PR di origine viene riaperta e torna in conflitto, `pr-autorebase` apre un hand-off nuovo.';
  return [
    RECONCILE_MARKER,
    `✅ **Hand-off riconciliato (zero-Claude)**: ${why || reason}`,
    '',
    outcome,
    '',
    '_Segnale deterministico da `scripts/ci/reconcile-conflict-handoffs.mjs` (followup-drainer)._',
  ].join('\n');
}

// --- I/O --------------------------------------------------------------------

function listOpenHandoffs() {
  // Elenco REST (consistente), non la search API: una issue appena creata deve
  // comparire, altrimenti un duplicato sfugge al raggruppamento.
  const raw = gh(['api', '--paginate', `repos/${REPO}/issues?state=open&per_page=100`, '--jq',
    '.[] | select(.pull_request == null) | select(.title | startswith("Conflitto con main")) '
    + '| {number, title, body, created_at, labels: [.labels[].name]}']);
  if (raw === null) return null;
  const issues = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      issues.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return issues.filter((issue) => conflictHandoffOriginPr(issue.title) !== null);
}

function readOrigin(num) {
  return ghJson(['pr', 'view', String(num), '--repo', REPO,
    '--json', 'state,mergedAt,closedAt,mergeable,mergeStateStatus,headRefOid,labels,title,body']);
}

// Oltre questo numero di file la prova di contenuto non si tenta (una lettura
// di main per file): l'hand-off resta al ramo «superato» con i suoi vincoli.
export const CONTENT_PROOF_MAX_FILES = 100;
// Stima del costo di una prova di contenuto (elenco file + letture di main +
// issue dell'origine) per il budget della run.
export const CONTENT_PROOF_BUDGET_MS = 30_000;

/** `[{ filename, status, patch }]` della PR, o `null` se illeggibile. */
function readOriginFiles(num) {
  const raw = gh(['api', '--paginate', `repos/${REPO}/pulls/${Number(num)}/files?per_page=100`,
    '--jq', '.[] | {filename, status, patch}']);
  if (raw === null) return null;
  const files = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      files.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return files;
}

/** Testo del file su `main`, o `null` (assente o lettura fallita). */
function readMainFile(filePath) {
  const encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
  return gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${REPO}/contents/${encoded}?ref=main`]);
}

function readContentProof(num) {
  const files = readOriginFiles(num);
  if (files === null) return null;
  if (files.length > CONTENT_PROOF_MAX_FILES) {
    return { proven: false, reason: `${files.length} file (> ${CONTENT_PROOF_MAX_FILES}): prova di contenuto non tentata` };
  }
  return originContentOnMain(files, readMainFile);
}

/** Le issue che la PR di origine dichiarava di chiudere, lette dal vivo (`null` per una illeggibile). */
function readOriginIssues(originPr) {
  return closedIssueRefs(prText(originPr)).map((n) => {
    const live = ghJson(['issue', 'view', String(n), '--repo', REPO, '--json', 'number,state,labels']);
    return live && Number(live.number) === n ? live : null;
  });
}

function readConflictEvents(num) {
  return parseConflictLabelEvents(gh(conflictLabelEventsArgs(REPO, num)));
}

/**
 * Stato dal vivo subito prima della chiusura: tra la lista letta a inizio run e
 * questo momento il fixer puo' aver preso il claim, o qualcuno averla chiusa.
 * Lettura fallita → non chiudere. Pura sull'oggetto letto.
 */
export function stillClosable(live) {
  return String(live?.state || '').toUpperCase() === 'OPEN'
    && Array.isArray(live?.labels)
    && !labelNames(live).includes(CLAIM_LABEL);
}

function closeIssue(number, { reason, comment, keeper }) {
  const live = ghJson(['issue', 'view', String(number), '--repo', REPO, '--json', 'state,labels']);
  if (!stillClosable(live)) {
    console.log(`#${number}: claim preso, gia' chiusa o stato illeggibile subito prima della chiusura → resta com'e'.`);
    return false;
  }
  // «Superato» vale solo per un hand-off che nessuno ha in mano: se nel
  // frattempo e' stato instradato, resta al fixer.
  if (NOT_PLANNED_REASONS.has(reason) && handoffRouted(live)) {
    console.log(`#${number}: instradata al fixer subito prima della chiusura (${reason}) → resta com'e'.`);
    return false;
  }
  if (gh(['issue', 'comment', String(number), '--repo', REPO, '--body', comment]) === null) return false;
  if (reason === 'duplicate') {
    // `--duplicate-of` dove il `gh` del runner lo conosce, altrimenti «not
    // planned»: il commento nomina comunque la issue che resta. Niente PATCH
    // sull'oggetto issue (guard #926 del corpus, che il file condivide).
    if (gh(['issue', 'close', String(number), '--repo', REPO, '--duplicate-of', String(keeper)]) !== null) return true;
    return gh(['issue', 'close', String(number), '--repo', REPO, '--reason', 'not planned']) !== null;
  }
  const closeReason = NOT_PLANNED_REASONS.has(reason) ? 'not planned' : 'completed';
  return gh(['issue', 'close', String(number), '--repo', REPO, '--reason', closeReason]) !== null;
}

function main() {
  if (!REPO) {
    console.log('::warning::GH_REPO/GITHUB_REPOSITORY assente → nessuna riconciliazione.');
    return;
  }
  const issues = listOpenHandoffs();
  if (issues === null) {
    console.log('::warning::elenco degli hand-off illeggibile → nessuna riconciliazione in questo tick.');
    return;
  }
  if (issues.length === 0) {
    console.log('Nessun hand-off di conflitto aperto.');
    return;
  }
  const openPrs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '300',
    '--json', 'number,headRefName,title,body']);
  const mergedPrs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'merged',
    '--limit', String(MERGED_PR_WINDOW), '--json', 'number,title,body']);

  const budget = runBudgetFromEnv();
  const now = Date.now();
  const actions = [];
  for (const { origin, keeper, duplicates } of groupHandoffs(issues, openPrs || [])) {
    const { close, deferred } = planDuplicateClosures({ keeper, duplicates, origin }, openPrs, now);
    for (const { issue: dup, why } of deferred) {
      console.log(`#${dup.number} duplicato di #${keeper.number} ma ${why} → al prossimo tick.`);
    }
    for (const dup of close) {
      actions.push({ issue: dup, reason: 'duplicate', originNumber: origin, keeper: keeper.number });
    }
    if (!budget.take(`#${keeper.number}`, 2_000)) continue;
    const originPr = readOrigin(origin);
    // Gli eventi servono solo a una PR di origine aperta (prova da merge-tree).
    const conflictEvents = String(originPr?.state || '').toUpperCase() === 'OPEN' ? readConflictEvents(origin) : null;
    // File, contenuto di main e issue dell'origine servono solo a un'origine
    // CHIUSA oltre la grazia, senza claim e senza una riapplicazione in volo
    // (o PR aperte illeggibili): in quei casi `decideClosedOrigin` risponde
    // `keep` senza usarli, e le letture si ripeterebbero a ogni tick.
    const closedLong = originClosedPastGrace(originPr, now) && !labelNames(keeper).includes(CLAIM_LABEL)
      && Array.isArray(openPrs) && reapplyInFlight(openPrs, { issueNumber: keeper.number, originNumber: origin }) === null;
    // La prova di contenuto legge main una volta per file (fino a
    // CONTENT_PROOF_MAX_FILES): se il budget della run non la copre, l'hand-off
    // passa intero al prossimo tick.
    if (closedLong && !budget.canAfford(CONTENT_PROOF_BUDGET_MS)) {
      budget.defer(`#${keeper.number} (prova di contenuto)`);
      continue;
    }
    const contentProof = closedLong ? readContentProof(origin) : null;
    const originIssues = closedLong ? readOriginIssues(originPr) : null;
    const decision = decideHandoff({
      issue: keeper, origin: originPr, mergedPrs, openPrs, conflictEvents, contentProof, originIssues, now,
    });
    console.log(`#${keeper.number} (PR di origine #${origin}): ${decision.action} — ${decision.reason}${decision.pr ? ` (#${decision.pr})` : ''}${contentProof && !contentProof.proven ? ` [contenuto: ${contentProof.reason}]` : ''}`);
    if (decision.action === 'close') {
      actions.push({ issue: keeper, reason: decision.reason, pr: decision.pr, originNumber: origin, contentProof, originIssues });
    }
  }

  const closed = [];
  for (const [index, action] of actions.entries()) {
    if (index >= MAX_CLOSES_PER_RUN) {
      console.log(`::warning::cap raggiunto (${MAX_CLOSES_PER_RUN}/run): ${actions.length - index} hand-off risolti restano aperti fino al prossimo tick.`);
      break;
    }
    const comment = closingComment(action);
    if (DRY_RUN) {
      console.log(`[dry] chiuderei #${action.issue.number} (${action.reason})`);
      continue;
    }
    if (closeIssue(action.issue.number, { reason: action.reason, comment, keeper: action.keeper })) {
      closed.push(action);
      console.log(`#${action.issue.number} chiusa (${action.reason}).`);
    } else {
      console.log(`::warning::#${action.issue.number}: chiusura fallita (${action.reason}) → ritento al prossimo tick.`);
    }
  }
  budget.report();

  const summary = `Hand-off di conflitto: ${issues.length} aperti, ${closed.length} chiusi${DRY_RUN ? ' (dry-run)' : ''}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = closed.map((a) => `- #${a.issue.number} → ${a.reason}${a.pr ? ` (#${a.pr})` : ''}`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${lines.join('\n')}\n`);
  }
}

// Best-effort: un errore non deve mai far fallire il drain che segue.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.log(`::warning::reconcile-conflict-handoffs: ${error?.message || error} → nessuna modifica ulteriore.`);
  }
}
