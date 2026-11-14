// scripts/lib/job-alert-batch-bookkeeping.mjs
//
// Intent e finalize dell'invio in WriteBatch con precondizione, al posto di due
// transazioni per email (perf-plan PR 4b).
//
// IL COSTO CHE SI TOGLIE. Per ogni email il sender faceva una transazione di
// intent PRIMA del provider (lettura + scrittura) e una di finalize DOPO (lettura
// + scrittura), piu' una scrittura singola `campaign_deliveries`: ~6 round-trip
// Firestore sequenziali nel percorso critico, ~5,2k letture e ~5,2k scritture di
// transazione per run. Le LETTURE erano il vero spreco: lo stato dell'alert e'
// gia' in memoria dal caricamento.
//
// COME SI MANTIENE LA STESSA GARANZIA. Una transazione dice «scrivo solo se il
// documento e' ancora com'era quando l'ho letto». Qui lo stesso vincolo e'
// espresso con la precondizione `lastUpdateTime` di `WriteBatch.update`: la
// decisione si prende sullo snapshot caricato (la stessa funzione pura di prima,
// job-alert-delivery-ledger.mjs) e la scrittura riesce SOLO se il documento non e'
// cambiato dall'`updateTime` di quello snapshot. Dopo l'intent, il finalize usa
// l'`updateTime` restituito dal commit dell'intent, quindi prova che nessun altro
// ha toccato l'alert fra intent e finalize.
//
// INVARIANTI (non negoziabili, provate in tests/job-alert-batch-bookkeeping.test.ts):
//   1. l'intent e' durevole PRIMA della chiamata al provider: `request` si risolve
//      solo dopo il commit, e il cascade non chiama il provider finche' non torna
//      `true`;
//   2. un crash fra provider e finalize lascia l'intent `ambiguous`, che blocca
//      ogni retry (deliveryEntryBlocksRetry): nessun doppio invio, ne' nella stessa
//      run ne' in un rilancio dello stesso giorno;
//   3. se la precondizione fallisce (o qualunque errore rende incerto l'esito), si
//      ripiega SEMPRE sulla transazione per email di prima: mai un invio senza
//      intent. Il ripiego e' idempotente anche se il commit incerto era riuscito: il
//      claimId e' lo stesso, e la transazione riconosce un intent proprio. Vale
//      anche per il finalize `accepted`: se il batch e' stato scritto ma il client
//      ha visto un errore, la transazione trova il marcatore gia' tolto e
//      `sentJobIds` avanzato oltre l'intent (deliveryFinalizeAlreadyApplied) e non
//      riapplica i campi fusi (`increment`, decay);
//   4. anche un gruppo rifiutato PRIMA del commit (per esempio `getDb()` che lancia)
//      ripiega sulla transazione: se questa fallisce a sua volta, l'errore risale
//      alla cascade e il provider non viene chiamato. Il documento dell'alert la cui
//      precondizione non e' piu' vera (riattivazione scritta in questa run) non entra
//      nel batch: `__loadedUpdateTime` e' azzerato e il primo intent rilegge.
//
// IL GRUPPO E' PICCOLO DI PROPOSITO. Le richieste che arrivano insieme (la
// concorrenza del cascade e' 4) si raccolgono in un solo commit entro pochi
// millisecondi, ma l'intent resta «appena prima del provider»: non si scrivono in
// anticipo gli intent di 64 email. Cosi' una run cancellata a meta' lascia al piu'
// poche email con un intent senza invio, non decine (un intent ambiguo non scade).

import { jobDedupKey } from './alert-sent-jobs.mjs';
import { computeDeliveryFinalize, computeProviderIntent } from './job-alert-delivery-ledger.mjs';

export const GROUP_MAX_ITEMS = 8;
export const GROUP_WINDOW_MS = 8;

/** Errore di precondizione di Firestore (gRPC 9 FAILED_PRECONDITION). */
export function isFailedPrecondition(error) {
  const code = error?.code;
  return code === 9 || code === 'failed-precondition'
    || /FAILED_PRECONDITION|precondition/i.test(String(error?.message || ''));
}

