/**
 * jobEmailAffinity.js — profilo di interessi per persona, ricavato dai clic
 * sugli annunci delle email (job alert e newsletter).
 *
 * COSA PROMETTE LA PRIVACY POLICY (services/legal/privacy.ts, localizzata in
 * it/en/de/fr, paragrafo «Ordine degli annunci in base ai clic»), e questo
 * modulo e i suoi scrittori rispettano alla lettera:
 *  - si registra quale annuncio e' stato cliccato e quattro caratteristiche:
 *    categoria, cantone, azienda, settore. Nient'altro entra nel profilo;
 *  - il profilo e' associato a un identificativo pseudonimo (HMAC dell'email con
 *    NEWSLETTER_SECRET), mai all'email in chiaro, a un uid o ad altri dati;
 *  - serve solo a ORDINARE annunci gia' selezionati: non cambia quali email si
 *    ricevono ne' quante, e non viene comunicato a inserzionisti o partner;
 *  - si aggiorna a ogni clic e scade 180 giorni dopo l'ultimo clic (TTL vero su
 *    `expires_at`, firestore.indexes.json), oppure viene cancellato subito alla
 *    disiscrizione da tutte le comunicazioni o alla cancellazione dell'account
 *    (jobEmailAffinityStore.js e i suoi chiamanti);
 *  - chi si oppone scrivendo a PUBLIC_CONTACT_EMAIL (services/publicContact)
 *    riceve l'ordine standard:
 *    l'amministratore imposta a mano `ranking_personalization_opt_out: true` su
 *    `newsletter_subscribers/{email}` e lancia
 *    `node scripts/build-job-email-affinity.mjs --forget-email <email>`, che
 *    cancella il profilo. Lo scrittore notturno non ne crea piu' uno per quella
 *    persona e cancella quello esistente al primo clic successivo; chi ordina
 *    legge comunque il flag al momento dell'invio (loadJobEmailAffinityProfiles
 *    in jobEmailAffinityStore.js non legge il profilo di chi si e' opposto).
 *
 * FORMA DEL DOCUMENTO `job_email_affinity/{pseudonimo}` (versione 1), scritto
 * per intero (`set`, mai merge) da un solo scrittore,
 * scripts/build-job-email-affinity.mjs:
 *
 *   {
 *     user_id: '<pseudonimo, uguale all'id del documento>',
 *     dimensions: {
 *       category:    [{ key: 'informatica', weight: 1.62, at: Date }, ...],
 *       canton:      [{ key: 'TI', weight: 2.40, at: Date }, ...],
 *       company_key: [...],
 *       sector:      [...],
 *     },
 *     clicks: 3,            // clic applicati in tutta la vita del profilo
 *     applied_clicks: [{ k: '<16 hex>', at: Date }, ...],
 *                           // impronte (hash di consegna + annuncio, senza
 *                           // email) dei clic gia' contati negli ultimi 90
 *                           // giorni, al massimo 500: un secondo clic sulla
 *                           // stessa coppia, anche in un giro successivo, non
 *                           // conta («un clic per consegna e annuncio»)
 *     last_click_at: Date,  // istante dell'ultimo clic applicato
 *     updated_at: Date,
 *     expires_at: Date,     // last_click_at + 180 giorni (TTL Firestore)
 *     version: 1,
 *   }
 *
 * Le quattro chiavi di `dimensions` sono fisse e i valori stanno negli array:
 * nessun valore arbitrario (nome di azienda, settore) diventa un field path.
 * `weight` e' il peso valido all'istante `at`; decade con emivita di 45 giorni.
 * Ogni dimensione tiene al massimo 30 valori, i piu' pesanti.
 *
 * SEMANTICA PER IL PASSO 3 (ordinamento):
 *  - `hasAffinityProfile(profile, now)`: vero solo con almeno
 *    AFFINITY_MIN_CLICKS clic e profilo non scaduto. Senza profilo valido si
 *    usa l'ordine standard.
 *  - `scoreJobAffinity(profile, jobAttrs, now)`: numero in [0, 1]. Per ogni
 *    dimensione in cui il profilo ha peso, la quota del peso decaduto che cade
 *    sul valore dell'annuncio (0 se l'annuncio non ha quel valore); media pesata
 *    (categoria 0,4, cantone/azienda/settore 0,2) rinormalizzata sulle sole
 *    dimensioni presenti nel profilo. 0 senza profilo valido.
 *    `jobAttrs` ha la forma del manifest delle consegne: passa
 *    `jobManifestEntry(job)` (jobEmailRankingStore.js) o
 *    `jobRankingAttributes(job)` (jobEmailRanking.js, la stessa estrazione),
 *    che portano gia' `category`, `canton`, `company_key`, `sector`.
 *  - `createAffinityScorer(profile, now)`: lo stesso punteggio con il profilo
 *    decaduto una volta sola, per ordinare molti annunci della stessa persona
 *    (rankEmailJobs in jobEmailRanking.js, variante `affinity`).
 *
 * PURO: nessun I/O, nessun Date.now() implicito. Importabile da functions/ e
 * da scripts/ (non dal browser: jobEmailRanking.js usa node:crypto).
 */

