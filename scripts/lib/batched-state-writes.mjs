// scripts/lib/batched-state-writes.mjs
//
// Stato di invio scritto a OGNI invio confermato, a micro-batch (perf-plan email
// senders, E2 onboarding-drip e F1 winback).
//
// IL PROBLEMA. Il drip e il winback inviavano a tutti e poi salvavano lo stato in
// sequenza (il drip: 64 s DOPO tutti gli invii; il winback: il timestamp di stadio
// solo a fine stadio). Un crash a meta' lasciava lo stato di tutti gli invii gia'
// fatti non scritto, e il rilancio rimandava la stessa email a ognuno.
//
// LA SOLUZIONE. Lo stato del singolo invio si scrive dentro `onSent`, subito dopo
// l'accettazione del provider, raccogliendo le scritture che arrivano insieme (la
// concorrenza della cascade e' 4) in un solo `WriteBatch.commit()` entro pochi
// millisecondi. Le scritture restano le stesse per email: cambiano solo il momento e il
// raggruppamento.
//
// RIPIEGO. Se il batch fallisce (o non puo' formarsi) ogni richiesta ripiega sulla
// scrittura singola di sempre, nello stesso ordine. Le scritture sono set idempotenti
// (merge o id di documento fisso): un batch che e' riuscito ma e' stato visto come
// errore, rieseguito singolarmente, non crea duplicati.
//
// La promessa risolta significa «lo stato e' durevole»: `onSent` la attende prima di
// lasciare il worker libero. Se anche il ripiego fallisce l'errore risale e la
// cascade lo registra (`persistFailed`) senza trasformare l'invio in un fallimento.

import { createMicroBatcher } from './micro-batcher.mjs';

/**
 * @typedef {{ ref: any, data: object, options?: object }} StateWrite
 */

export function createBatchedStateWriter({
  getDb,
  metrics = { count() {} },
  warn = () => {},
  maxItems,
  windowMs,
  setTimer,
  clearTimer,
} = {}) {
  const batcher = createMicroBatcher(async (requests) => {
    try {
      const db = await getDb();
      const batch = db.batch();
      for (const request of requests) {
        for (const write of request.writes) batch.set(write.ref, write.data, write.options || {});
      }
      await batch.commit();
      metrics.count('stateBatches');
      metrics.count('stateBatchWrites', requests.reduce((sum, request) => sum + request.writes.length, 0));
      return requests.map(() => ({ committed: true }));
    } catch (error) {
      metrics.count('stateBatchError');
      warn(`   ⚠️  state batch not committed (${String(error?.message || error).slice(0, 120)}): ${requests.length} send(s) fall back to single writes`);
      return requests.map(() => ({ committed: false }));
    }
  }, { maxItems, windowMs, setTimer, clearTimer });

  /**
   * @param {StateWrite[]} writes le scritture di UN invio, tutte o nessuna nel batch
   * @returns {Promise<{ mode: 'batch'|'single' }>}
   */
  async function write(writes) {
    if (!Array.isArray(writes) || writes.length === 0) return { mode: 'batch' };
    let outcome;
    try {
      outcome = await batcher.submit({ writes });
    } catch {
      outcome = { committed: false };
    }
    if (outcome.committed) return { mode: 'batch' };
    metrics.count('stateSingleFallback');
    for (const item of writes) await item.ref.set(item.data, item.options || {});
    return { mode: 'single' };
  }

  return { write, flush: () => batcher.flushNow() };
}