/** Raccoglie le richieste in arrivo entro `windowMs` (o `maxItems`) in un solo flush. */
export function createMicroBatcher(flush, {
  maxItems = GROUP_MAX_ITEMS,
  windowMs = GROUP_WINDOW_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let pending = [];
  let timer = null;
  const run = () => {
    if (timer) { clearTimer(timer); timer = null; }
    const group = pending;
    pending = [];
    if (group.length === 0) return;
    Promise.resolve()
      .then(() => flush(group.map((entry) => entry.request)))
      .then((results) => group.forEach((entry, index) => entry.resolve(results[index])))
      .catch((error) => group.forEach((entry) => entry.reject(error)));
  };
  return {
    submit(request) {
      return new Promise((resolve, reject) => {
        pending.push({ request, resolve, reject });
        if (pending.length >= maxItems) run();
        else if (!timer) timer = setTimer(run, windowMs);
      });
    },
    flushNow: run,
    get size() { return pending.length; },
  };
}

/**
 * @typedef {object} AlertSnapshot
 * @property {{deliveryLedger?: unknown, sentJobIds?: unknown}} data stato dell'alert (ledger e sentJobIds) a `updateTime`
 * @property {unknown} updateTime Timestamp di Firestore dello snapshot, o null se ignoto
 * @property {boolean} [committedIntent] vero dopo un intent scritto dal batch
 */

/**
 * @param {object} deps
 * @param {() => Promise<any>} deps.getDb handle Firestore
 * @param {(item: object, provider: string) => Promise<boolean>} deps.persistIntentTx ripiego: la transazione per email
 * @param {(item: object, outcome: string, provider?: object) => Promise<boolean>} deps.finalizeTx ripiego: la transazione per email
 * @param {(item: object, provider?: object) => object|null} [deps.buildAcceptedFields] campi fusi nell'update `accepted`
 * @param {(item: object) => void} [deps.onAcceptedFieldsApplied] chiamata quando l'update fuso e' stato scritto, dal batch o dal ripiego per email
 * @param {() => number} [deps.now]
 * @param {{count: (name: string, n?: number) => void}} [deps.metrics]
 * @param {(line: string) => void} [deps.warn]
 * @param {number} [deps.maxItems]
 * @param {number} [deps.windowMs]
 */
export function createBatchBookkeeper({
  getDb,
  persistIntentTx,
  finalizeTx,
  buildAcceptedFields = (item, provider) => (typeof item?.meta?.buildAcceptedAlertFields === 'function'
    ? item.meta.buildAcceptedAlertFields(provider)
    : null),
  onAcceptedFieldsApplied = () => {},
  now = () => Date.now(),
  metrics = { count() {} },
  warn = () => {},
  maxItems = GROUP_MAX_ITEMS,
  windowMs = GROUP_WINDOW_MS,
  setTimer,
  clearTimer,
} = {}) {
  const timers = { setTimer, clearTimer };
  const snapshotOf = (item) => item?.meta?.alertSnapshot || null;
  const usable = (snapshot) => Boolean(snapshot && snapshot.updateTime && snapshot.data);

  // ── intent ──────────────────────────────────────────────────────────────
  const intents = createMicroBatcher(async (requests) => {
    // requests: [{item, provider, ctx, fields}]; un solo commit per il gruppo.
    const db = await getDb();
    // Un documento compare al piu' una volta per commit: due richieste sullo stesso
    // alert nello stesso gruppo non si fidano della semantica delle precondizioni
    // fra scritture dello stesso commit, e la seconda ripiega sulla transazione
    // (che legge lo stato fresco). In produzione non capita: un alert, un'email.
    const seen = new Set();
    const inBatch = [];
    const outcomes = requests.map(() => ({ committed: false }));
    requests.forEach((request, index) => {
      const path = request.ctx.ref?.path;
      if (path && seen.has(path)) return;
      if (path) seen.add(path);
      inBatch.push({ request, index });
    });
    try {
      const batch = db.batch();
      for (const { request: { ctx, fields, snapshot } } of inBatch) {
        batch.update(ctx.ref, fields, { lastUpdateTime: snapshot.updateTime });
      }
      const results = await batch.commit();
      metrics.count('bookkeepingIntentBatches');
      metrics.count('bookkeepingIntentBatchWrites', inBatch.length);
      inBatch.forEach(({ index }, position) => {
        outcomes[index] = { committed: true, writeTime: results?.[position]?.writeTime ?? null };
      });
      return outcomes;
    } catch (error) {
      // Precondizione fallita, o esito incerto: nessuno di questi puo' partire
      // senza un intent provato. Ognuno ripiega sulla transazione per email.
      metrics.count(isFailedPrecondition(error) ? 'bookkeepingIntentPreconditionFailed' : 'bookkeepingIntentBatchError');
      warn(`   ⚠️  job-alert intent batch not committed (${isFailedPrecondition(error) ? 'precondition' : 'error'}): ${requests.length} intent(s) fall back to per-email transactions`);
      return requests.map(() => ({ committed: false }));
    }
  }, { maxItems, windowMs, ...timers });

  /**
   * Intent durevole prima del provider. `true` = il provider puo' essere chiamato.
   * Sostituisce `persistJobAlertProviderAttempt` come `beforeProviderAttempt`.
   */
  async function requestIntent(item, provider) {
    if (item?.meta?.isOperatorVerification) return true;
    const snapshot = snapshotOf(item);
    // Un intent gia' scritto da questo tentativo per LO STESSO provider resta
    // valido (stesso claimId, nessuna scrittura in piu'). Se la cascade passa a un
    // secondo provider, l'intent si riscrive col provider reale, come faceva la
    // transazione per email: il registro dice sempre chi sta per essere chiamato.
    if (snapshot?.committedIntent && snapshot.intentProvider === provider) return true;
    if (!usable(snapshot)) {
      metrics.count('bookkeepingIntentTxFallback');
      return persistIntentTx(item, provider);
    }
    const ctx = ledgerContext(item);
    const intentAtMs = now();
    const decision = computeProviderIntent(snapshot.data, {
      jobs: ctx.jobs, keys: ctx.keys, claimId: ctx.claimId, provider, now: intentAtMs,
    });
    // Bloccato dallo stato che la precondizione garantisce ancora valido: non si
    // chiama il provider. (Stesso esito della transazione: `false`.)
    if (!decision.allowed) return false;

    // Se il gruppo viene rifiutato PRIMA del commit (per esempio `getDb()` che
    // lancia) la richiesta non resta senza intent: ripiega come per un commit
    // fallito. Se anche la transazione di ripiego lancia, l'errore risale alla
    // cascade, che non chiama il provider: senza intent provato non si invia.
    let outcome;
    try {
      outcome = await intents.submit({ item, provider, ctx, fields: decision.fields, snapshot });
    } catch (error) {
      metrics.count('bookkeepingIntentBatchError');
      warn(`   ⚠️  job-alert intent batch rejected before commit: ${String(error?.message || error).slice(0, 160)}`);
      outcome = { committed: false };
    }
    if (!outcome.committed) {
      metrics.count('bookkeepingIntentTxFallback');
      return persistIntentTx(item, provider);
    }
    // Lo stato locale e' esattamente quello di Firestore: lo snapshot piu' i campi
    // scritti. L'updateTime del commit e' la precondizione del finalize.
    item.meta.alertSnapshot = {
      data: { ...snapshot.data, ...decision.fields },
      updateTime: outcome.writeTime,
      committedIntent: true,
      intentProvider: provider,
    };
    // L'istante dell'intent: serve al ripiego del finalize per riconoscere un
    // finalize gia' applicato da un commit di esito incerto.
    item.meta.deliveryIntentAt = intentAtMs;
    return true;
  }

  // ── finalize ────────────────────────────────────────────────────────────
  const finalizes = createMicroBatcher(async (requests) => {
    const db = await getDb();
    // Prepara le scritture; un item il cui finalize non e' calcolabile sullo
    // snapshot (non possiede piu' i marcatori, esito concorrente) va in ripiego da solo.
    const prepared = [];
    const results = requests.map(() => ({ committed: false }));
    const seenDocs = new Set();
    requests.forEach((request, index) => {
      const path = request.ctx.ref?.path;
      if (path && seenDocs.has(path)) return; // ripiega da solo, come per l'intent
      if (path) seenDocs.add(path);
      try {
        const fields = computeDeliveryFinalize(request.snapshot.data, {
          jobs: request.ctx.jobs,
          keys: request.ctx.keys,
          claimId: request.ctx.claimId,
          outcome: request.outcome,
          provider: request.provider,
          now: now(),
          acceptedExtraFields: request.acceptedExtraFields,
        });
        prepared.push({ index, request, fields });
      } catch {
        results[index] = { committed: false };
      }
    });
    if (prepared.length === 0) return results;
    try {
      const batch = db.batch();
      for (const { request, fields } of prepared) {
        batch.update(request.ctx.ref, fields, { lastUpdateTime: request.snapshot.updateTime });
        for (const write of request.extraWrites) batch.set(write.ref, write.data, write.options || {});
      }
      await batch.commit();
      metrics.count('bookkeepingFinalizeBatches');
      metrics.count('bookkeepingFinalizeBatchWrites', prepared.length);
      for (const { index } of prepared) results[index] = { committed: true };
    } catch (error) {
      metrics.count(isFailedPrecondition(error) ? 'bookkeepingFinalizePreconditionFailed' : 'bookkeepingFinalizeBatchError');
      warn(`   ⚠️  job-alert finalize batch not committed (${isFailedPrecondition(error) ? 'precondition' : 'error'}): ${prepared.length} finalize(s) fall back to per-email transactions`);
    }
    return results;
  }, { maxItems, windowMs, ...timers });

  /**
   * Finalize di un tentativo (`accepted`, `failed`, `ambiguous`) e, per
   * `accepted`, le scritture accessorie (`campaign_deliveries`) nello stesso
   * commit. Sostituisce `finalizeJobAlertDeliveryAttempt`.
   *
   * @returns {Promise<boolean>} come la funzione sostituita
   */
  async function requestFinalize(item, outcome, provider = {}, { extraWrites = [] } = {}) {
    if (item?.meta?.isOperatorVerification) return false;
    const snapshot = snapshotOf(item);
    const acceptedExtraFields = outcome === 'accepted' ? buildAcceptedFields(item, provider) : null;
    const fallback = async () => {
      metrics.count('bookkeepingFinalizeTxFallback');
      try {
        const applied = await finalizeTx(item, outcome, provider, acceptedExtraFields);
        // Contratto esplicito: l'update fuso e' stato scritto anche dal ripiego per email, quindi
        // il passo post-batch NON deve riapplicarlo (`increment`, ranking, decay). Non dipende
        // dall'effetto collaterale di `finalizeTx`. Solo se il finalize e' riuscito: se lancia o
        // risponde `false` l'update fuso non c'e' e resta il passo standalone di sempre.
        if (applied === true && acceptedExtraFields) onAcceptedFieldsApplied(item);
        return applied;
      } finally {
        // Le scritture accessorie non sono mai bloccanti, e partono anche se il
        // finalize fallisce, come prima (il record di consegna era scritto prima
        // del finalize): un guasto qui non trasforma un invio accettato in un errore.
        for (const write of extraWrites) {
          try { await write.ref.set(write.data, write.options || {}); } catch (error) {
            warn(`⚠️ Job-alert delivery record not persisted: ${String(error?.message || error).slice(0, 160)}`);
          }
        }
      }
    };
    // Il batch si usa solo se l'intent e' stato scritto dal batch: solo allora
    // l'updateTime in mano e' quello dell'ultima scrittura di questa run.
    if (!usable(snapshot) || snapshot.committedIntent !== true) return fallback();
    const ctx = ledgerContext(item);
    // Un gruppo rifiutato prima del commit (o qualunque errore del gruppo) non
    // perde il finalize ne' il record di consegna: si ripiega sulla transazione.
    let outcomeOfBatch = null;
    try {
      outcomeOfBatch = await finalizes.submit({
        item, outcome, provider, ctx, snapshot, acceptedExtraFields, extraWrites,
      });
    } catch (error) {
      metrics.count('bookkeepingFinalizeBatchError');
      warn(`   ⚠️  job-alert finalize batch rejected before commit: ${String(error?.message || error).slice(0, 160)}`);
    }
    if (!outcomeOfBatch?.committed) return fallback();
    if (acceptedExtraFields) onAcceptedFieldsApplied(item);
    return true;
  }

  return { requestIntent, requestFinalize, flush: () => { intents.flushNow(); finalizes.flushNow(); } };
}

/** Riferimento, annunci e chiavi del tentativo: lo stesso contesto del sender. */
export function ledgerContext(item) {
  const jobs = Array.isArray(item?.meta?.rankingJobs) ? item.meta.rankingJobs : [];
  const claimId = String(item?.meta?.deliveryAttemptId || '').trim();
  const ref = item?.deliveryRef;
  const keys = jobs.map(jobDedupKey);
  if (!ref || !claimId || jobs.length === 0 || keys.some((key) => !key)) {
    throw new Error('Job-alert delivery is missing its alert reference, attempt id, or stable job identity.');
  }
  return { ref, jobs, keys, claimId };
}