import { pseudonymousUserId } from './jobEmailRanking.js';
import {
  isAddressSuppressed,
  isCrossChannelStop,
  isJobAlertExcluded,
  isNewsletterExcluded,
} from './emailSuppression.js';
import { toMillis } from './syntheticClicks.js';

export const JOB_EMAIL_AFFINITY_COLLECTION = 'job_email_affinity';
export const JOB_EMAIL_AFFINITY_META_COLLECTION = 'job_email_affinity_meta';
export const JOB_EMAIL_AFFINITY_CURSOR_DOC = 'cursor';
export const AFFINITY_PROFILE_VERSION = 1;
export const AFFINITY_DIMENSIONS = Object.freeze(['category', 'canton', 'company_key', 'sector']);
export const AFFINITY_DIMENSION_WEIGHTS = Object.freeze({
  category: 0.4,
  canton: 0.2,
  company_key: 0.2,
  sector: 0.2,
});
export const AFFINITY_HALF_LIFE_DAYS = 45;
export const AFFINITY_TTL_DAYS = 180;
export const AFFINITY_MAX_VALUES_PER_DIMENSION = 30;
export const AFFINITY_MIN_CLICKS = 2;
export const AFFINITY_APPLIED_CLICKS_DAYS = 90;
export const AFFINITY_APPLIED_CLICKS_MAX = 500;
/** Campo booleano su newsletter_subscribers/{email}: opposizione registrata a mano. */
export const RANKING_PERSONALIZATION_OPT_OUT_FIELD = 'ranking_personalization_opt_out';

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = AFFINITY_HALF_LIFE_DAYS * DAY_MS;
const KEY_MAX_LENGTH = 80;

/**
 * Id del documento: lo pseudonimo gia' usato dai dati di ranking.
 *
 * Senza segreto rende `null`, mai l'hash non salato che pseudonymousUserId usa
 * come ripiego: un SHA-256 dell'email si inverte con un dizionario di
 * indirizzi, e un id calcolato senza segreto non coinciderebbe con quello che
 * lo scrittore notturno ha usato, quindi una cancellazione lo mancherebbe.
 */
export function affinityDocId(email, secret = process.env.NEWSLETTER_SECRET) {
  if (!secret) return null;
  return pseudonymousUserId(email, secret);
}

/**
 * Chiave canonica di un valore: stessa forma su scrittura e lettura. Il cantone
 * resta in maiuscolo a due lettere; gli altri in minuscolo, spazi compattati.
 */
export function affinityKey(dimension, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = Array.from(String(value).replace(/\s+/g, ' ').trim()).slice(0, KEY_MAX_LENGTH).join('').trim();
  if (!text) return null;
  if (dimension === 'canton') {
    const code = text.toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : null;
  }
  return text.toLowerCase();
}

/** Le quattro caratteristiche di un annuncio, dalla forma del manifest. */
export function affinityAttributes(entry) {
  const out = {};
  for (const dimension of AFFINITY_DIMENSIONS) out[dimension] = affinityKey(dimension, entry?.[dimension]);
  return out;
}

/** Vero quando l'annuncio ha almeno una caratteristica utilizzabile. */
export function hasAffinityAttributes(attrs) {
  return AFFINITY_DIMENSIONS.some((dimension) => Boolean(affinityKey(dimension, attrs?.[dimension])));
}

function decayFactor(fromMs, toMs) {
  const elapsed = Math.max(0, toMs - fromMs);
  return Math.pow(0.5, elapsed / HALF_LIFE_MS);
}

