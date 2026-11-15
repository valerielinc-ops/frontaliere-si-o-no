// scripts/lib/saved-jobs-digest-claim.mjs
//
// Claim durevole del saved-jobs digest prima del provider, in micro-batch
// (perf-plan email senders, D2). Il claim e' il documento
// `users/{uid}/campaign_deliveries/{deliveryDocId}` con stato `sending`: finche'
// esiste, nessuna run puo' inviare di nuovo la stessa tupla uid/email/campagna.
//
// COME. Le richieste che arrivano insieme (la concorrenza della cascade e' 4) si
// raccolgono in un solo `WriteBatch.create`: `create` fallisce con ALREADY_EXISTS se
// il documento c'e' gia', quindi il batch e' il «crea solo se assente» della
// transazione di prima, senza lettura e con un round-trip per gruppo.
//
//   - commit riuscito          → tutti reclamati (il claim e' durevole PRIMA del provider);
//   - ALREADY_EXISTS su un solo claim → «gia' reclamato»: si salta;
//   - qualunque altro esito (gruppo con piu' claim, errore, esito incerto) → ogni
//     richiesta del gruppo ripiega sulla TRANSAZIONE di oggi, che decide per email.
//     Un `create` riuscito ma visto come errore e' gia' un claim nostro: la
//     transazione lo trova esistente e risponde «gia' reclamato», cioe' non si invia
//     (fail-closed: si puo' perdere un invio, mai raddoppiarlo).
//
// Un item che ripassa (un secondo provider della stessa cascade) non riscrive nulla:
// il claim e' per item, non per provider.

import { buildDeliveryDocId } from '../../functions/src/lib/deliveryDocId.js';
import { createMicroBatcher, isAlreadyExists } from './micro-batcher.mjs';

export function createSavedJobsDigestClaimer({
  getDb,
  campaignId,
  claimTransaction,
  metrics = { count() {} },
  warn = () => {},
  now = () => new Date(),
  maxItems,
  windowMs,
} = {}) {
  const claimedKeys = new Set();
  const keyOf = ({ uid, email }) => `${uid}\u0000${String(email || '').toLowerCase().trim()}`;

  const batcher = createMicroBatcher(async (requests) => {
    const db = await getDb();
    try {
      const batch = db.batch();
      for (const request of requests) batch.create(request.ref(db), request.data);
      await batch.commit();
      metrics.count('claimBatches');
      metrics.count('claimBatchWrites', requests.length);
      return requests.map(() => ({ claimed: true }));
    } catch (error) {
      if (requests.length === 1 && isAlreadyExists(error)) {
        metrics.count('claimAlreadyExists');
        return [{ claimed: false }];
      }
      metrics.count(isAlreadyExists(error) ? 'claimBatchAlreadyExists' : 'claimBatchError');
      warn(`   ⚠️  saved-jobs-digest claim batch not committed (${isAlreadyExists(error) ? 'already exists' : 'error'}): ${requests.length} claim(s) fall back to per-email transactions`);
      return requests.map(() => ({ fallback: true }));
    }
  }, { maxItems, windowMs });

  /** `true` = il provider puo' essere chiamato; `false` = gia' reclamato, si salta. */
  async function claim({ uid, email }) {
    if (!uid || !email || !campaignId) return false;
    const key = keyOf({ uid, email });
    if (claimedKeys.has(key)) return true;
    const normalizedEmail = String(email).toLowerCase().trim();
    const request = {
      ref: (db) => db.collection('users').doc(uid)
        .collection('campaign_deliveries').doc(buildDeliveryDocId(campaignId, email)),
      data: {
        email: normalizedEmail,
        campaign_id: campaignId,
        status: 'sending',
        claimed_at: now(),
      },
    };
    let outcome;
    try {
      outcome = await batcher.submit(request);
    } catch (error) {
      // Il gruppo e' stato rifiutato prima del commit (per esempio getDb che lancia):
      // senza un claim provato non si invia, ma la transazione puo' ancora riuscire.
      metrics.count('claimBatchError');
      warn(`   ⚠️  saved-jobs-digest claim batch rejected before commit: ${String(error?.message || error).slice(0, 160)}`);
      outcome = { fallback: true };
    }
    let claimed;
    if (outcome?.claimed === true) claimed = true;
    else if (outcome?.claimed === false) claimed = false;
    else {
      metrics.count('claimTxFallback');
      claimed = await claimTransaction({ uid, email, campaignId });
    }
    if (claimed) claimedKeys.add(key);
    return claimed;
  }

  return {
    claim,
    /** Il claim di questa run per `{uid, email}`: serve a rilasciare solo i propri. */
    owns: (target) => claimedKeys.has(keyOf(target)),
    flush: () => batcher.flushNow(),
  };
}
