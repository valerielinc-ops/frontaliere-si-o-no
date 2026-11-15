// scripts/lib/newsletter-batch-bookkeeping.mjs
//
// Claim, ricevuta e documento dell'iscritto della newsletter in WriteBatch, al
// posto di tre transazioni per email (perf-plan email senders, punto 3). Stesso
// disegno di scripts/lib/job-alert-batch-bookkeeping.mjs (verificato in produzione
// con 3.781 batch e 3 ripieghi), applicato ai tre documenti che il sender tocca per
// ogni email:
//
//   1. INTENT  `newsletter_subscribers/{email}/campaign_deliveries/{id}` con stato
//              `in_flight`, PRIMA del provider (era: transazione di lettura + scrittura);
//   2. RICEVUTA lo stesso documento, `accepted`, dopo il provider (era: transazione);
//   3. ISCRITTO `newsletter_subscribers/{email}`: `send_count`, `last_sent_at` e il
//              punteggio di engagement derivato (era: transazione).
//
// IL COSTO CHE SI TOGLIE. Le tre transazioni leggevano ognuna il documento per
// decidere: ~3 letture e ~3 scritture seriali per email, ~11k email a settimana. Il
// limite del tempo e' il provider (~2,8 email/s), quindi il guadagno e' sulle LETTURE
// e sulla latenza dei worker, non sul tempo totale.
//
// COME SI MANTIENE LA STESSA GARANZIA.
//   - L'intent e' `WriteBatch.create`: fallisce con ALREADY_EXISTS se il documento c'e'
//     gia', cioe' e' il «crea solo se assente» che la transazione faceva con una
//     lettura. Il commit si risolve solo quando l'intent e' durevole; il cascade non
//     chiama il provider prima.
//   - La ricevuta e' `WriteBatch.update` con precondizione `lastUpdateTime` = il
//     `writeTime` restituito dal commit dell'intent: la decisione si prende sullo stato
//     che la precondizione garantisce ancora vero (i campi che la transazione leggeva
//     sono quelli scritti dall'intent). Se un altro scrittore (un webhook del provider)
//     ha toccato il documento nel frattempo, la precondizione fallisce.
//   - Il documento dell'iscritto e' `update` con precondizione sull'`updateTime` dello
//     snapshot della scansione iniziale: il punteggio e' calcolato su quello snapshot
//     (la stessa funzione pura di prima) ed e' vero solo se il documento non e'
//     cambiato. E' scrittura secondaria (non decide se una consegna e' accettata): se
//     fallisce si ripiega sulla transazione di sempre, che ha gia' un try/catch.
//
// INVARIANTI (non negoziabili, provate in tests/newsletter-batch-bookkeeping.test.ts):
//   1. l'intent e' durevole PRIMA della chiamata al provider;
//   2. un crash fra provider e finalize lascia l'intent `in_flight`, che blocca ogni
//      retry (il claim rifiuta una ricevuta gia' tentata, il reaper la mette in
//      quarantena): nessun doppio invio, ne' nella stessa run ne' in un rilancio;
//   3. una precondizione o un batch che falliscono ripiegano SEMPRE sulla transazione di
//      oggi, che decide per email. Mai un invio senza intent provato. Questo vale anche
//      per ALREADY_EXISTS, e anche per un gruppo con una sola richiesta: l'esistenza del
//      documento non vuol dire «gia' reclamato» (una ricevuta `retryable_failed` deve
//      poter ripassare), quindi la decisione resta alla transazione;
//   4. un `create` riuscito ma visto come errore e' gia' un intent nostro: la
//      transazione di ripiego lo trova col nostro `attemptId` in `in_flight` e lo
//      riusa (ramo «provider fallback» di claimNewsletterDeliveryIntent), senza
//      scrivere un secondo intent. E' lo stesso caso del job alert.
//   5. Se la cascade passa a un secondo provider per la stessa email, l'intent si
//      riscrive col provider reale con la transazione di oggi e lo snapshot del batch
//      viene scartato: il finalize di quell'email usa la transazione.
//
// Privacy: i contatori sono aggregati. Nessun indirizzo, nessun id di documento.