function decayedEntries(entries, nowMs) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = typeof entry?.key === 'string' ? entry.key : null;
    const weight = Number(entry?.weight);
    if (!key || !Number.isFinite(weight) || weight <= 0) continue;
    const atMs = toMillis(entry.at) ?? nowMs;
    out.push({ key, weight: weight * decayFactor(atMs, nowMs) });
  }
  return out;
}

/** Profilo vuoto per uno pseudonimo. */
export function emptyAffinityProfile(userId) {
  const dimensions = {};
  for (const dimension of AFFINITY_DIMENSIONS) dimensions[dimension] = [];
  return {
    user_id: userId || null,
    dimensions,
    clicks: 0,
    applied_clicks: [],
    last_click_at: null,
    updated_at: null,
    expires_at: null,
    version: AFFINITY_PROFILE_VERSION,
  };
}

/**
 * Applica un clic. Decade i pesi esistenti fino a `clickedAt`, aggiunge 1 a
 * ciascun valore dell'annuncio, tiene i 30 valori piu' pesanti per dimensione.
 *
 * Un clic non piu' recente di `last_click_at` e' gia' contato: il profilo torna
 * invariato (stesso oggetto). E' questo a rendere idempotente lo scrittore
 * notturno quando un giro viene ripetuto o riparte dopo un errore. Con
 * `clickKey` (impronta di consegna + annuncio) anche un secondo clic sulla
 * stessa coppia arrivato in un giro successivo torna invariato. Un clic senza
 * nessuna caratteristica lascia il profilo invariato.
 */
