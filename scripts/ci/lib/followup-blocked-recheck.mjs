/**
 * followup-blocked-recheck.mjs — gli item `blocked` dei bucket giornalieri
 * vengono RIMISURATI, una volta per giro del reconciler.
 *
 * Il difetto che chiude: lo stato `blocked` e' ammesso dal parser ma nessun
 * codice lo consumava. `reconcileDailyItems` guarda solo `open`/`in-progress`,
 * il drainer sceglie solo `open`, il gate di chiusura esige `done`: un item
 * bloccato restava tale anche quando il suo token diventava vero o quando il
 * file che lo bloccava cambiava. Misurato il 2026-10-04: 10 item `blocked` in
 * site#9609 (6 con il token gia' presente oggi), 1 in site#8441, nessun marker
 * a grana item su entrambi i bucket.
 *
 * Due uscite, nessuno stato nuovo, nessuna prova nuova nel gate di chiusura:
 *
 * 1. TOKEN. Un item `blocked` il cui token di accettazione e' confermato da
 *    `detectAlreadyResolved` (lo stesso oracolo e la stessa soglia degli item
 *    `open`) passa a `done` — salvo che il token fosse GIA' vero quando l'item
 *    e' nato. Due modi di saperlo: il marker `FU_ITEM_BORN_SATISFIED` del gate
 *    sul conio, oppure la stessa misura ripetuta sul file com'era alla fine
 *    del giorno del bucket (limite superiore del conio: il caso ambiguo resta
 *    `blocked`, mai `done`). Il secondo serve ai bucket coniati prima del
 *    marker: in site#9609 tre token su sei (`writeJobsCrawlerSlice()`,
 *    `validateD18FirstRunEvidence()`, `blockingErrors.length > 0`) stavano gia'
 *    nel file prima che l'item esistesse. Un token nato vero non diventa
 *    `done`: il reconciler scrive il marker (cosi' anche il gate di chiusura e
 *    la richiesta di verifica lo vedono) e l'item resta `blocked`.
 * 2. RIENTRO, UNA VOLTA. Un item `blocked` con un commit su `main` che tocca il
 *    suo `Target file` DOPO il blocco torna `open`, con un commento
 *    `FU_ITEM_UNBLOCKED`. E' il fixer a rimisurare il blocco; se e' ancora
 *    bloccato lo ridice e l'item non rientra piu' (il marker c'e'). Esclusi:
 *    `reason=awaiting-verification` (il fixer ha gia' detto «fatto»: esce per
 *    token o per verifica esplicita) e gli item gia' rientrati.
 *
 * La condizione «le PR in `Sources` sono tutte MERGED» NON e' un segnale: e'
 * sempre vera, gli item nascono dal triage post-merge.
 *
 * Modulo puro: le letture GitHub arrivano iniettate (`readers`) e ogni lettura
 * fallita e' «non so», mai «niente di nuovo» ne' «token nuovo»: niente `done`,
 * niente rientro.
 */
import {
  bucketState,
  detectAlreadyResolved,
  hasFalsifiableAcceptance,
  parseFollowupItems,
  updateFollowupItemState,
} from '../followup-resolution-match.mjs';
import {
  inertCommentText,
  itemBornSatisfiedMarker,
  itemTargetPath,
  itemUnblockedMarker,
} from './followup-item-evidence.mjs';

/** Il padre decomposto e' un tracker: il lavoro e' nelle figlie. */
export const DECOMPOSED_PARENT_LABEL = 'decomposed:1';

const DAY_MS = 86_400_000;

/** Istante d'inizio del bucket (`YYYY-MM-DDT00:00:00Z`) o `null`. */
export function bucketStartIso(dailyKey) {
  const key = String(dailyKey ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(key) || !Number.isFinite(Date.parse(`${key}T00:00:00Z`))) return null;
  return `${key}T00:00:00Z`;
}

