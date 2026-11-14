// scripts/lib/job-alert-delivery-ledger.mjs
//
// La logica PURA del registro di consegna di un job alert: cosa si scrive sul
// documento dell'alert prima di chiamare il provider (intent) e dopo l'esito
// (finalize). Nessun I/O: riceve i dati correnti del documento e restituisce i
// campi da scrivere, oppure rifiuta.
//
// Perche' e' un modulo a se'. Fino al perf-plan PR 4b la stessa logica stava dentro
// due transazioni per email (`persistJobAlertProviderAttempt`,
// `finalizeJobAlertDeliveryAttempt` di send-job-alerts.mjs). Ora la stessa
// decisione serve a DUE esecutori:
//   - la transazione per email (fallback, e unico percorso fuori dal batch);
//   - lo WriteBatch con precondizione `lastUpdateTime` (percorso veloce).
// Se i due calcolassero i campi in modo indipendente, l'idempotenza dipenderebbe
// dal fatto che non divergano mai. Cosi' i campi scritti sono per costruzione gli
// stessi: cambia solo il modo in cui si garantisce che il documento non si sia
// mosso fra la lettura e la scrittura.
//
// INVARIANTE (non negoziabile): per ogni email, l'intent «provider-attempt-intent»
// e' durevole PRIMA della chiamata al provider. Un crash fra provider e finalize
// lascia uno stato ambiguo che blocca il retry (deliveryEntryBlocksRetry). Nessun
// doppio invio.

import {
  DEDUP_WINDOW_MS,
  DELIVERY_STATES,
  deliveryEntryBlocksRetry,
  mergeDeliveryLedger,
  mergeSentJobs,
  normalizeDeliveryLedger,
  normalizeSentMap,
  removeDeliveryLedgerJobs,
} from './alert-sent-jobs.mjs';

export const DELIVERY_OUTCOMES = Object.freeze(['accepted', 'ambiguous', 'failed']);

/**
 * L'intent e' ammesso? Stessa decisione della vecchia transazione di
 * `persistJobAlertProviderAttempt`: per ogni annuncio, se e' gia' nostro (stesso
 * claimId, ambiguo) si prosegue; se un altro tentativo lo blocca, o se e' stato
 * inviato nella finestra di dedup, si rifiuta.
 *
 * @param {object} current dati del documento dell'alert
 * @param {{jobs: object[], keys: string[], claimId: string, provider: string, now: number}} input
 * @returns {{allowed: false} | {allowed: true, fields: object}}
 */
export function computeProviderIntent(current, { jobs, keys, claimId, provider, now }) {
  const data = current || {};
  const ledger = normalizeDeliveryLedger(data.deliveryLedger);
  const sentMap = normalizeSentMap(data.sentJobIds);
  for (const key of keys) {
    const previous = ledger[key];
    if (previous?.state === DELIVERY_STATES.AMBIGUOUS && previous.claimId === claimId) continue;
    if (deliveryEntryBlocksRetry(previous, now)) return { allowed: false };
    const sentAt = sentMap[key];
    if (Number.isFinite(sentAt) && now - sentAt < DEDUP_WINDOW_MS) return { allowed: false };
  }
  return {
    allowed: true,
    fields: {
      deliveryLedger: mergeDeliveryLedger(
        ledger,
        jobs,
        now,
        DELIVERY_STATES.AMBIGUOUS,
        { claimId, provider, reason: 'provider-attempt-intent' },
      ),
      deliveryLastOutcome: DELIVERY_STATES.AMBIGUOUS,
      deliveryLastOutcomeAt: now,
      deliveryLastOutcomeReason: 'provider-attempt-intent',
    },
  };
}

/**
 * Campi del finalize di un tentativo: `accepted` avanza sentJobIds e toglie il
 * marcatore, `failed` lo toglie per un retry sicuro, `ambiguous` lo mantiene
 * bloccante. Rifiuta (lancia) negli stessi casi della vecchia transazione.
 *
 * `acceptedExtraFields` (perf-plan PR 4a) viene fuso nell'unico update di un invio
 * accettato: `lastMatchedAt`, `matchCount`, `cadence_scheduled_for`, i campi di
 * ranking e l'eventuale decay, cosi' l'alert si scrive una volta sola.
 *
 * @param {object} current dati del documento dell'alert
 * @param {{jobs: object[], keys: string[], claimId: string, outcome: string,
 *   provider?: object, now: number, acceptedExtraFields?: object|null}} input
 * @returns {object} i campi da scrivere
 */
export function computeDeliveryFinalize(current, {
  jobs, keys, claimId, outcome, provider = {}, now, acceptedExtraFields = null,
}) {
  const state = String(outcome || '').trim().toLowerCase();
  if (!DELIVERY_OUTCOMES.includes(state)) {
    throw new Error(`Unsupported job-alert delivery outcome: ${outcome}`);
  }
  const data = current || {};
  const ledger = normalizeDeliveryLedger(data.deliveryLedger);
  const entries = keys.map((key) => ledger[key]);
  const ownsAllEntries = entries.every((entry) => entry?.state === DELIVERY_STATES.AMBIGUOUS
    && entry.claimId === claimId);

  if (state === 'failed' && entries.every((entry) => !deliveryEntryBlocksRetry(entry, now))) {
    const sentMap = normalizeSentMap(data.sentJobIds);
    if (keys.some((key) => Number.isFinite(sentMap[key]) && now - sentMap[key] < DEDUP_WINDOW_MS)) {
      throw new Error('A concurrent job-alert delivery already recorded one of these jobs as sent.');
    }
    // Nessun provider aveva uno slot di quota: nessun marcatore pre-provider (o ne
    // resta uno scaduto / di un fallimento certo). Il cascade lo classifica come
    // fallimento certo; accodare e' sicuro dopo aver provato che nessun esito
    // concorrente esiste.
    return {
      deliveryLedger: removeDeliveryLedgerJobs(ledger, jobs),
      deliveryLastOutcome: 'failed',
      deliveryLastOutcomeAt: now,
      deliveryLastOutcomeReason: 'provider-rejected',
    };
  }
  if (!ownsAllEntries) {
    throw new Error('Job-alert delivery attempt no longer owns every rendered job.');
  }

  if (state === 'ambiguous') {
    return {
      deliveryLedger: mergeDeliveryLedger(ledger, jobs, now, DELIVERY_STATES.AMBIGUOUS, {
        claimId,
        provider: provider.provider,
        messageId: provider.ack === 'identified' ? provider.messageId : null,
        reason: 'provider-outcome-ambiguous',
      }),
      deliveryLastOutcome: DELIVERY_STATES.AMBIGUOUS,
      deliveryLastOutcomeAt: now,
      deliveryLastOutcomeReason: 'provider-outcome-ambiguous',
    };
  }

  const fields = {
    deliveryLedger: removeDeliveryLedgerJobs(ledger, jobs),
    deliveryLastOutcome: state,
    deliveryLastOutcomeAt: now,
    deliveryLastOutcomeReason: state === 'accepted' ? 'provider-acknowledged' : 'provider-rejected',
  };
  if (state === 'accepted') {
    fields.sentJobIds = mergeSentJobs(normalizeSentMap(data.sentJobIds), jobs, now, DEDUP_WINDOW_MS);
    if (acceptedExtraFields) Object.assign(fields, acceptedExtraFields);
  }
  return fields;
}
