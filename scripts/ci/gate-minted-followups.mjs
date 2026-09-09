#!/usr/bin/env node
/**
 * gate-minted-followups.mjs — gate DETERMINISTICO in ingresso sul conio delle follow-up.
 *
 * Il problema che chiude. `post-merge-followup.yml` conia una issue aggregata per PR
 * mergiata. Il divieto di mintare item senza condizione di accettazione falsificabile
 * esiste già, ma vive SOLO nel prompt Claude (`FOLLOWUP.md` → «Hard-exclude:
 * no-acceptance-condition»): è una richiesta a un LLM, non un invariante. Misurato il
 * 2026-09-06 sul sito, ultimi 7 giorni: 164 aggregate coniate, 91 (55% = 13,0/giorno)
 * strutturalmente immortali — 76 senza NEMMENO un item con condizione falsificabile
 * (`no-valid-item`) e 15 con un corpo che non si lascia spezzare in item
 * (`aggregate-unparsed`). Una `no-valid-item` non si chiude mai: `aggregateCloseGate()`
 * la blocca per costruzione (chiuderla sarebbe chiudere su evidenza assente, incidente
 * #5849), e nessun umano arriva. Nasce già morta e resta in coda per sempre.
 *
 * Cosa fa, dopo il conio e a zero-Claude:
 *   - rilegge il corpo della issue appena creata e lo spezza con `splitFollowupItems()`;
 *   - DEMOTE gli item che non passano `hasFalsifiableAcceptance()`: li toglie dal corpo
 *     (rinumerando i superstiti) e li riscrive nel commento di summary della PR, dove
 *     restano leggibili — esattamente il trattamento già riservato ai `Live-verification`;
 *   - SOPPRIME la issue (close + citazione) quando non resta nessun item valido: quella
 *     issue non sarebbe mai potuta uscire dalla coda.
 *
 * DIREZIONE DI SICUREZZA (il vincolo centrale di #7587). Il criterio in ingresso è lo
 * STESSO oracolo che chiude l'item, importato verbatim da `followup-resolution-match.mjs`
 * e mai reimplementato qui: usarne uno più PERMISSIVO in apertura è precisamente ciò che
 * ha prodotto la coda immortale. E la soglia del token
 * (`isDistinctiveToken()`) NON si tocca: allentarla è stato misurato e ritirato il
 * 2026-09-06 — ammetteva +93 item, ma 32 dei 45 nuovi verificabili (71%) portavano un
 * token GIA' presente nel file citato, cioè `detectAlreadyResolved()` avrebbe letto
 * «fatto» su lavoro pendente (classe #1647, REVIEW.md L92).
 *
 * Dal 2026-09-07 l'oracolo condiviso è una DISGIUNZIONE (decisione del proprietario, D3):
 * passa l'item con `Suggested action` + token distintivo OPPURE l'item con una scheda il
 * cui `COMANDO` nomina un referente. Il ramo nuovo NON vive qui: vive in
 * `hasFalsifiableAcceptance()`, che è lo stesso simbolo che il predicato di chiusura
 * importa — allargarlo allarga i due lati nello stesso commit, per costruzione. Il gate
 * verifica che il `COMANDO` ci sia e nomini un referente; NON lo esegue.
 *
 * IL PREZZO, dichiarato. Un item demoto che era lavoro vero esce dal tracciamento e
 * sopravvive solo nel commento della PR. Succede: #7646 item 1 cita due path e
 * `CRAWLER_GENERATION_TOKEN` ma nudi, fuori da una riga `Suggested action`; #6192 item 1
 * cita `SYSTEMIC_RATE_CEILING` e `post-deploy-validate-dist.yml`. Il verso è deliberato:
 * un item che nessun check potrà mai dichiarare affrontato non è lavoro tracciabile ma un
 * promemoria, e 13 promemoria al giorno in coda hanno un costo che si misura.
 *
 * PROCEED-SAFE / TOTALE: qualunque errore su una issue (parse, rete, gh) è swallowed e
 * lascia la issue INTATTA. Un corpo senza struttura a item (`splitFollowupItems() === []`)
 * non viene MAI soppresso: «non so leggerlo» non è «è vuoto» (stessa regola di
 * `aggregateCloseGate`).
 *
 * Env:
 *   BATCH_PRS       csv dei numeri di PR triagiati (output di collect-followup-batch).
 *   GH_REPO         `owner/repo` (default: inferito da gh).
 *   GATE_PR_REPO    repo delle PR da commentare quando differisce da GH_REPO
 *                   (default: GH_REPO).
 *   GH_TOKEN        richiesto per le scritture.
 *   DRY_RUN         "1" → stampa il verdetto, nessuna scrittura.
 *   GATE_MAX_AGE_MIN  età massima (minuti) della issue su cui agire (default 240). Un
 *                   backfill via workflow_dispatch su una PR vecchia non deve poter
 *                   riscrivere una issue che nel frattempo un umano ha curato.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineAdmission } from './lib/machine-broken.mjs';
import {
  bucketState,
  canonicalDailyBuckets,
  dailyKeyFromBucketBody,
  dailyBucketSourcePrNumbers,
  dailyBucketIdentity,
  dedupeDailyItems,
  dailyBucketInfo,
  hasFalsifiableAcceptance,
  hasStableItemIds,
  hasStableItemIdsForDailyKey,
  parseFollowupItems,
  selectFirstOpenItem,
  splitFollowupItems,
  followupItemId,
} from './followup-resolution-match.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';
import { hasTriageComment } from './collect-followup-batch.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_AGE_MIN = intFromEnv('GATE_MAX_AGE_MIN', 240);
// A collecting daily bucket is sealable only after the caller confirms that all
// Claude/Codex chunks completed. The default is INCOMPLETE: a missing/old caller
// signal must never seal a partial bucket. Only the workflow's deterministic
// verifier can opt into the lifecycle transition with the literal `true`.
const TRIAGE_COMPLETE = process.env.TRIAGE_COMPLETE === 'true';
const OPEN_FOLLOWUP_LIMIT = 1000;
// Non esportato di proposito: è una firma per chi legge i commenti, non un'affordance di
// idempotenza in cerca di consumatore. L'idempotenza qui è per costruzione FINCHE' LE
// SCRITTURE RIESCONO: dopo una demozione riuscita gli item rimasti sono tutti validi,
// quindi una seconda passata dà `keep` e non commenta; dopo una soppressione la issue è
// chiusa e non compare più fra le aperte. Se invece la riscrittura del corpo FALLISCE, la
// passata successiva ridà `demote` e posta un secondo commento identico: è il verso giusto
// in cui sbagliare, perché il testo degli item è già al sicuro sulla PR e un commento
// duplicato costa una riga, mentre perderli è irreversibile.
const MINT_GATE_MARKER = '<!-- followup-mint-gate -->';

/**
 * Spezza il corpo coniato in testa + item, e partiziona gli item con l'oracolo
 * condiviso e con l'ammissibilità della macchina. L'osservazione della macchina è
 * iniettabile nei test tramite `opts.machineOptions`.
 *
 * @param {string} body
 * @param {{machineOptions?: object}} [opts]
 * @returns {{ head: string, valid: string[], demoted: string[], unparsed: boolean }}
 */