/**
 * Limite superiore della nascita degli item del bucket: l'inizio del giorno UTC
 * successivo a `dailyKey`, che cade dopo la fine del giorno di Zurigo e quindi
 * dopo ogni conio per quella chiave (il triage aggiunge item per tutto il
 * giorno). Misurare «nato vero» qui e non a mezzanotte fa pendere il caso
 * ambiguo verso `born-true` (l'item resta `blocked`, il rientro lo copre), mai
 * verso un `done`. `null` se la chiave non e' valida.
 */
export function bucketBirthBoundIso(dailyKey) {
  const start = bucketStartIso(dailyKey);
  if (!start) return null;
  return new Date(Date.parse(start) + DAY_MS).toISOString().replace('.000Z', 'Z');
}

/**
 * Da quando l'item e' bloccato: `createdAt` del piu' recente `FU_ITEM_BLOCKED`
 * (gia' filtrato per autore fidato) per l'ID; senza marker datato (bloccato
 * dal triage o a mano) l'inizio del giorno del bucket. `reason` e' quella
 * dell'ultimo marker di blocco, datato o no.
 * @param {string} itemId
 * @param {Array<{type: string, item: string, reason?: string, createdAt: string|null}>} markers
 * @param {string} dailyKey
 * @returns {{at: string|null, source: 'marker'|'bucket-date', reason: string|null}}
 */
export function blockedSince(itemId, markers, dailyKey) {
  const own = (Array.isArray(markers) ? markers : []).filter((marker) => marker?.type === 'blocked' && marker.item === itemId);
  const reason = own.at(-1)?.reason ?? null;
  let latest = null;
  for (const marker of own) {
    const at = Date.parse(String(marker.createdAt ?? ''));
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  if (latest !== null) return { at: new Date(latest).toISOString(), source: 'marker', reason };
  return { at: bucketStartIso(dailyKey), source: 'bucket-date', reason };
}

/**
 * Il token dell'item era gia' vero all'istante `atIso` (il limite superiore
 * della nascita, `bucketBirthBoundIso`)? Stessa misura di
 * `detectAlreadyResolved`, sui file letti a quell'istante.
 * `fileAt(path, iso)` → `{status: 'ok', content}` | `{status: 'absent'}` |
 * `{status: 'error'}`; un solo `error` rende la risposta `unknown`.
 * @returns {'born'|'not-born'|'unknown'}
 */
export function tokenBornAt(item, io, fileAt, atIso) {
  if (!atIso || typeof fileAt !== 'function') return 'unknown';
  let failed = false;
  const historicIo = {
    fileExists: io?.fileExists,
    readFile: (file) => {
      const read = fileAt(file, atIso);
      if (read?.status === 'ok' && typeof read.content === 'string') return read.content;
      if (read?.status !== 'absent') failed = true;
      return null;
    },
  };
  const result = detectAlreadyResolved(item.text, historicIo, { acceptanceToken: item.acceptanceToken });
  if (failed) return 'unknown';
  return result.resolved ? 'born' : 'not-born';
}

function ageDays(atIso, now) {
  const at = Date.parse(String(atIso ?? ''));
  const nowMs = Number(now);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - at) / DAY_MS));
}

/**
 * Il piano di rimisura di UN bucket. Non scrive nulla.
 *
 * Esiti per item `blocked` con ID stabile:
 * - `done`: token confermato oggi e NON vero alla fine del giorno del bucket;
 * - `born-true`: token confermato oggi e gia' vero alla fine del giorno del bucket,
 *   senza marker: da scrivere il marker; l'item resta `blocked` in questo giro;
 * - `reenter`: commit sul `Target file` dopo il blocco, nessun rientro precedente;
 * - `waiting`: resta `blocked` (`why` dice perche');
 * - `unknown`: una lettura e' fallita, resta `blocked`.
 *
 * Se `localRepository` e `targetRepository` sono entrambi dati e diversi, ogni
 * item e' `unknown` (`foreign-target-repository`): lo stato di oggi si legge
 * dal checkout locale, quello storico dal repository del bucket, e confrontarli
 * mescolerebbe due repository.
 *
 * `reentryBudget.remaining` e' il tetto di rientri condiviso dalla run: un
 * item oltre il tetto resta `waiting` (`reentry-cap`) senza spendere letture.
 *
 * @param {{
 *   body: string, labels?: string[], dailyKey: string,
 *   markers?: Array<object>, io: {fileExists: Function, readFile: Function},
 *   readers: {commitAfter: (path: string, sinceIso: string) => {status: string, commit?: {sha: string, date: string}|null},
 *             fileAt: (path: string, iso: string) => {status: string, content?: string}},
 *   now: number, reentryBudget?: {remaining: number},
 *   targetRepository?: string, localRepository?: string,
 * }} input
 * @returns {{skipped: string|null, results: Array<object>}}
 */