export function applyAffinityClick(profile, attrs, clickedAt, { clickKey = null } = {}) {
  const clickedMs = toMillis(clickedAt);
  if (clickedMs == null) return profile;
  const base = profile && typeof profile === 'object' ? profile : emptyAffinityProfile(null);
  const lastMs = toMillis(base.last_click_at);
  if (lastMs != null && clickedMs <= lastMs) return profile;
  const key = clickKey ? String(clickKey) : null;
  const priorApplied = Array.isArray(base.applied_clicks) ? base.applied_clicks : [];
  if (key && priorApplied.some((entry) => entry?.k === key)) return profile;
  const normalized = affinityAttributes(attrs);
  if (!AFFINITY_DIMENSIONS.some((dimension) => normalized[dimension])) return profile;

  const at = new Date(clickedMs);
  const dimensions = {};
  for (const dimension of AFFINITY_DIMENSIONS) {
    const entries = decayedEntries(base.dimensions?.[dimension], clickedMs);
    const value = normalized[dimension];
    if (value) {
      const hit = entries.find((entry) => entry.key === value);
      if (hit) hit.weight += 1;
      else entries.push({ key: value, weight: 1 });
    }
    entries.sort((a, b) => (b.weight - a.weight) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    dimensions[dimension] = entries
      .slice(0, AFFINITY_MAX_VALUES_PER_DIMENSION)
      .map((entry) => ({ key: entry.key, weight: Number(entry.weight.toFixed(6)), at }));
  }
  const appliedSinceMs = clickedMs - AFFINITY_APPLIED_CLICKS_DAYS * DAY_MS;
  const applied = priorApplied
    .filter((entry) => entry?.k && (toMillis(entry.at) ?? 0) >= appliedSinceMs)
    .map((entry) => ({ k: String(entry.k), at: entry.at }));
  if (key) applied.push({ k: key, at });
  return {
    user_id: base.user_id || null,
    dimensions,
    clicks: (Number(base.clicks) || 0) + 1,
    applied_clicks: applied.slice(-AFFINITY_APPLIED_CLICKS_MAX),
    last_click_at: at,
    updated_at: at,
    expires_at: new Date(clickedMs + AFFINITY_TTL_DAYS * DAY_MS),
    version: AFFINITY_PROFILE_VERSION,
  };
}

/** Vero quando il profilo e' abbastanza per ordinare: >= 2 clic e non scaduto. */
export function hasAffinityProfile(profile, now) {
  if (!profile || typeof profile !== 'object') return false;
  if (Number(profile.version) !== AFFINITY_PROFILE_VERSION) return false;
  if ((Number(profile.clicks) || 0) < AFFINITY_MIN_CLICKS) return false;
  const nowMs = toMillis(now);
  if (nowMs == null) return false;
  const expiresMs = toMillis(profile.expires_at);
  const lastMs = toMillis(profile.last_click_at);
  if (expiresMs == null || lastMs == null) return false;
  // Il TTL di Firestore cancella con ritardo: la scadenza vale gia' prima.
  return expiresMs > nowMs && nowMs - lastMs < AFFINITY_TTL_DAYS * DAY_MS;
}

/**
 * Scorer di una persona: la funzione `(jobAttrs) => [0, 1]` di
 * scoreJobAffinity con il profilo gia' decaduto a `now`, o null senza profilo
 * valido. L'ordinamento valuta centinaia di annunci per destinatario: il
 * decadimento dei pesi si calcola una volta per persona, non per annuncio.
 */
export function createAffinityScorer(profile, now) {
  if (!hasAffinityProfile(profile, now)) return null;
  const nowMs = toMillis(now);
  const dimensions = [];
  let totalWeight = 0;
  for (const dimension of AFFINITY_DIMENSIONS) {
    const entries = decayedEntries(profile.dimensions?.[dimension], nowMs);
    const mass = entries.reduce((sum, entry) => sum + entry.weight, 0);
    if (!(mass > 0)) continue;
    const weights = new Map();
    // Prima occorrenza di una chiave, come il find() di prima: lo scrittore
    // non ne produce di doppie, un documento malformato non cambia semantica.
    for (const entry of entries) if (!weights.has(entry.key)) weights.set(entry.key, entry.weight);
    dimensions.push({ dimension, weights, mass });
    totalWeight += AFFINITY_DIMENSION_WEIGHTS[dimension];
  }
  if (!(totalWeight > 0)) return () => 0;
  return (jobAttrs) => {
    const attrs = affinityAttributes(jobAttrs);
    let weighted = 0;
    for (const { dimension, weights, mass } of dimensions) {
      const value = attrs[dimension];
      const share = value ? (weights.get(value) || 0) / mass : 0;
      weighted += AFFINITY_DIMENSION_WEIGHTS[dimension] * share;
    }
    return Math.min(1, Math.max(0, weighted / totalWeight));
  };
}

/** Punteggio di affinita' in [0, 1] per un annuncio (vedi docblock). */
export function scoreJobAffinity(profile, jobAttrs, now) {
  const scorer = createAffinityScorer(profile, now);
  return scorer ? scorer(jobAttrs) : 0;
}

/**
 * Cio' che serve all'ordinamento per un destinatario: se aveva un profilo
 * valido all'istante dell'invio (`affinityProfile`, registrato su consegne e
 * impression di ENTRAMBE le varianti) e il suo scorer, o null. `profile` vale
 * null per chi si e' opposto: il chiamante non lo legge nemmeno.
 */
export function affinityRankingContext(profile, now) {
  const affinityScorer = createAffinityScorer(profile, now);
  return { affinityProfile: affinityScorer !== null, affinityScorer };
}

const norm = (value) => String(value == null ? '' : value).trim().toLowerCase();

/**
 * Vero quando la persona non riceve piu' nessuna email con annunci, cioe' si e'
 * cancellata da tutte le comunicazioni.
 *
 * `newsletter` e `jobAlert` sono i DATI dei documenti `newsletter_subscribers`
 * e `job_alert_subscribers` (snapshot.data(), non lo snapshot), o null se
 * assenti. Passa `jobAlert: null` anche quando il canale job alert e' appena
 * stato spento del tutto (nessun alert attivo).
 *
 *  - il documento newsletter dice stop su ogni canale (isCrossChannelStop:
 *    disiscrizione registrata, stop-all, bounce/complaint/soppressione);
 *  - un segnale di indirizzo (bounce, complaint) sul documento job alert;
 *  - oppure nessuno dei due canali e' piu' spedibile.
 */
export function isStoppedFromAllEmail({ newsletter = null, jobAlert = null } = {}) {
  if (newsletter && isCrossChannelStop(newsletter)) return true;
  if (jobAlert && isAddressSuppressed(jobAlert.status)) return true;
  const newsletterMailable = Boolean(newsletter) && !isNewsletterExcluded(newsletter.status);
  const jobAlertMailable = Boolean(jobAlert)
    && !isJobAlertExcluded(jobAlert.status)
    && norm(jobAlert.status) !== 'unsubscribed';
  return !newsletterMailable && !jobAlertMailable;
}