import { GROUP_MAX_ITEMS, GROUP_WINDOW_MS, createMicroBatcher, isAlreadyExists, isFailedPrecondition } from './micro-batcher.mjs';

export const BATCH_BOOKKEEPING_MODES = Object.freeze(['on', 'off']);

/** `NEWSLETTER_BATCH_BOOKKEEPING` (Remote Config): `on` (default) | `off` (kill switch). */
export function resolveBatchBookkeepingMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return BATCH_BOOKKEEPING_MODES.includes(value) ? value : 'on';
}

const hasUpdateTime = (snapshot) => Boolean(snapshot && snapshot.updateTime && snapshot.data);

/**
 * @param {object} deps
 * @param {() => Promise<any>} deps.getDb
 * @param {(db: any, item: object) => any} deps.deliveryRefFor riferimento della ricevuta dell'email
 * @param {(item: object, provider: string, attemptId: string, at: Date) => object} deps.buildIntentFields i campi dell'intent (gli stessi della transazione)
 * @param {(item: object, provider: string, attemptId: string) => Promise<boolean>} deps.claimTransaction ripiego: la transazione di claim di oggi
 * @param {(previous: object, recipient: object, messageId: string|null, meta: object, at: Date) => object} deps.buildReceiptFields i campi della ricevuta, dato lo stato precedente
 * @param {(recipient: object, messageId: string|null, meta: object) => Promise<void>} deps.receiptTransaction ripiego: la transazione della ricevuta di oggi
 * @param {(db: any, recipient: object) => any} deps.subscriberRefFor
 * @param {(recipient: object) => ({data: object, updateTime: unknown}|null)} deps.subscriberSnapshotOf snapshot della scansione iniziale (null = ignoto)
 * @param {(current: object, recipient: object, at: Date) => object|null} deps.buildSubscriberFields campi dell'iscritto, dato lo snapshot (null = non calcolabile)
 * @param {(recipient: object) => Promise<void>} deps.subscriberTransaction ripiego: la transazione dell'iscritto di oggi
 * @param {{count: (name: string, n?: number) => void}} [deps.metrics]
 * @param {(line: string) => void} [deps.warn]
 */