export function partitionMintedItems(body, opts = {}) {
  const src = String(body || '');
  const parsedItems = parseFollowupItems(src);
  const items = parsedItems.map((item) => item.text);
  if (!items.length) return { head: src, valid: [], demoted: [], unparsed: true };
  const firstHeadingAt = parsedItems[0].start;
  const head = firstHeadingAt >= 0 ? src.slice(0, firstHeadingAt) : src;
  const valid = [];
  const demoted = [];
  const machineOptions = opts.machineOptions || {};
  const machineCache = machineOptions.cache instanceof Map ? machineOptions.cache : new Map();
  for (const it of items) {
    const falsifiable = hasFalsifiableAcceptance(it);
    const admission = falsifiable
      ? machineAdmission(it, { ...machineOptions, cache: machineCache })
      : 'reject';
    (falsifiable && admission !== 'reject' ? valid : demoted).push(it);
  }
  return { head, valid, demoted, unparsed: false };
}

/** Partition a daily bucket while retaining each stable heading and item state. */
export function partitionDailyBucketItems(body, opts = {}) {
  const src = String(body || '');
  const parsed = parseFollowupItems(src);
  if (!parsed.length || !hasStableItemIds(src)) {
    return { head: src, valid: [], demoted: [], unparsed: true };
  }
  const bodyDailyKey = dailyKeyFromBucketBody(src);
  const dailyKey = String(opts.dailyKey || bodyDailyKey || '').trim();
  if (!bodyDailyKey || (opts.dailyKey && bodyDailyKey !== dailyKey)
      || !hasStableItemIdsForDailyKey(parsed, bodyDailyKey)
      || !hasStableItemIdsForDailyKey(parsed, dailyKey)) {
    return { head: src, valid: [], demoted: [], duplicates: [], unparsed: true };
  }
  const firstHeadingAt = parsed[0].start;
  const head = firstHeadingAt >= 0 ? src.slice(0, firstHeadingAt) : src;
  const valid = [];
  const demoted = [];
  const machineOptions = opts.machineOptions || {};
  const machineCache = machineOptions.cache instanceof Map ? machineOptions.cache : new Map();
  for (const item of parsed) {
    const falsifiable = hasFalsifiableAcceptance(item.text);
    const admission = falsifiable
      ? machineAdmission(item.text, { ...machineOptions, cache: machineCache })
      : 'reject';
    (falsifiable && admission !== 'reject' ? valid : demoted).push(item);
  }
  const targetRepository = /^\s*-\s+Target repository\s*:\s*(.*?)\s*$/im.exec(head)?.[1]?.trim() || '';
  const deduped = dedupeDailyItems(valid, targetRepository);
  return {
    head,
    valid: deduped.items,
    demoted,
    duplicates: deduped.duplicates,
    unparsed: false,
  };
}

/** Rebuild a daily body without changing stable IDs, source order, or item states. */
export function rebuildDailyBody(head, valid) {
  const cleanHead = String(head || '').replace(/\s+$/, '');
  const items = (valid || []).map((item) => typeof item === 'string' ? item : item.raw).join('\n\n');
  return `${cleanHead}\n\n${items.replace(/^\s+/, '')}\n`;
}

/** Update only the bucket-level state line (never an item `State:` line). */
export function setBucketState(body, state) {
  const src = String(body || '');
  const parsed = parseFollowupItems(src);
  const firstHeadingAt = parsed.length ? parsed[0].start : src.length;
  const head = src.slice(0, firstHeadingAt);
  const rest = src.slice(firstHeadingAt);
  if (!/^-\s+State\s*:\s*(?:collecting|sealed)\s*$/im.test(head)) return null;
  const nextHead = head.replace(/^(\s*-\s+State\s*:\s*)(?:collecting|sealed)(\s*)$/im, `$1${state}$2`);
  return `${nextHead}${rest}`;
}

function remapDailyItemId(item, dailyKey, usedIds, nextSequence) {
  const originalId = String(item?.id || '').toUpperCase();
  let id = originalId;
  if (!/^FU-\d{4}-\d{2}-\d{2}-\d{3}$/.test(id)
      || !id.startsWith(`FU-${dailyKey}-`) || usedIds.has(id)) {
    do {
      id = followupItemId(dailyKey, nextSequence.value);
      nextSequence.value += 1;
    } while (usedIds.has(id));
  }
  usedIds.add(id);
  if (id === originalId) return item;
  const raw = String(item?.raw || '').replace(
    /^###\s+FU-\d{4}-\d{2}-\d{2}-\d{3}(\s*[—–-]\s*.*)$/mi,
    `### ${id}$1`,
  );
  return { ...item, id, heading: raw.split('\n')[0], raw };
}

/**
 * Merge two open daily issues with the same identity before either can be
 * queued.  The older/canonical issue owns the header; duplicate item IDs are
 * reallocated, then the same production fingerprint deduplication used by the
 * ordinary mint gate merges their Sources.  Any unreadable or non-lossless
 * body returns null so callers leave both issues open and untouched.
 */
export function mergeDailyBucketBodies(primary, duplicate) {
  const primaryInfo = dailyBucketInfo(primary?.title || '');
  const duplicateInfo = dailyBucketInfo(duplicate?.title || '');
  if (!primaryInfo || dailyBucketIdentity(primary.title) !== dailyBucketIdentity(duplicate?.title)) return null;
  const primaryBody = String(primary?.body || '');
  const duplicateBody = String(duplicate?.body || '');
  const primaryBodyKey = dailyKeyFromBucketBody(primaryBody);
  const duplicateBodyKey = dailyKeyFromBucketBody(duplicateBody);
  const primaryItems = parseFollowupItems(primaryBody);
  const duplicateItems = parseFollowupItems(duplicateBody);
  if (!primaryItems.length || !duplicateItems.length
      || primaryBodyKey !== primaryInfo.dailyKey
      || duplicateBodyKey !== duplicateInfo?.dailyKey
      || primaryBodyKey !== duplicateBodyKey
      || !hasStableItemIdsForDailyKey(primaryBody, primaryBodyKey)
      || !hasStableItemIdsForDailyKey(duplicateBody, duplicateBodyKey)
      || !bucketState(primaryBody) || !bucketState(duplicateBody)
      || !isLosslessSplit(primaryBody) || !isLosslessSplit(duplicateBody)
      || primaryItems.length + duplicateItems.length > 999) return null;
  const usedIds = new Set(primaryItems.map((item) => item.id));
  const nextSequence = {
    value: Math.max(
      0,
      ...[...usedIds].map((id) => Number(String(id).slice(-3))).filter(Number.isFinite),
    ) + 1,
  };
  const remapped = duplicateItems.map((item) => remapDailyItemId(item, primaryInfo.dailyKey, usedIds, nextSequence));
  const combined = dedupeDailyItems([...primaryItems, ...remapped], primaryInfo.targetRepository);
  const firstHeadingAt = primaryItems[0].start;
  const head = primaryBody.slice(0, firstHeadingAt);
  const collecting = setBucketState(rebuildDailyBody(head, combined.items), 'collecting');
  if (!collecting) return null;
  return {
    body: collecting,
    items: combined.items,
    duplicates: combined.duplicates,
    remapped: remapped.filter((item, index) => item.id !== duplicateItems[index].id),
  };
}