export function planBlockedRecheck({
  body, labels = [], dailyKey, markers = [], io, readers, now, reentryBudget = { remaining: 0 },
  targetRepository = '', localRepository = '',
}) {
  if ((Array.isArray(labels) ? labels : []).includes(DECOMPOSED_PARENT_LABEL)) return { skipped: 'decomposed', results: [] };
  if (bucketState(body) !== 'sealed') return { skipped: 'not-sealed', results: [] };
  const birthBoundIso = bucketBirthBoundIso(dailyKey);
  if (!birthBoundIso) return { skipped: 'invalid-daily-key', results: [] };
  const blocked = parseFollowupItems(body).filter((item) => item.id && item.state === 'blocked');
  if (!blocked.length) return { skipped: 'no-blocked', results: [] };
  const list = Array.isArray(markers) ? markers : [];
  const target = String(targetRepository ?? '').trim().toLowerCase();
  const local = String(localRepository ?? '').trim().toLowerCase();
  const foreign = Boolean(target && local && target !== local);
  const has = (type, id) => list.some((marker) => marker?.type === type && marker.item === id);
  const results = [];
  for (const item of blocked) {
    const since = blockedSince(item.id, list, dailyKey);
    const base = { id: item.id, item, blockedAt: since.at, blockedSource: since.source, reason: since.reason, ageDays: ageDays(since.at, now) };
    if (foreign) { results.push({ ...base, outcome: 'unknown', why: 'foreign-target-repository' }); continue; }
    const bornMarked = has('born-satisfied', item.id);
    const token = hasFalsifiableAcceptance(item.text)
      ? detectAlreadyResolved(item.text, io, { acceptanceToken: item.acceptanceToken })
      : { resolved: false, evidence: [] };
    if (token.resolved && !bornMarked) {
      const born = tokenBornAt(item, io, readers?.fileAt, birthBoundIso);
      if (born === 'not-born') results.push({ ...base, outcome: 'done', evidence: token.evidence || [] });
      else if (born === 'born') results.push({ ...base, outcome: 'born-true', evidence: token.evidence || [], why: 'token-vero-al-conio' });
      else results.push({ ...base, outcome: 'unknown', why: 'born-check-unavailable' });
      continue;
    }
    if (since.reason === 'awaiting-verification') { results.push({ ...base, outcome: 'waiting', why: 'awaiting-verification' }); continue; }
    if (has('unblocked', item.id)) { results.push({ ...base, outcome: 'waiting', why: 'already-reentered' }); continue; }
    const targetPath = itemTargetPath(item);
    if (!targetPath) { results.push({ ...base, outcome: 'waiting', why: 'no-target-file' }); continue; }
    if (!since.at) { results.push({ ...base, outcome: 'unknown', why: 'blocked-at-unknown' }); continue; }
    if (!(Number(reentryBudget?.remaining) > 0)) { results.push({ ...base, outcome: 'waiting', why: 'reentry-cap' }); continue; }
    const read = typeof readers?.commitAfter === 'function' ? readers.commitAfter(targetPath, since.at) : { status: 'error' };
    if (read?.status !== 'ok') { results.push({ ...base, outcome: 'unknown', why: 'commit-read-unavailable' }); continue; }
    const commit = read.commit;
    // `since` di GitHub e' inclusivo: un commit allo stesso istante del blocco non e' «dopo».
    if (!commit?.sha || !(Date.parse(String(commit.date ?? '')) > Date.parse(since.at))) {
      results.push({ ...base, outcome: 'waiting', why: 'no-new-commit', target: targetPath });
      continue;
    }
    reentryBudget.remaining -= 1;
    results.push({ ...base, outcome: 'reenter', target: targetPath, commit: { sha: String(commit.sha), date: String(commit.date) } });
  }
  return { skipped: null, results };
}