export function createNewsletterBookkeeper({
  getDb,
  deliveryRefFor,
  buildIntentFields,
  claimTransaction,
  buildReceiptFields,
  receiptTransaction,
  subscriberRefFor,
  subscriberSnapshotOf = () => null,
  buildSubscriberFields = () => null,
  subscriberTransaction,
  metrics = { count() {} },
  warn = () => {},
  now = () => new Date(),
  maxItems = GROUP_MAX_ITEMS,
  windowMs = GROUP_WINDOW_MS,
  setTimer,
  clearTimer,
} = {}) {
  const timers = { setTimer, clearTimer };

  // ── intent ──────────────────────────────────────────────────────────────
  const intents = createMicroBatcher(async (requests) => {
    const db = await getDb();
    const outcomes = requests.map(() => ({ committed: false }));
    // Un documento compare al piu' una volta per commit: un secondo `create` sullo
    // stesso percorso fallirebbe ALREADY_EXISTS e porterebbe giu' tutto il gruppo.
    // La richiesta duplicata ripiega da sola sulla transazione.
    const seen = new Set();
    const inBatch = [];
    requests.forEach((request, index) => {
      const path = request.ref.path;
      if (path && seen.has(path)) return;
      if (path) seen.add(path);
      inBatch.push({ request, index });
    });
    try {
      const batch = db.batch();
      for (const { request } of inBatch) batch.create(request.ref, request.data);
      const results = await batch.commit();
      metrics.count('bookkeepingIntentBatches');
      metrics.count('bookkeepingIntentBatchWrites', inBatch.length);
      inBatch.forEach(({ index }, position) => {
        outcomes[index] = { committed: true, writeTime: results?.[position]?.writeTime ?? null };
      });
      return outcomes;
    } catch (error) {
      // ALREADY_EXISTS (anche con un solo claim) e FAILED_PRECONDITION: il documento
      // c'e' gia'. Il batch e' atomico, quindi nessun claim del gruppo e' stato
      // scritto: ognuno ripiega sulla transazione, che decide per email.
      const definite = isAlreadyExists(error) || isFailedPrecondition(error);
      metrics.count(definite ? 'bookkeepingIntentPreconditionFailed' : 'bookkeepingIntentBatchError');
      warn(`   ⚠️  newsletter intent batch not committed (${definite ? 'already exists / precondition' : 'error'}): ${requests.length} intent(s) fall back to per-email transactions`);
      return requests.map(() => ({ committed: false }));
    }
  }, { maxItems, windowMs, ...timers });

  /**
   * Intent durevole prima del provider. `true` = il provider puo' essere chiamato;
   * `false` = gia' tentato, si salta. Sostituisce `claimNewsletterDeliveryIntent`
   * come `beforeProviderAttempt`.
   */
  async function requestIntent(item, provider, attemptId) {
    const meta = item?.meta;
    const held = meta?.newsletterIntent;
    if (held && held.attemptId === attemptId) {
      // Stesso provider: l'intent di questa run vale ancora (nessuna scrittura in piu').
      if (held.provider === provider) return true;
      // Un altro provider della stessa cascade: si riscrive col provider reale con la
      // transazione di sempre e lo snapshot del batch non e' piu' la verita'.
      meta.newsletterIntent = null;
      metrics.count('bookkeepingIntentTxFallback');
      return claimTransaction(item, provider, attemptId);
    }

    let outcome;
    try {
      const db = await getDb();
      const data = buildIntentFields(item, provider, attemptId, now());
      outcome = await intents.submit({ ref: deliveryRefFor(db, item), data });
      if (outcome.committed) {
        meta.newsletterIntent = { data, updateTime: outcome.writeTime, provider, attemptId };
        return true;
      }
    } catch (error) {
      // Gruppo rifiutato prima del commit (per esempio `getDb()` che lancia): la
      // richiesta non resta senza intent, ripiega. Se anche la transazione lancia,
      // l'errore risale alla cascade e il provider non viene chiamato.
      metrics.count('bookkeepingIntentBatchError');
      warn(`   ⚠️  newsletter intent batch rejected before commit: ${String(error?.message || error).slice(0, 160)}`);
    }
    metrics.count('bookkeepingIntentTxFallback');
    return claimTransaction(item, provider, attemptId);
  }

  // ── ricevuta ────────────────────────────────────────────────────────────
  const receipts = createMicroBatcher(async (requests) => {
    const db = await getDb();
    const results = requests.map(() => ({ committed: false }));
    const seen = new Set();
    const prepared = [];
    requests.forEach((request, index) => {
      const path = request.ref.path;
      if (path && seen.has(path)) return;
      if (path) seen.add(path);
      prepared.push({ request, index });
    });
    try {
      const batch = db.batch();
      for (const { request } of prepared) {
        batch.update(request.ref, request.fields, { lastUpdateTime: request.updateTime });
      }
      const written = await batch.commit();
      metrics.count('bookkeepingFinalizeBatches');
      metrics.count('bookkeepingFinalizeBatchWrites', prepared.length);
      prepared.forEach(({ index }, position) => {
        results[index] = { committed: true, writeTime: written?.[position]?.writeTime ?? null };
      });
    } catch (error) {
      metrics.count(isFailedPrecondition(error) ? 'bookkeepingFinalizePreconditionFailed' : 'bookkeepingFinalizeBatchError');
      warn(`   ⚠️  newsletter receipt batch not committed (${isFailedPrecondition(error) ? 'precondition' : 'error'}): ${prepared.length} receipt(s) fall back to per-email transactions`);
    }
    return results;
  }, { maxItems, windowMs, ...timers });

  /**
   * Ricevuta `accepted` dopo il provider. Il batch si usa solo se l'intent e' stato
   * scritto dal batch: solo allora l'`updateTime` in mano e' quello dell'ultima
   * scrittura di questa run. Altrimenti, e a ogni batch fallito, la transazione di oggi.
   * Un errore della transazione risale (e' la ricevuta, l'autorita' di dedup).
   */
  async function persistReceipt(item, recipient, messageId, meta) {
    const held = item?.meta?.newsletterIntent;
    if (held && hasUpdateTime(held)) {
      let outcome = null;
      try {
        const db = await getDb();
        const fields = buildReceiptFields(held.data, recipient, messageId, meta, now());
        outcome = await receipts.submit({ ref: deliveryRefFor(db, item), fields, updateTime: held.updateTime });
        if (outcome.committed) {
          // Lo stato locale e' quello di Firestore: l'intent piu' i campi scritti.
          item.meta.newsletterIntent = { ...held, data: { ...held.data, ...fields }, updateTime: outcome.writeTime, finalized: true };
          return;
        }
      } catch (error) {
        metrics.count('bookkeepingFinalizeBatchError');
        warn(`   ⚠️  newsletter receipt batch rejected before commit: ${String(error?.message || error).slice(0, 160)}`);
      }
    }
    metrics.count('bookkeepingFinalizeTxFallback');
    if (item?.meta) item.meta.newsletterIntent = null;
    await receiptTransaction(recipient, messageId, meta);
  }

  // ── documento dell'iscritto ─────────────────────────────────────────────
  const subscribers = createMicroBatcher(async (requests) => {
    const db = await getDb();
    const results = requests.map(() => ({ committed: false }));
    const seen = new Set();
    const prepared = [];
    requests.forEach((request, index) => {
      const path = request.ref.path;
      if (path && seen.has(path)) return;
      if (path) seen.add(path);
      prepared.push({ request, index });
    });
    try {
      const batch = db.batch();
      for (const { request } of prepared) {
        batch.update(request.ref, request.fields, { lastUpdateTime: request.updateTime });
      }
      await batch.commit();
      metrics.count('bookkeepingSubscriberBatches');
      metrics.count('bookkeepingSubscriberBatchWrites', prepared.length);
      for (const { index } of prepared) results[index] = { committed: true };
    } catch (error) {
      metrics.count(isFailedPrecondition(error) ? 'bookkeepingSubscriberPreconditionFailed' : 'bookkeepingSubscriberBatchError');
      warn(`   ⚠️  newsletter subscriber batch not committed (${isFailedPrecondition(error) ? 'precondition' : 'error'}): ${prepared.length} update(s) fall back to per-email transactions`);
    }
    return results;
  }, { maxItems, windowMs, ...timers });

  /**
   * Contatori e punteggio dell'iscritto. Scrittura secondaria: il chiamante la
   * racchiude in un try/catch come prima. Senza snapshot (o con una precondizione
   * fallita) si ripiega sulla transazione di oggi.
   */
  async function persistSubscriber(recipient) {
    const snapshot = subscriberSnapshotOf(recipient);
    if (hasUpdateTime(snapshot)) {
      try {
        const db = await getDb();
        const fields = buildSubscriberFields(snapshot.data, recipient, now());
        if (fields) {
          const outcome = await subscribers.submit({ ref: subscriberRefFor(db, recipient), fields, updateTime: snapshot.updateTime });
          if (outcome.committed) return;
        }
      } catch (error) {
        metrics.count('bookkeepingSubscriberBatchError');
        warn(`   ⚠️  newsletter subscriber batch rejected before commit: ${String(error?.message || error).slice(0, 160)}`);
      }
    }
    metrics.count('bookkeepingSubscriberTxFallback');
    await subscriberTransaction(recipient);
  }

  return {
    requestIntent,
    persistReceipt,
    persistSubscriber,
    flush: () => { intents.flushNow(); receipts.flushNow(); subscribers.flushNow(); },
  };
}