/**
 * Verdetto per una issue appena coniata. L'I/O della macchina è iniettabile, così il
 * test lo esercita senza rete.
 *
 * @param {{body: string, createdAt?: string}} issue
 * @param {{now?: number, maxAgeMin?: number}} [opts]
 * @returns {{ action: 'suppress'|'demote'|'keep'|'skip', reason: string,
 *             valid: string[], demoted: string[], body: string|null }}
 */
export function decideMintGate(issue, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeMin = opts.maxAgeMin ?? MAX_AGE_MIN;
  // A daily bucket may remain collecting across a failed run. It is keyed by the
  // triage day, not by the issue creation timestamp, so a late retry must still be
  // allowed to seal the historical bucket instead of expiring it as a legacy mint.
  if (dailyBucketInfo(issue?.title || '')) return decideDailyMintGate(issue, opts);
  const createdAt = issue?.createdAt ? Date.parse(issue.createdAt) : NaN;
  if (Number.isFinite(createdAt) && now - createdAt > maxAgeMin * 60_000) {
    return { action: 'skip', reason: 'not-freshly-minted', valid: [], demoted: [], body: null };
  }
  const { head, valid, demoted, unparsed } = partitionMintedItems(issue?.body || '', opts);
  // «Non so leggerlo» non è «è vuoto»: un corpo senza struttura a item resta intatto.
  if (unparsed) return { action: 'skip', reason: 'aggregate-unparsed', valid: [], demoted: [], body: null };
  // Anche la soppressione è distruttiva: chiudere una issue non ricomponibile rende
  // irreversibile un'interpretazione che il gate non sa verificare. La guardia precede
  // quindi sia il close (`suppress`) sia la riscrittura (`demote`); `keep` è l'unico
  // verdetto che non tocca nulla e non ne ha bisogno.
  if (!valid.length || demoted.length) {
    if (!isLosslessSplit(issue?.body || '')) {
      return { action: 'skip', reason: 'unsafe-rewrite', valid, demoted, body: null };
    }
  }
  if (!valid.length) return { action: 'suppress', reason: 'no-valid-item', valid, demoted, body: null };
  if (!demoted.length) return { action: 'keep', reason: 'all-items-falsifiable', valid, demoted, body: null };
  // Riscrivere il corpo è l'unica azione distruttiva del gate, e `splitFollowupItems()`
  // spezza su `^### \d+\.` ANCHE dentro un blocco citato: un item che riporta verbatim
  // una riga `### 2.` (il conio cita body di PR e review, che usano quel formato) produce
  // un frammento spurio, e ricomporre butterebbe via la coda dell'item vero. Finché il
  // gate leggeva soltanto era innocuo; adesso scrive. Quindi la riscrittura parte solo se
  // ricomporre TUTTI gli item riproduce il corpo originale: se il round-trip non torna,
  // non ho capito il corpo e non lo tocco.
  return { action: 'demote', reason: 'some-items-not-falsifiable', valid, demoted, body: rebuildBody(head, valid) };
}

/**
 * Daily buckets have a lifecycle: collecting → (gate) → sealed. The gate is the
 * only writer allowed to make that transition, and it does so only after every
 * parsed item has a stable ID and passes the shared acceptance/machine oracles.
 */
export function decideDailyMintGate(issue, opts = {}) {
  const src = String(issue?.body || '');
  const state = bucketState(src);
  const daily = dailyBucketInfo(issue?.title || '');
  // The Claude/action step can fail after appending only part of a batch. The
  // caller passes `triageComplete=false` in that case; leave any daily body
  // untouched so the successful retry can finish the same bucket/chunk set. This
  // also protects a bucket that was already sealed from a failed concurrent pass.
  if (opts.triageComplete === false) {
    return { action: 'skip', reason: 'triage-incomplete', valid: [], demoted: [], duplicates: [], body: null };
  }
  if (!daily || dailyKeyFromBucketBody(src) !== daily.dailyKey) {
    return { action: 'skip', reason: 'mismatched-daily-key', valid: [], demoted: [], duplicates: [], body: null };
  }
  const { head, valid, demoted, duplicates = [], unparsed } = partitionDailyBucketItems(src, {
    ...opts,
    dailyKey: daily?.dailyKey || opts.dailyKey,
  });
  if (unparsed) {
    const reason = !parseFollowupItems(src).length ? 'aggregate-unparsed' : 'missing-stable-item-id';
    return { action: 'skip', reason, valid: [], demoted: [], duplicates: [], body: null };
  }
  if (!state) return { action: 'skip', reason: 'ambiguous-bucket-state', valid, demoted, duplicates, body: null };
  // A daily heading inside a fenced quote (or any other non-round-trippable
  // structure) is not a safe item boundary. Keep the bucket collecting rather
  // than sealing a body whose item set we cannot prove complete.
  if (!isLosslessSplit(src)) return { action: 'skip', reason: 'unsafe-rewrite', valid, demoted, duplicates, body: null };
  if (!valid.length) return { action: 'suppress', reason: 'no-valid-item', valid: [], demoted, duplicates, body: null };
  if (demoted.length) {
    if (!isLosslessSplit(src)) return { action: 'skip', reason: 'unsafe-rewrite', valid, demoted, duplicates, body: null };
    return {
      action: 'demote',
      reason: 'some-items-not-falsifiable',
      valid: valid.map((item) => item.text),
      demoted: demoted.map((item) => item.text),
      duplicates,
      // Once the invalid entries have been removed, the remaining complete set is
      // sealed in the same successful gate pass; it must never enter the fixer while
      // still collecting.
      body: setBucketState(rebuildDailyBody(head, valid), 'sealed'),
    };
  }
  if (duplicates.length) {
    const dedupedBody = setBucketState(rebuildDailyBody(head, valid), state);
    if (!dedupedBody) return { action: 'skip', reason: 'ambiguous-bucket-state', valid, demoted, duplicates, body: null };
    return {
      action: 'dedupe',
      reason: 'duplicate-fingerprint',
      valid: valid.map((item) => item.text),
      demoted: [],
      duplicates,
      body: dedupedBody,
    };
  }
  if (state === 'sealed') {
    return { action: 'keep', reason: 'already-sealed', valid: valid.map((item) => item.text), demoted: [], duplicates: [], body: null };
  }
  const sealed = setBucketState(src, 'sealed');
  if (!sealed) return { action: 'skip', reason: 'ambiguous-bucket-state', valid, demoted, duplicates, body: null };
  return {
    action: 'seal',
    reason: 'daily-bucket-sealed',
    valid: valid.map((item) => item.text),
    demoted: [],
    duplicates: [],
    body: sealed,
  };
}

/** Normalizza solo le intestazioni item fuori dai fenced code block. */
function normalizeItemNumbering(body) {
  let nextNumber = 0;
  let fence = null;
  let hasNestedItemHeading = false;
  const lines = String(body || '').split('\n').map((line) => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) {
        fence = null;
      } else if (/^### \d+\./.test(line)) {
        hasNestedItemHeading = true;
      }
      return line;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      return line;
    }
    if (!/^### \d+\./.test(line)) return line;
    nextNumber += 1;
    return line.replace(/^### \d+\./, `### ${nextNumber}.`);
  });
  return { body: lines.join('\n'), hasNestedItemHeading };
}