/**
 * Il corpo con gli esiti applicati: `done` → `State: done`, rientri →
 * `State: open`. Solo item ancora `blocked`; un ID non aggiornabile resta
 * fuori da `applied`.
 * @returns {{body: string, applied: {done: string[], reentered: string[]}}}
 */
export function applyBlockedRecheck(body, { done = [], reentered = [] } = {}) {
  let next = String(body ?? '');
  const applied = { done: [], reentered: [] };
  const apply = (ids, state, sink) => {
    for (const id of ids) {
      const current = parseFollowupItems(next).find((item) => item.id === id);
      if (current?.state !== 'blocked') continue;
      const updated = updateFollowupItemState(next, id, state);
      if (updated && updated !== next) { next = updated; sink.push(id); }
    }
  };
  apply(done, 'done', applied.done);
  apply(reentered, 'open', applied.reentered);
  return { body: next, applied };
}

function codeSpan(value) {
  const text = inertCommentText(String(value ?? '').replace(/`/gu, ''));
  return text ? `\`${text}\`` : '`?`';
}

/** Commento che registra un token gia' vero alla nascita dell'item (marker in testa). */
export function bornTrueCommentBody({ id, evidence = [], atIso }) {
  const found = (Array.isArray(evidence) ? evidence : []).slice(0, 6)
    .map((entry) => `- ${codeSpan(entry.tok)} in ${codeSpan(entry.file)}`);
  return [
    itemBornSatisfiedMarker({ item: id }),
    `🔎 **Rimisura item bloccato**: il token di accettazione di \`${id}\` era gia' presente nel file entro la fine del giorno del bucket (${atIso}), cioe' entro il conio dell'item. Trovarlo oggi non conferma il lavoro: l'item resta \`blocked\` e non diventa \`done\` per token.`,
    ...found,
  ].join('\n');
}

/** Commento del rientro unico (marker in testa). */
export function unblockedCommentBody({ id, commit, target, blockedAt, blockedSource }) {
  const sinceText = blockedSource === 'marker' ? `dal marker di blocco del ${blockedAt}` : `dall'inizio del giorno del bucket (${blockedAt}), senza marker di blocco datato`;
  return [
    itemUnblockedMarker({ item: id, commit: commit.sha }),
    `🔁 **Rientro item bloccato**: \`${id}\` torna \`open\`. Il commit \`${String(commit.sha).slice(0, 12)}\` del ${inertCommentText(commit.date)} tocca ${codeSpan(target)} dopo il blocco (${sinceText}).`,
    '',
    'Il fixer rimisura il blocco UNA volta: se e\' ancora bloccato lo ridice e l\'item non rientra piu\' (questo marker lo esclude). Un commit nuovo e\' un segnale da rimisurare, non una prova che il blocco sia caduto.',
  ].join('\n');
}

/**
 * Riga di riepilogo della run:
 * `blocked_done=<n> reentered=<n> born_marked=<n> unknown=<n> blocked_waiting=<ID:<eta>d,…>`.
 * `blocked_waiting` elenca ogni item rimasto `blocked` (anche `born-true` e
 * `unknown`) con l'eta' del blocco in giorni.
 */
export function blockedRecheckSummary(results) {
  const list = Array.isArray(results) ? results : [];
  const count = (outcome) => list.filter((entry) => entry.outcome === outcome).length;
  const waiting = list
    .filter((entry) => entry.outcome !== 'done' && entry.outcome !== 'reenter')
    .map((entry) => `${entry.id}:${entry.ageDays ?? '?'}d`);
  return `blocked_done=${count('done')} reentered=${count('reenter')} born_marked=${count('born-true')} unknown=${count('unknown')} blocked_waiting=${waiting.length ? waiting.join(',') : '-'}`;
}
