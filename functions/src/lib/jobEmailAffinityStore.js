/**
 * jobEmailAffinityStore.js — cancellazione immediata del profilo di affinita'
 * (`job_email_affinity/{pseudonimo}`, forma in ./jobEmailAffinity.js).
 *
 * La privacy policy promette che il profilo sparisce SUBITO quando la persona
 * si cancella da tutte le comunicazioni o elimina l'account. I percorsi che lo
 * fanno chiamano tutti questa funzione:
 *  - newsletterSubscriptionManagement.js: `unsubscribe`, `unsubscribe_all` e
 *    `toggle_newsletter_subscription` spento (status `unsubscribed`, che per
 *    emailSuppression.js ferma ogni canale);
 *  - jobAlertUnsubscribe.js `unsubscribe_all`, solo se anche la newsletter non
 *    e' piu' spedibile (altrimenti e' una disiscrizione parziale e il profilo
 *    serve ancora a ordinare gli annunci della newsletter);
 *  - i cinque webhook dei provider su `complaint` e `unsubscribed`;
 *  - authAccountCleanup.js alla cancellazione dell'account;
 *  - lo strumento di cancellazione manuale dell'operatore in scripts/lib
 *    (non importa questo modulo: legge e cancella da se', fail-closed).
 *
 * IL SEGRETO. L'id e' un HMAC dell'email con NEWSLETTER_SECRET. Nelle Cloud
 * Functions il segreto NON e' in process.env (remoteConfigSecrets.js non lo
 * porta nell'ambiente): chi lo ha gia' lo passa, altrimenti qui lo si legge da
 * Remote Config. Senza segreto non si calcola nessun id (vedi affinityDocId) e
 * la funzione lo dice nel risultato invece di cancellare il documento sbagliato.
 *
 * Mai un throw: una disiscrizione non deve fallire perche' il profilo non si
 * cancella. Il log non contiene email ne' pseudonimi.
 */

import { JOB_EMAIL_AFFINITY_COLLECTION, affinityDocId, isStoppedFromAllEmail } from './jobEmailAffinity.js';

const REMOTE_CONFIG_TIMEOUT_MS = 5000;

async function remoteConfigNewsletterSecret() {
  let timer = null;
  try {
    const { getRemoteConfigValue } = await import('../remoteConfigSecrets.js');
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(''), REMOTE_CONFIG_TIMEOUT_MS);
    });
    return String(await Promise.race([getRemoteConfigValue('NEWSLETTER_SECRET'), timeout]) || '');
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Risolve NEWSLETTER_SECRET: argomento, ambiente, poi Remote Config. */
export async function resolveAffinitySecret(secret) {
  if (secret) return String(secret);
  if (process.env.NEWSLETTER_SECRET) return process.env.NEWSLETTER_SECRET;
  return remoteConfigNewsletterSecret();
}

/**
 * Cancella il profilo di affinita' di un indirizzo, se esiste.
 * @returns {Promise<{deleted: boolean, reason?: string}>}
 */
export async function eraseJobEmailAffinityProfile(db, email, { secret } = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!db || !normalized.includes('@')) return { deleted: false, reason: 'missing_input' };
  try {
    const resolved = await resolveAffinitySecret(secret);
    const docId = affinityDocId(normalized, resolved);
    if (!docId) {
      console.warn('⚠️ job_email_affinity: NEWSLETTER_SECRET assente, profilo non cancellato');
      return { deleted: false, reason: 'missing_secret' };
    }
    await db.collection(JOB_EMAIL_AFFINITY_COLLECTION).doc(docId).delete();
    return { deleted: true };
  } catch (error) {
    console.warn('⚠️ job_email_affinity: cancellazione del profilo fallita:', error?.message || error);
    return { deleted: false, reason: 'delete_failed' };
  }
}

/**
 * Dopo lo spegnimento di TUTTI i job alert: e' una disiscrizione parziale
 * finche' la newsletter scrive ancora a questo indirizzo (il profilo serve a
 * ordinarne gli annunci), totale quando il documento newsletter non consente
 * piu' nessun invio. Solo lettura del documento newsletter, mai scrittura.
 */
export async function eraseJobEmailAffinityProfileIfNoEmailLeft(db, email, { secret } = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  try {
    const snapshot = await db.collection('newsletter_subscribers').doc(normalized).get();
    const newsletter = snapshot.exists ? (snapshot.data() || {}) : null;
    if (!isStoppedFromAllEmail({ newsletter, jobAlert: null })) return { deleted: false, reason: 'partial_opt_out' };
  } catch (error) {
    console.warn('⚠️ job_email_affinity: verifica della disiscrizione totale fallita:', error?.message || error);
    return { deleted: false, reason: 'read_failed' };
  }
  return eraseJobEmailAffinityProfile(db, normalized, { secret });
}

/** Eventi dei provider che equivalgono a una disiscrizione da tutto. */
export function isAffinityErasingEvent(type) {
  return type === 'complaint' || type === 'unsubscribed';
}
