// scripts/lib/newsletter-resume-receipts.mjs
//
// Quali ricevute di consegna legge una RIPRESA della newsletter (perf-plan email
// senders, C6 / L6a).
//
// Prima, ogni ripresa leggeva con una collectionGroup TUTTE le ricevute della
// campagna (`campaign_deliveries where campaign_id == X`): ~11,4k letture per run,
// per ritrovare cio' che il log di ripresa (`campaign_sends`) gia' dice. Ora:
//
//   - gli indirizzi GIA' RAGGIUNTI vengono dal log di ripresa, scritto a ogni
//     conferma del provider e svuotato ogni 50 invii;
//   - le ricevute si leggono solo se NON TERMINALI (`in_flight`, `pending`,
//     `unknown`): sono quelle che servono al reaper degli intenti vecchi e alla
//     quarantena, cioe' le sole che il log non puo' conoscere.
//
// LA GARANZIA CONTRO IL DOPPIO INVIO NON STA QUI. Resta il claim per email prima del
// provider (`claimNewsletterDeliveryIntent` in scripts/send-newsletter.mjs): una
// transazione che rifiuta ogni destinatario con una ricevuta gia' tentata
// (`accepted`, `delivered`, `unknown`, ...) e lascia ripassare solo `retryable_failed`.
// Una ricevuta `accepted` assente dal log (un crash prima dello svuotamento dei
// 50) non produce quindi un secondo invio: il destinatario si ricostruisce, il claim
// lo rifiuta e la cascade lo salta senza chiamare il provider. Il costo e' lavoro di
// assemblaggio inutile su pochi indirizzi, non un'email in piu'.
//
// FALLBACK. La query ristretta vuole un indice composito COLLECTION_GROUP
// (`campaign_id` + `delivery_status`, in firestore.indexes.json). Finche' non e'
// costruito, Firestore risponde FAILED_PRECONDITION e si ripiega sulla scansione di
// prima. `NEWSLETTER_RESUME_RECEIPT_SCAN=full` e' il kill switch (RC).

import { isFailedPrecondition } from './micro-batcher.mjs';

/** Gli stati che un'ultima scansione deve ancora poter vedere. */
export const NON_TERMINAL_DELIVERY_STATUSES = Object.freeze(['in_flight', 'pending', 'unknown']);

/** `targeted` (default) | `full` (kill switch). */
export function resolveResumeReceiptScan(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'full' ? 'full' : 'targeted';
}

/**
 * @param {object} db
 * @param {string} campaignId
 * @param {{ mode?: 'targeted'|'full', warn?: (line: string) => void, metrics?: { count?: Function } }} [options]
 * @returns {Promise<{ docs: object[], strategy: 'targeted'|'full'|'fallback-full' }>}
 */
export async function loadResumeReceipts(db, campaignId, { mode = 'targeted', warn = console.warn, metrics = {} } = {}) {
  const base = db.collectionGroup('campaign_deliveries').where('campaign_id', '==', campaignId);
  if (mode === 'targeted') {
    try {
      const snapshot = await base.where('delivery_status', 'in', [...NON_TERMINAL_DELIVERY_STATUSES]).get();
      metrics.count?.('resumeReceiptScanTargeted');
      return { docs: snapshot.docs || [], strategy: 'targeted' };
    } catch (error) {
      if (!isFailedPrecondition(error)) throw error;
      // Indice composito ancora in costruzione: costa letture, mai uno stato sbagliato.
      warn(`⚠️ Targeted resume-receipt query refused (${String(error?.message || error).slice(0, 120)}) — falling back to the full campaign scan.`);
      const snapshot = await base.get();
      metrics.count?.('resumeReceiptScanFallbackFull');
      return { docs: snapshot.docs || [], strategy: 'fallback-full' };
    }
  }
  const snapshot = await base.get();
  metrics.count?.('resumeReceiptScanFull');
  return { docs: snapshot.docs || [], strategy: 'full' };
}
