/**
 * Marking a candidate `rejected` with an ESTABLISHED cause.
 *
 * The pipeline itself rejects on what it can measure (`prospect-synthesize`:
 * la sintesi e' fallita; `prospect-validate`: il voto e' `bad`, oppure la spec
 * duplica un crawler esistente). It has no verdict for the class of failure
 * that only a human — or an investigation run — can name: la spec estrae
 * benissimo, ma quello che estrae non e' il datore che dice di essere, oppure
 * e' un aggregatore, oppure sono pagine di navigazione, oppure sono annunci
 * esteri. Quelle spec restano `promoted` per sempre, e `promoted` non e' in
 * `DONE_STATUSES` (`scripts/prospect-validate.mjs`): ogni notte rientrano nei
 * 40 slot di validazione e li tolgono a chi puo' ancora avanzare.
 *
 * Questo modulo e' la porta d'ingresso per quel verdetto: uno stato terminale
 * `rejected` **con la causa scritta nel record**, applicato via `setStatus`
 * (forward-only, con voce a registro) e mai a mano sul JSON.
 */
import { setStatus } from './candidate-store.mjs';

/**
 * Candidati che NON si respingono da qui: hanno gia' un crawler in produzione
 * o una PR di promozione aperta, quindi il verdetto giusto non e' una riga di
 * JSON ma il ritiro del crawler (`retire`) o la chiusura della PR. `rejected`
 * e' terminale e `setStatus` lo accetta da qualunque stato: senza questa
 * guardia un refuso di chiave spegnerebbe in silenzio un crawler vivo.
 */
export const SHIPPED_STATUSES = new Set(['production', 'promoting']);

/**
 * Trova il candidato indicato da `ref`, che puo' essere la chiave del
 * candidato (`recruitingapp-2783@umantis.com`) o quella del crawler
 * (`recruitingapp-2783`). Le due divergono spesso — la chiave del candidato e'
 * il dominio registrabile, quella del crawler e' il nome della spec — e chi
 * indaga parte sempre dal report di validazione, che e' keyed sul crawler.
 *
 * @param {{ candidates: Record<string, any> }} store
 * @param {string} ref
 * @returns {any|null}
 */
export function resolveCandidateRef(store, ref) {
  const wanted = String(ref || '').trim();
  if (!wanted) return null;
  const direct = store.candidates?.[wanted];
  if (direct) return direct;
  const byCrawler = Object.values(store.candidates || {}).filter((c) => c.crawlerKey === wanted);
  return byCrawler.length === 1 ? byCrawler[0] : null;
}

/**
 * @typedef {Object} RejectionEntry
 * @property {string} ref chiave del candidato o del crawler
 * @property {string} reason causa accertata, scritta nel record
 */

/**
 * Applica le rejection allo store in memoria. Non salva: il chiamante decide
 * (una `--dry-run` deve poter stampare esattamente cio' che farebbe).
 *
 * @param {{ candidates: Record<string, any> }} store
 * @param {RejectionEntry[]} entries
 * @param {{ ledgerFile?: string }} [opts]
 * @returns {{ applied: any[], skipped: any[] }}
 */
export function rejectCandidates(store, entries, opts = {}) {
  const applied = [];
  const skipped = [];
  for (const entry of entries) {
    const ref = String(entry?.ref || '').trim();
    const reason = String(entry?.reason || '').trim();
    // La causa E' il deliverable: un `rejected` senza motivo scritto non e'
    // verificabile a posteriori e riapre la stessa indagine fra un mese.
    if (!reason) { skipped.push({ ref, why: 'causa mancante' }); continue; }
    const candidate = resolveCandidateRef(store, ref);
    if (!candidate) { skipped.push({ ref, why: 'candidato non trovato' }); continue; }
    if (SHIPPED_STATUSES.has(candidate.status)) {
      skipped.push({ ref, key: candidate.key, why: `stato ${candidate.status}: gia' spedito, si ritira il crawler` });
      continue;
    }
    if (candidate.status === 'rejected') {
      skipped.push({ ref, key: candidate.key, why: 'gia\' rejected' });
      continue;
    }
    const from = candidate.status;
    setStatus(store, candidate.key, 'rejected', {
      reason,
      qualityVerdict: 'rejected',
      rejectedAt: new Date().toISOString(),
    }, opts.ledgerFile);
    applied.push({ ref, key: candidate.key, from, reason });
  }
  return { applied, skipped };
}