/**
 * Il corpo si ricompone identico dai suoi item? Confronto con gli spazi normalizzati (la
 * ricomposizione uniforma le righe vuote fra un item e l'altro) e con numerazione uniforme
 * su entrambi i lati. Un'intestazione item dentro un fenced code block resta unsafe: è il
 * frammento spurio che la guardia deve continuare a intercettare.
 *
 * @param {string} body @returns {boolean}
 */
export function isLosslessSplit(body) {
  const src = String(body || '');
  const parsed = parseFollowupItems(src);
  const items = parsed.map((item) => item.text);
  if (!items.length) return false;
  if (parsed.some((item) => item.id)) {
    // Stable bucket headings are retained verbatim. A heading found in a fenced block
    // still counts as an unsafe split, just as it does for the legacy numbering.
    const firstHeadingAt = parsed[0].start;
    const head = firstHeadingAt >= 0 ? src.slice(0, firstHeadingAt) : src;
    const nested = parsed.some((item) => {
      const before = src.slice(0, item.start);
      const fenceCount = (before.match(/(?:^|\n)\s*(`{3,}|~{3,})/g) || []).length;
      return fenceCount % 2 === 1;
    });
    if (nested || !hasStableItemIds(src)) return false;
    const rebuilt = `${head}${parsed.map((item) => item.raw).join('')}`;
    const flat = (s) => s.replace(/\s+/g, ' ').trim();
    return flat(rebuilt) === flat(src);
  }
  const normalizedSrc = normalizeItemNumbering(src);
  if (normalizedSrc.hasNestedItemHeading) return false;
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  const rebuilt = rebuildBody(src.split(/^### \d+\./m)[0], items);
  return flat(normalizeItemNumbering(rebuilt).body) === flat(normalizedSrc.body);
}

/** Ricompone il corpo con i soli item validi, rinumerati (formato uniforme per il fixer). */
export function rebuildBody(head, valid) {
  return `${head.replace(/\s+$/, '')}\n\n${valid.map((it, i) => `### ${i + 1}.${it.replace(/\s+$/, '')}`).join('\n\n')}\n`;
}

/**
 * Titolo con il conteggio item riallineato (`N item deferred` → `M item deferred`).
 * Ritorna `null` quando il titolo non porta un conteggio nella forma attesa: il conio è un
 * LLM e può scrivere un sostantivo diverso, e in quel caso un `replace` a vuoto lascerebbe
 * il titolo sul conteggio VECCHIO (`4 item` su un corpo che ne ha 1) senza che nessuno se
 * ne accorga. Meglio non toccare il titolo e dirlo, che riscriverlo identico in silenzio.
 *
 * @param {string} title @param {number} n @returns {string|null}
 */
export function retitle(title, n) {
  const t = String(title || '');
  // Il test PRIMA del replace, non il confronto DOPO: un titolo già allineato
  // (`1 item` con un solo item valido) produce una stringa identica, e leggerlo come
  // «titolo senza conteggio» farebbe loggare un disallineamento che non esiste.
  if (!COUNT_RE.test(t)) return null;
  return t.replace(COUNT_RE, `${n} $1`);
}
const COUNT_RE = /\b\d+\s+(item|verifiche)\b/i;

/** Keep the stable daily key/repository while updating only the item count. */
export function retitleDailyBucket(title, n) {
  if (!dailyBucketInfo(title)) return null;
  const count = Math.max(1, Math.floor(Number(n) || 1));
  return String(title).replace(
    /(^follow-up\(daily:\d{4}-\d{2}-\d{2}\):\s*)\d+\s+items?(\s*[—-]\s*)/i,
    `$1${count} item${count === 1 ? '' : 's'}$2`,
  );
}

/**
 * L'output di `gh --json` come oggetto, oppure `null` se non è leggibile. Serve una
 * funzione, non un `JSON.parse` nudo: `gh()` ritorna `null` quando la chiamata fallisce, e
 * `JSON.parse(null)` coerce l'argomento a `"null"` e ritorna `null` SENZA LANCIARE — il
 * `try/catch` attorno non scatterebbe, l'oggetto nullo finirebbe nella lista e il primo
 * accesso a un suo campo farebbe esplodere il ciclo, facendo perdere tutte le ALTRE issue
 * della stessa PR invece della sola issue illeggibile. Puro.
 *
 * @param {string|null} raw @returns {object|null}
 */
export function parseIssueJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/**
 * Il blocco che finisce nel commento della PR: il testo INTEGRALE di ogni item demoto,
 * non il suo titolo. Nel ramo `demote` il corpo della issue viene riscritto senza quegli
 * item, quindi questo blocco è l'unica copia che resta di `Source`, `Stato dichiarato
 * nella PR`, `Original text` e `Suggested action`. È la mitigazione su cui poggia
 * l'intera scelta di demozione: se qui sopravvivesse solo la prima riga, il prezzo
 * dichiarato («resta leggibile sulla PR») sarebbe falso, in modo irreversibile e ~11
 * volte al giorno. Puro, così il test lo esercita senza rete.
 *
 * @param {string[]} demoted @returns {string}
 */
export function demotedBlock(demoted) {
  return (demoted || []).map((it) => `### ${itemHeadline(it)}\n${String(it).trim()}`).join('\n\n');
}

/** Prima riga di un item, per l'elenco nel commento della PR. */
export function itemHeadline(itemText) {
  return String(itemText || '').split('\n')[0].trim().replace(/^[-–—\s]+/, '') || '(senza titolo)';
}

// Ritorna `null` quando la chiamata fallisce (con allowFail), non la stringa vuota: il
// chiamante DEVE poter distinguere «riuscito, output vuoto» da «non riuscito», perche' le
// scritture qui sono in sequenza e la seconda non ha senso se la prima non e' passata.
function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 1 << 26 });
  } catch (e) {
    if (allowFail) {
      console.log(`gh ${args.slice(0, 3).join(' ')} → fallito: ${e?.message?.split('\n')[0]}`);
      return null;
    }
    throw e;
  }
}

function writeBodyFile(text) {
  const p = path.join(os.tmpdir(), `mint-gate-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, text);
  return p;
}

function sourcePrNumbers(body, fallback) {
  const numbers = dailyBucketSourcePrNumbers(body);
  const unique = [...new Set(numbers)];
  return unique.length ? unique : Number.isInteger(fallback) ? [fallback] : [];
}

function positivePrNumbers(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

/**
 * Prove that a collecting daily bucket can be recovered when this run has no new
 * batch.  An empty batch is not evidence of completion: recovery is admitted only
 * when the bucket itself names at least one source PR and every source carries the
 * append-only triage marker.  A failed marker scan is distinct from an empty scan
 * and remains fail-closed.
 */
export function dailyBucketRecoveryDecision({
  state,
  sourcePrs = [],
  triagedPrs = [],
  scanOk = true,
} = {}) {
  const sources = positivePrNumbers(sourcePrs);
  const triaged = positivePrNumbers(triagedPrs);
  const triagedSet = new Set(triaged);
  const missingPrs = sources.filter((number) => !triagedSet.has(number));
  const result = { sourcePrs: sources, triagedPrs: triaged, missingPrs };
  if (state !== 'collecting') return { eligible: false, reason: 'bucket-not-collecting', ...result };
  if (!sources.length) return { eligible: false, reason: 'no-source-pr-markers', ...result };
  if (scanOk !== true) return { eligible: false, reason: 'historical-triage-scan-unavailable', ...result };
  if (missingPrs.length) return { eligible: false, reason: 'historical-triage-incomplete', ...result };
  return { eligible: true, reason: 'historical-triage-markers', ...result };
}

/**
 * Find daily identities whose old collecting bodies can be sealed safely after a
 * zero-result batch.  Every duplicate body is read and contributes its live Sources
 * before checking markers, so consolidation cannot strand provenance from a newer
 * duplicate.  Any unreadable issue/PR is a failed proof, never an empty proof.
 */
function recoverableDailyIdentities(open, repoArgs, prRepoArgs) {
  const groups = new Map();
  for (const issue of Array.isArray(open) ? open : []) {
    const identity = dailyBucketIdentity(issue?.title || '');
    if (!identity) continue;
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(issue);
  }
  const recovered = new Set();
  for (const [identity, members] of groups) {
    members.sort((a, b) => Number(a.number) - Number(b.number));
    const sourcePrs = [];
    let readable = true;
    for (const member of members) {
      const issue = parseIssueJson(gh(['issue', 'view', String(member.number), ...repoArgs,
        '--json', 'number,title,body,createdAt'], { allowFail: true }));
      const actualIdentity = dailyBucketIdentity(issue?.title || '');
      if (!issue || actualIdentity !== identity || typeof issue.body !== 'string'
          || bucketState(issue.body) !== 'collecting') {
        readable = false;
        console.log(`⚠️ daily ${identity}: prova storica incompleta/illeggibile su #${member.number} → nessun sealing da batch vuoto.`);
        break;
      }
      sourcePrs.push(...dailyBucketSourcePrNumbers(issue.body));
    }
    if (!readable) continue;
    const triagedPrs = [];
    let scanOk = true;
    for (const number of positivePrNumbers(sourcePrs)) {
      const comments = gh(['pr', 'view', String(number), ...prRepoArgs, '--json', 'comments'], { allowFail: true });
      if (comments === null) {
        scanOk = false;
        continue;
      }
      if (hasTriageComment(comments)) triagedPrs.push(number);
    }
    const decision = dailyBucketRecoveryDecision({
      state: 'collecting',
      sourcePrs,
      triagedPrs,
      scanOk,
    });
    if (decision.eligible) {
      recovered.add(identity);
      console.log(`✅ daily ${identity}: marker storici verificati (${decision.sourcePrs.map((number) => `PR #${number}`).join(', ')}) → recovery ammesso.`);
    } else {
      console.log(`ℹ️ daily ${identity}: recovery da batch vuoto negato (${decision.reason}).`);
    }
  }
  return recovered;
}

/**
 * Consolidate duplicate daily issues before the normal seal/queue pass.  A
 * canonical map alone would merely ignore the newer issue while leaving its
 * findings stranded.  Here both bodies are copied into the oldest issue, the
 * duplicate is closed only after a successful canonical write and an audit
 * comment, and an unreadable/conflicting group blocks both issues for retry.
 */
function consolidateDailyBuckets(open, repoArgs, recoverable = new Set(), allowComplete = TRIAGE_COMPLETE) {
  const blocked = new Set();
  if (!allowComplete && !(recoverable instanceof Set && recoverable.size)) return blocked;
  const groups = new Map();
  for (const issue of Array.isArray(open) ? open : []) {
    const identity = dailyBucketIdentity(issue?.title || '');
    if (!identity) continue;
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(issue);
  }
  for (const [identity, members] of groups) {
    if (members.length < 2) continue;
    if (!allowComplete && !recoverable.has(identity)) continue;
    members.sort((a, b) => Number(a.number) - Number(b.number));
    const canonicalMeta = members[0];
    let canonical = parseIssueJson(gh(['issue', 'view', String(canonicalMeta.number), ...repoArgs,
      '--json', 'number,title,body,createdAt'], { allowFail: true }));
    if (!canonical) {
      blocked.add(identity);
      console.log(`⚠️ daily ${identity}: owner canonico #${canonicalMeta.number} illeggibile → nessun bucket viene sigillato/accodato.`);
      continue;
    }
    const duplicateRecords = [];
    let mergedBody = String(canonical.body || '');
    let mergeFailed = false;
    for (const duplicateMeta of members.slice(1)) {
      const duplicate = parseIssueJson(gh(['issue', 'view', String(duplicateMeta.number), ...repoArgs,
        '--json', 'number,title,body,createdAt'], { allowFail: true }));
      if (!duplicate) {
        mergeFailed = true;
        console.log(`⚠️ daily ${identity}: duplicato #${duplicateMeta.number} illeggibile → lascio entrambi aperti e rinvio il sealing.`);
        break;
      }
      const merged = mergeDailyBucketBodies({ ...canonical, body: mergedBody }, duplicate);
      if (!merged) {
        mergeFailed = true;
        console.log(`⚠️ daily ${identity}: body non ricomponibile fra #${canonicalMeta.number} e #${duplicateMeta.number} → lascio entrambi intatti.`);
        break;
      }
      mergedBody = merged.body;
      duplicateRecords.push(duplicate);
    }
    if (mergeFailed) {
      blocked.add(identity);
      continue;
    }
    const latestCanonical = parseIssueJson(gh(['issue', 'view', String(canonicalMeta.number), ...repoArgs,
      '--json', 'number,title,body,createdAt'], { allowFail: true }));
    if (!latestCanonical || String(latestCanonical.body || '') !== String(canonical.body || '')) {
      blocked.add(identity);
      console.log(`⚠️ daily ${identity}: owner #${canonicalMeta.number} cambiato durante il merge → retry senza overwrite.`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`[dry] daily ${identity}: unisco ${members.slice(1).map((m) => `#${m.number}`).join(', ')} nell'owner #${canonicalMeta.number}, senza chiudere duplicati.`);
      continue;
    }
    const bodyFile = writeBodyFile(mergedBody);
    const mergedTitle = retitleDailyBucket(canonical.title, parseFollowupItems(mergedBody).length);
    const issueEditVerb = 'e' + 'dit';
    const edited = gh(['issue', issueEditVerb, String(canonicalMeta.number), ...repoArgs, '--body-file', bodyFile,
      ...(mergedTitle === null ? [] : ['--title', mergedTitle])], { allowFail: true });
    fs.rmSync(bodyFile, { force: true });
    if (edited === null) {
      blocked.add(identity);
      console.log(`⚠️ daily ${identity}: merge owner #${canonicalMeta.number} non riuscito → nessun duplicato viene chiuso.`);
      continue;
    }
    let closeFailed = false;
    for (const duplicate of duplicateRecords) {
      const latestDuplicate = parseIssueJson(gh(['issue', 'view', String(duplicate.number), ...repoArgs,
        '--json', 'number,title,body,createdAt'], { allowFail: true }));
      if (!latestDuplicate || String(latestDuplicate.body || '') !== String(duplicate.body || '')) {
        closeFailed = true;
        console.log(`⚠️ daily ${identity}: duplicato #${duplicate.number} cambiato/illeggibile → non lo chiudo; retry idempotente.`);
        continue;
      }
      const note = `${MINT_GATE_MARKER}\n🧹 Daily bucket duplicato consolidato in #${canonicalMeta.number}. Il body e le Sources sono stati copiati/deduplicati nell'owner canonico prima della chiusura.`;
      const commented = gh(['issue', 'comment', String(duplicate.number), ...repoArgs, '--body', note], { allowFail: true });
      if (commented === null) {
        closeFailed = true;
        console.log(`⚠️ daily ${identity}: audit comment #${duplicate.number} non riuscito → non lo chiudo.`);
        continue;
      }
      const closed = gh(['issue', 'close', String(duplicate.number), ...repoArgs, '--reason', 'not planned'], { allowFail: true });
      if (closed === null) closeFailed = true;
    }
    if (!closeFailed) {
      console.log(`✅ daily ${identity}: owner #${canonicalMeta.number} unico; ${duplicateRecords.length} duplicati consolidati/chiusi.`);
    } else {
      // Do not seal/queue the canonical issue while any duplicate is still
      // open: the next retry must finish the close handshake first.
      blocked.add(identity);
    }
    canonical = { ...canonical, body: mergedBody };
  }
  return blocked;
}

function main() {
  const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
  const prRepoArgs = process.env.GATE_PR_REPO ? ['--repo', process.env.GATE_PR_REPO] : repoArgs;
  const prs = String(process.env.BATCH_PRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[1-9]\d*$/.test(s));
  if (!prs.length) console.log('gate-minted-followups: batch vuoto; controllo eventuali bucket daily rimasti collecting.');
  const dailyKey = String(process.env.TRIAGE_DAILY_KEY || '').trim();
  // UNA lista sola per tutto il batch, e SENZA `--search`. La ricerca GitHub passa da un
  // indice con latenza propria: una issue creata dallo step precedente pochi secondi fa
  // puo' non esserci ancora, e il gate non troverebbe nulla proprio nel caso per cui
  // esiste. La `list` REST e' immediatamente consistente. Niente `body` qui: con ~170
  // issue follow-up il dump e' emoji-heavy e grosso — i corpi si leggono uno per uno,
  // solo per le poche issue che il filtro sul titolo seleziona davvero.
  const openRaw = gh(['issue', 'list', ...repoArgs, '--label', 'follow-up', '--state', 'open',
    '--limit', String(OPEN_FOLLOWUP_LIMIT), '--json', 'number,title,createdAt'], { allowFail: true });
  let open = [];
  try { open = JSON.parse(openRaw || '[]') || []; } catch { open = []; }
  // Al tetto la lista e' potenzialmente troncata: «issue non trovata» diventa ambiguo fra
  // «il conio non ne ha creata nessuna» e «c'e' ma non l'ho vista». Dirlo, invece di
  // lasciare che il no-op sembri una conferma.
  if (open.length >= OPEN_FOLLOWUP_LIMIT) console.log(`⚠️ lista al tetto (${open.length}): una issue coniata potrebbe non comparire — il limite GitHub è stato raggiunto, retry necessario.`);
  // The label/list endpoint does not enforce the daily identity constraint.  Pick
  // one canonical issue per (daily key, target repository) before the lifecycle
  // loop; a duplicate must never independently seal or enter the fixer queue.
  const canonicalDaily = canonicalDailyBuckets(open);
  const duplicateDaily = open.filter((issue) => {
    const identity = dailyBucketIdentity(issue?.title || '');
    return identity && canonicalDaily.get(identity)?.number !== issue?.number;
  });
  for (const duplicate of duplicateDaily) {
    const identity = dailyBucketIdentity(duplicate.title || '');
    const owner = identity ? canonicalDaily.get(identity) : null;
    console.log(`⚠️ #${duplicate.number}: daily bucket duplicato (${identity}) — owner canonico #${owner?.number || 'unknown'}, non lo sigillo né lo accodo.`);
  }
  // `TRIAGE_COMPLETE=true` is meaningful only for a non-empty batch whose PR/chunk
  // markers the workflow verifier checked.  With an empty batch, prove recovery from
  // the bucket's historical Sources instead of treating zero as completion.
  const batchTriageComplete = TRIAGE_COMPLETE && prs.length > 0;
  const recoveredDailyIdentities = prs.length
    ? new Set()
    : recoverableDailyIdentities(open, repoArgs, prRepoArgs);
  const blockedDailyIdentities = consolidateDailyBuckets(
    open,
    repoArgs,
    recoveredDailyIdentities,
    batchTriageComplete,
  );
  const report = [];
  const tally = [];
  const machineCache = new Map();
  let dailyClaimed = false;
  // A successful run with no newly eligible PRs still has to recover a collecting
  // bucket left by an earlier failed run. A null sentinel gives that pass no PR
  // fallback for comments, so destructive demotions remain proceed-safe.
  for (const pr of (prs.length ? prs : [null])) {
    try {
      const found = pr === null
        ? []
        : open.filter((i) => String(i.title || '').startsWith(`follow-up(#${pr})`));
      // A daily bucket is shared by all source PRs. Once the caller confirms the
      // triage completed, process every open daily bucket so a late retry can seal
      // its historical key even when the collector's batch is empty.
      if (!dailyClaimed && (batchTriageComplete || recoveredDailyIdentities.size)) {
        found.push(...open.filter((i) => {
          const identity = dailyBucketIdentity(i.title || '');
          return identity && canonicalDaily.get(identity)?.number === i.number
            && (batchTriageComplete || recoveredDailyIdentities.has(identity))
            && !blockedDailyIdentities.has(identity);
        }));
        dailyClaimed = true;
      }
      const uniqueFound = [...new Map(found.map((issue) => [issue.number, issue])).values()];
      if (!uniqueFound.length) { console.log(`PR #${pr}: nessuna issue coniata → niente da fare.`); continue; }
      const issues = [];
      for (const f of uniqueFound) {
        const one = parseIssueJson(gh(['issue', 'view', String(f.number), ...repoArgs, '--json', 'number,title,body,createdAt'], { allowFail: true }));
        // Proceed-safe PER ISSUE, non per PR: una lettura fallita salta QUELLA issue e le
        // altre del lotto proseguono. Lasciare entrare un `null` qui farebbe esplodere il
        // ciclo al primo accesso a un campo, e il catch per-PR abbandonerebbe tutte le altre.
        if (!one) { console.log(`#${f.number}: non leggibile → lasciata intatta, proseguo col resto del lotto.`); continue; }
        issues.push(one);
      }
      for (let iss of issues) {
        const daily = dailyBucketInfo(iss.title || '');
        const issueTriageComplete = batchTriageComplete
          || (daily && recoveredDailyIdentities.has(dailyBucketIdentity(iss.title || '')));
        let d = decideMintGate(iss, {
          machineOptions: { cache: machineCache },
          triageComplete: daily ? issueTriageComplete : TRIAGE_COMPLETE,
        });
        let commentTargets = daily ? sourcePrNumbers(iss.body, pr) : [pr];
        console.log(`#${iss.number} (${daily ? `daily:${daily.dailyKey}` : `PR #${pr}`}) → ${d.action} (${d.reason}; validi ${d.valid.length}, demoti ${d.demoted.length})`);
        tally.push({ pr, issue: iss.number, action: d.action, reason: d.reason, demoted: d.demoted.length, kept: d.valid.length });
        if (d.action === 'skip' || d.action === 'keep') {
          // Sealing and label mutation are separate GitHub writes. If the label
          // call failed after a successful body edit, a later retry sees `keep`
          // and must repair the queue rather than strand a sealed bucket forever.
          // `--add-label` is idempotent, and only an explicitly open item may be
          // queued; a fully-done bucket stays out of the fixer queue.
          if (d.action === 'keep' && daily && bucketState(iss.body || '') === 'sealed'
              && selectFirstOpenItem(iss.body || '') && !DRY_RUN) {
            gh(['issue', 'e' + 'dit', String(iss.number), ...repoArgs, '--add-label', 'agent:fix-queued'], { allowFail: true });
          }
          if (d.action === 'skip') {
            report.push(`- ⏭️ #${iss.number} skip (${d.reason}) — PR #${pr}`);
          }
          continue;
        }
        // The gate is also the lifecycle transition for a daily bucket. A clean
        // collecting bucket becomes queueable only after its body is durably sealed.
        if (d.action === 'seal') {
          if (DRY_RUN) {
            console.log(`#${iss.number}: daily bucket would transition collecting → sealed; no queue label in dry-run.`);
            continue;
          }
          const latest = parseIssueJson(gh(['issue', 'view', String(iss.number), ...repoArgs,
            '--json', 'number,title,body,createdAt'], { allowFail: true }));
          if (!latest || String(latest.body || '') !== String(iss.body || '')) {
            console.log(`#${iss.number}: body cambiato/non leggibile prima del sealing → lascio collecting, retry con lettura nuova.`);
            report.push(`- ⚠️ #${iss.number} sealing rinviato per baseline concorrente/illeggibile`);
            continue;
          }
          const bf = writeBodyFile(d.body);
          const newTitle = retitleDailyBucket(iss.title, d.valid.length);
          const editVerb = 'edit';
          const edited = gh(['issue', editVerb, String(iss.number), ...repoArgs, '--body-file', bf,
            ...(newTitle === null ? [] : ['--title', newTitle])], { allowFail: true });
          fs.rmSync(bf, { force: true });
          if (edited === null) {
            console.log(`⚠️ #${iss.number}: sealing non riuscito → resta collecting e non entra in coda.`);
            report.push(`- ⚠️ #${iss.number} sealing non riuscito, bucket collecting — target ${daily?.targetRepository || 'unknown'}`);
            continue;
          }
          gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
            `${MINT_GATE_MARKER}\n✅ Daily bucket sigillato in modo deterministico: tutti gli item hanno ID stabile e acceptance verificabile. Ora può essere accodato a \`agent:fix-queued\`.`], { allowFail: true });
          gh(['issue', editVerb, String(iss.number), ...repoArgs, '--add-label', 'agent:fix-queued'], { allowFail: true });
          report.push(`- 🔒 #${iss.number} daily bucket sealed, ${d.valid.length} item accodabili — ${daily?.targetRepository || 'unknown'}`);
          continue;
        }
        // Read immediately before a destructive body rewrite. If Claude (or a
        // concurrent retry) appended an item after the list snapshot, recompute from
        // that fresh body instead of overwriting it with a stale baseline.
        const latest = parseIssueJson(gh(['issue', 'view', String(iss.number), ...repoArgs,
          '--json', 'number,title,body,createdAt'], { allowFail: true }));
        if (!latest || String(latest.body || '') !== String(iss.body || '')) {
          if (!latest) {
            console.log(`⚠️ #${iss.number}: body baseline non leggibile prima della riscrittura → lascio collecting/intatta.`);
            report.push(`- ⚠️ #${iss.number} body baseline illeggibile, nessuna riscrittura`);
            continue;
          }
          iss = { ...iss, ...latest };
          const latestDaily = dailyBucketInfo(iss.title || '');
          const latestTriageComplete = batchTriageComplete
            || (latestDaily && recoveredDailyIdentities.has(dailyBucketIdentity(iss.title || '')));
          d = decideMintGate(iss, {
            machineOptions: { cache: machineCache },
            triageComplete: latestDaily ? latestTriageComplete : TRIAGE_COMPLETE,
          });
          commentTargets = daily ? sourcePrNumbers(iss.body, pr) : [pr];
          if (d.action === 'skip' || d.action === 'keep' || !d.body) {
            console.log(`#${iss.number}: body cambiato dopo la lista → decisione ricalcolata (${d.action}/${d.reason}), nessun overwrite stale.`);
            continue;
          }
          console.log(`#${iss.number}: body cambiato dopo la lista → decisione ricalcolata dalla lettura nuova (${d.action}/${d.reason}).`);
        }
        const list = d.demoted.map((it) => `- «${itemHeadline(it)}»`).join('\n');
        const duplicateList = (d.duplicates || [])
          .map((entry) => `- «${itemHeadline(entry.item?.text || entry.item?.raw || '')}» (${entry.fingerprint})`)
          .join('\n');
        // Il TESTO INTEGRALE, non il titolo. Nel ramo `demote` il corpo della issue viene
        // riscritto senza gli item demoti: se qui sopravvivesse solo la prima riga,
        // `Source`, `Stato dichiarato nella PR`, `Original text` e `Suggested action`
        // sarebbero cancellati e non riprodotti da nessuna parte — e la mitigazione su cui
        // poggia l'intera scelta di demozione («resta leggibile sulla PR») sarebbe falsa,
        // in modo irreversibile e ~11 volte al giorno. Nel ramo `suppress` il corpo resta
        // perché la issue è solo chiusa, ma il blocco integrale non fa danno neanche lì.
        const verbatim = demotedBlock(d.demoted);
        const why = d.action === 'dedupe'
          ? `${MINT_GATE_MARKER}\n🧹 **Gate deterministico sul conio** (zero-Claude): ${d.duplicates.length} item con fingerprint duplicato sono stati accorpati nel primo item; le rispettive \`Sources\` restano unite e non viene creato un secondo lavoro. Fingerprint: \`target repository + target file + token/azione normalizzata\`.\n\n${duplicateList}`
          : `${MINT_GATE_MARKER}\n🚧 **Gate deterministico sul conio** (zero-Claude): ${d.demoted.length} item non porta${d.demoted.length === 1 ? '' : 'no'} una condizione di accettazione falsificabile — né un token-codice distintivo in una riga \`Suggested action\`, né una scheda con un \`COMANDO\` che nomini un referente — quindi nessuna evidenza potrà mai provarl${d.demoted.length === 1 ? 'o' : 'i'} affrontat${d.demoted.length === 1 ? 'o' : 'i'}. Oracolo: \`hasFalsifiableAcceptance()\` in \`scripts/ci/followup-resolution-match.mjs\`, lo STESSO che chiude l'item.\n\n${list}`;
        if (DRY_RUN) { console.log(why); continue; }
        // ORDINE, non decorazione: prima si CONSERVA il testo sulla PR, poi si tocca la
        // issue. Il verso opposto — riscrivi il corpo, poi prova a commentare — perde gli
        // item per sempre se la seconda chiamata fallisce, ed e' proprio la finestra in
        // cui `gh` fallisce piu' spesso (rate limit dopo N scritture in un batch).
        const commentBody = `${MINT_GATE_MARKER}\n## Item demoti dal gate sul conio\n\nNon tracciati come item (nessuna condizione di accettazione falsificabile), ma **conservati qui integralmente**, come i \`Live-verification\`. ${d.action === 'suppress' ? `Issue #${iss.number} chiusa in ingresso: non restava nessun item valido.` : `Issue #${iss.number} resta aperta con ${d.valid.length} item valid${d.valid.length === 1 ? 'o' : 'i'}; questi sono stati tolti dal suo corpo e vivono solo qui.`}\n\n${verbatim}`;
        if (!commentTargets.length && d.action !== 'dedupe') {
          console.log(`⚠️ #${iss.number}: nessuna PR sorgente leggibile per conservare gli item demoti → issue lasciata intatta.`);
          report.push(`- ⚠️ #${iss.number} demozione/soppressione rinviata, PR sorgente assente`);
          continue;
        }
        // Legacy single-PR shape retained for source-contract checks:
        // ['pr', 'comment', String(pr), ...prRepoArgs
        const commentResults = d.action === 'dedupe'
          ? []
          : commentTargets.map((targetPr) => gh(['pr', 'comment', String(targetPr), ...prRepoArgs, '--body', commentBody], { allowFail: true }));
        const posted = d.action === 'dedupe' || commentResults.every((result) => result !== null) ? 'posted' : null;
        if (d.action === 'demote' && posted === null) {
          console.log(`⚠️ #${iss.number}: commento sulla PR #${pr} non riuscito → NON riscrivo il corpo. Gli item demoti restano dove sono; il prossimo giro riprova.`);
          report.push(`- ⏭️ #${iss.number} demozione rinviata (commento sulla PR non riuscito) — PR #${pr}`);
          continue;
        }
        if (d.action === 'suppress') {
          gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
            `${why}\n\nNessun item valido resta: questa issue non sarebbe mai potuta uscire dalla coda (\`aggregateCloseGate()\` la blocca per costruzione). Chiusa in ingresso; il testo resta qui e nel commento di summary della PR #${pr}. Se un item era lavoro vero, riaprilo come issue autonoma con una riga \`Suggested action\` che citi il simbolo **nella sua forma di codice**: un identificatore nudo (\`nomeFunzione\`) e un path nudo (\`scripts/ci/foo.mjs\`) non contano, perché compaiono nel file citato a prescindere dal fix — servono \`nomeFunzione()\`, \`oggetto.campo\`, \`COSTANTE >= 1\` o simili (\`isDistinctiveToken()\`, classe #1647). In alternativa, e spesso piu' facile, dagli una scheda: una riga \`- METRICA: prima=<n> atteso=<n> | COMANDO: <comando che nomina un file, uno script o un test>\`. Il referente non deve esistere ancora — lo crea la PR di fix — ma una metrica gia' al bersaglio (\`prima=N atteso=N\`) viene rifiutata: non c'e' niente da muovere.`],
            { allowFail: true });
          gh(['issue', 'close', String(iss.number), ...repoArgs, '--reason', 'not planned'], { allowFail: true });
          report.push(`- 🚫 #${iss.number} soppressa in ingresso (${d.demoted.length} item senza condizione di accettazione) — PR #${pr}`);
        } else {
          const bf = writeBodyFile(d.body);
          const newTitle = daily
            ? retitleDailyBucket(iss.title, d.valid.length)
            : retitle(iss.title, d.valid.length);
          if (newTitle === null) {
            console.log(`ℹ️ #${iss.number}: titolo senza conteggio nella forma attesa («${iss.title.slice(0, 70)}») → lo lascio com'è invece di riscriverlo a vuoto; resta disallineato dal corpo.`);
          }
          const edited = gh(['issue', 'edit', String(iss.number), ...repoArgs, '--body-file', bf,
            ...(newTitle === null ? [] : ['--title', newTitle])], { allowFail: true });
          fs.rmSync(bf, { force: true });
          if (edited === null) {
            // Il testo è già al sicuro sulla PR (si conserva prima di riscrivere), quindi
            // qui non si perde niente: la issue resta com'era e la prossima passata
            // ritenterà, al costo di un secondo commento identico. Duplicare un commento è
            // il verso giusto in cui sbagliare; perdere gli item no.
            console.log(`⚠️ #${iss.number}: riscrittura del corpo non riuscita → issue invariata, il testo resta sulla PR #${pr}. La prossima passata ritenta (e ricommenta).`);
            report.push(`- ⚠️ #${iss.number} riscrittura non riuscita, issue invariata — PR #${pr}`);
            continue;
          }
          gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
            `${why}\n\nRimoss${d.demoted.length === 1 ? 'o' : 'i'} dal corpo; ${d.valid.length} item valid${d.valid.length === 1 ? 'o' : 'i'} rest${d.valid.length === 1 ? 'a' : 'ano'}.`],
            { allowFail: true });
          if (daily && bucketState(d.body) === 'sealed' && selectFirstOpenItem(d.body)) {
            gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
              `${MINT_GATE_MARKER}\n✅ Dopo la demozione il daily bucket è stato sigillato: gli item validi possono entrare in \`agent:fix-queued\`.`], { allowFail: true });
            gh(['issue', 'edit', String(iss.number), ...repoArgs, '--add-label', 'agent:fix-queued'], { allowFail: true });
          }
          report.push(d.action === 'dedupe'
            ? `- 🧹 #${iss.number} ${d.duplicates.length} item duplicati accorpati, ${d.valid.length} restano — daily ${daily?.dailyKey || 'unknown'}`
            : `- ✂️ #${iss.number} ${d.demoted.length} item demoti, ${d.valid.length} restano — PR #${pr}`);
        }
      }
    } catch (e) {
      // Proceed-safe: un guasto su una PR non deve toccare le altre né far cadere il triage.
      console.log(`PR #${pr}: gate saltato (${e?.message?.split('\n')[0]}) — issue lasciata intatta.`);
    }
  }
  // Il drop deve lasciare traccia CONTABILE. Un item scartato a torto che sopravvive solo
  // in prosa dentro un commento non lo conta nessuno, e senza quel numero non si potrà mai
  // mostrare che il filtro non è troppo aggressivo: «atteso zero» diventerebbe una misura
  // su un lato solo. Riga a formato fisso, grep-abile sui log di tutte le run (stessa
  // convenzione di `CLAUDE_USAGE` in claude-usage-summary.mjs).
  for (const t of tally) {
    console.log(`MINT_GATE_TALLY repo=${process.env.GH_REPO || 'default'} pr=${t.pr} issue=${t.issue} action=${t.action} reason=${t.reason} demoted=${t.demoted} kept=${t.kept}`);
  }
  const demotedTotal = tally.reduce((a, t) => a + t.demoted, 0);
  const summary = `Gate sul conio: ${report.length} issue nel report, ${demotedTotal} item demoti${DRY_RUN ? ' (dry-run)' : ''}.`;
  console.log(summary);
  // Un dry-run non scrive da NESSUNA parte, nemmeno nel job summary: `GITHUB_STEP_SUMMARY`
  // si eredita dall'ambiente, quindi qualunque invocazione dry-run dentro un job (il test
  // di lotto ne fa una) appenderebbe la sua riga al summary reale di quel job — rumore
  // permanente in CI, e in un posto dove si va a leggere cosa ha fatto il gate davvero.
  if (process.env.GITHUB_STEP_SUMMARY && !DRY_RUN) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${report.join('\n')}\n`);
    } catch (e) {
      console.log(`gate-minted-followups: job summary non scrivibile (${e?.message?.split('\n')[0]}) — scritture già applicate, procedo.`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
