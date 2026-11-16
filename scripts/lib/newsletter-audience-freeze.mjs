// scripts/lib/newsletter-audience-freeze.mjs
//
// Pubblico congelato per campagna + delta, al posto della scansione strutturale
// di tutta `newsletter_subscribers` a ogni run (perf-plan email senders, punto 2).
//
// IL PROBLEMA. Ogni run della newsletter, anche le riprese giornaliere della stessa
// campagna settimanale, leggeva l'intera collection (17,4k letture) per ricostruire
// l'elenco dei destinatari idonei. Per una ripresa con 73 destinatari residui si
// leggevano 17,4k documenti.
//
// IL DISEGNO.
//   1. Alla PRIMA run della campagna (nessun pubblico congelato) la scansione e' quella
//      di sempre. Gli id dei documenti idonei e il momento della scansione (`snapshot_at`)
//      si salvano in `newsletter_campaign_audience` (pagine da AUDIENCE_PAGE_SIZE id;
//      intestazione scritta per ULTIMA, quindi un salvataggio interrotto e' invisibile).
//      La collection NON ha trigger Cloud Functions e non si scrive mai in
//      `newsletter_subscribers`. I documenti scadono (`expires_at`, TTL).
//   2. Nelle RIPRESE: si leggono gli id congelati, si tolgono quelli gia' tentati
//      (log di ripresa e ricevute, gia' in memoria), si rileggono con `getAll` SOLO i
//      documenti dei residui per rifare consenso e soppressione con lo stesso
//      predicato della scansione piena (a ogni run, prima del claim), e si aggiunge il
//      DELTA: i documenti creati, confermati o riattivati dopo `snapshot_at` (query sui
//      campi timestamp di iscrizione, tutti con indice automatico a campo singolo),
//      che passano dalla stessa idoneita'.
//   3. Chi si e' disiscritto o e' stato soppresso dopo lo snapshot e' escluso dal
//      predicato sui residui rieseguito a ogni run.
//
// MODALITA' (`NEWSLETTER_AUDIENCE_SCAN_MODE`, Remote Config):
//   full    la scansione di oggi, senza salvare ne' leggere nulla (kill switch);
//   shadow  (default) decide la scansione piena; nelle riprese calcola anche
//           «congelato + delta» e CONFRONTA gli insiemi: il numero dei documenti che
//           differiscono va in `audienceShadowMismatch`, il dettaglio nel log solo con
//           conteggi e hash degli id (mai indirizzi). In shadow le letture sono >= di
//           oggi: scansione piena + residui + delta;
//   frozen  decide il pubblico congelato. Qualunque errore (pubblico illeggibile o
//           incoerente, query del delta rifiutata) ripiega sulla scansione piena.
//
// IL RISPARMIO c'e' solo in `frozen`: da ~17,4k letture a poche centinaia per ripresa.
//
// CIO' CHE IL DELTA NON VEDE, E PERCHE' E' ACCETTABILE. Un documento che diventa idoneo
// senza che nessuno scriva uno dei campi di iscrizione (per esempio una correzione
// manuale dello stato) non entra nel delta fino alla campagna successiva: si perde un
// invio, mai se ne raddoppia uno. Lo shadow misura quanto succede davvero prima che
// qualcuno passi a `frozen`.
//
// Privacy: i log e le metriche sono contatori e hash. Nessun indirizzo.

import { createHash } from 'node:crypto';

export const AUDIENCE_SCAN_MODES = Object.freeze(['full', 'shadow', 'frozen']);
export const DEFAULT_AUDIENCE_SCAN_MODE = 'shadow';
export const AUDIENCE_COLLECTION = 'newsletter_campaign_audience';
/** Id per pagina: ~33 byte l'uno, quindi ~130 KB per pagina, lontano da 1 MiB. */
export const AUDIENCE_PAGE_SIZE = 4000;
/** La campagna dura al massimo una settimana di riprese: 21 giorni coprono ogni ritardo. */
export const AUDIENCE_TTL_DAYS = 21;
/** Il timestamp di Firestore e' dell'orologio del server: si anticipa lo snapshot. */
export const DELTA_SLACK_MS = 120_000;
export const RESIDUAL_GET_ALL_CHUNK = 300;
/**
 * Campi con cui il codice che scrive gli iscritti (services/newsletterSubscribers.ts)
 * marca una iscrizione, una conferma o una riattivazione, nelle due grafie. Ognuno ha
 * l'indice automatico a campo singolo (nessuna esenzione in firestore.indexes.json).
 */
export const DELTA_TIMESTAMP_FIELDS = Object.freeze([
  'created_at', 'createdAt',
  'subscribed_at', 'subscribedAt',
  'confirmed_at', 'confirmedAt',
  'resubscribed_at', 'resubscribedAt',
]);

/** `NEWSLETTER_AUDIENCE_SCAN_MODE`: `shadow` di default; un valore sconosciuto vale `shadow`. */
export function resolveAudienceScanMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return AUDIENCE_SCAN_MODES.includes(value) ? value : DEFAULT_AUDIENCE_SCAN_MODE;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Hash dell'elenco ordinato di id: identifica un pubblico senza esporlo. */
export function hashAudienceIds(ids) {
  return sha256([...ids].sort().join('\n'));
}

/** Hash breve di un singolo id, per il log del dettaglio. */
export function shortIdHash(id) {
  return sha256(String(id)).slice(0, 10);
}

const pageDocId = (campaignId, index) => `${campaignId}__p${String(index).padStart(4, '0')}`;

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

/**
 * Salva il pubblico congelato. Le pagine prima, l'intestazione per ultima e con
 * `create`: se c'e' gia' un pubblico congelato per la campagna, quello vince e questo
 * salvataggio non cambia niente. Lancia se la scrittura fallisce (il chiamante la tratta
 * come «nessun pubblico congelato», cioe' la scansione piena alla prossima run).
 *
 * @param {object} db
 * @param {string} campaignId
 * @param {{docIds: string[], snapshotAt: Date, globalPreferredHour?: {hourUtc: number|null, sampleUsers: number}|null, now?: Date}} input
 * @returns {Promise<{saved: boolean, pages: number, total: number}>}
 */
export async function saveFrozenAudience(db, campaignId, { docIds, snapshotAt, globalPreferredHour = null, now = new Date() }) {
  const ids = [...docIds];
  const pages = [];
  for (let i = 0; i < ids.length; i += AUDIENCE_PAGE_SIZE) pages.push(ids.slice(i, i + AUDIENCE_PAGE_SIZE));
  const expiresAt = new Date(snapshotAt.getTime() + AUDIENCE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const collection = db.collection(AUDIENCE_COLLECTION);
  // Un'intestazione gia' presente vuol dire che un'altra run ha congelato prima: si lascia stare.
  const existing = await collection.doc(campaignId).get();
  if (existing.exists) return { saved: false, pages: pages.length, total: ids.length };

  const batch = db.batch();
  pages.forEach((emails, index) => {
    batch.set(collection.doc(pageDocId(campaignId, index)), {
      kind: 'page', campaign_id: campaignId, page: index, ids: emails, expires_at: expiresAt,
    });
  });
  if (pages.length > 0) await batch.commit();
  await collection.doc(campaignId).create({
    kind: 'header',
    campaign_id: campaignId,
    snapshot_at: snapshotAt,
    page_count: pages.length,
    total: ids.length,
    content_sha256: hashAudienceIds(ids),
    global_preferred_hour_utc: globalPreferredHour?.hourUtc ?? null,
    global_preferred_sample_users: globalPreferredHour?.sampleUsers ?? 0,
    created_at: now,
    expires_at: expiresAt,
  });
  return { saved: true, pages: pages.length, total: ids.length };
}

/**
 * Carica il pubblico congelato di una campagna. `null` se manca, se e' incompleto o
 * incoerente (pagine mancanti, totale o hash che non tornano): nel dubbio non si usa.
 *
 * @returns {Promise<null | {docIds: string[], snapshotAt: Date, globalPreferredHour: {hourUtc: number|null, sampleUsers: number}, total: number}>}
 */
export async function loadFrozenAudience(db, campaignId, { warn = () => {} } = {}) {
  const collection = db.collection(AUDIENCE_COLLECTION);
  const header = await collection.doc(campaignId).get();
  if (!header.exists) return null;
  const meta = header.data() || {};
  const pageCount = Number(meta.page_count);
  const total = Number(meta.total);
  const snapshotAt = toDate(meta.snapshot_at);
  if (!Number.isInteger(pageCount) || pageCount < 0 || !Number.isInteger(total) || total < 0 || !snapshotAt) {
    warn('   ⚠️  frozen audience header is malformed — ignoring it');
    return null;
  }
  const docIds = [];
  if (pageCount > 0) {
    const refs = Array.from({ length: pageCount }, (_, index) => collection.doc(pageDocId(campaignId, index)));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) { warn('   ⚠️  frozen audience is missing a page — ignoring it'); return null; }
      const ids = snap.data()?.ids;
      if (!Array.isArray(ids)) { warn('   ⚠️  frozen audience page is malformed — ignoring it'); return null; }
      docIds.push(...ids.map(String));
    }
  }
  if (docIds.length !== total || hashAudienceIds(docIds) !== meta.content_sha256) {
    warn('   ⚠️  frozen audience does not match its header (count or hash) — ignoring it');
    return null;
  }
  const hour = meta.global_preferred_hour_utc;
  return {
    docIds,
    snapshotAt,
    total,
    globalPreferredHour: {
      hourUtc: Number.isInteger(hour) ? hour : null,
      sampleUsers: Number(meta.global_preferred_sample_users) || 0,
    },
  };
}

/**
 * Il delta: i documenti con un campo di iscrizione/conferma/riattivazione dopo lo
 * snapshot. Ogni campo si interroga con il suo tipo (Timestamp di Firestore e ISO string,
 * perche' alcuni percorsi di scrittura salvano la stringa). Lancia se una query e' rifiutata:
 * un delta incompleto non si usa mai, il chiamante ripiega sulla scansione piena.
 *
 * @returns {Promise<Map<string, {id: string, data: () => object}>>}
 */
export async function loadAudienceDelta(db, snapshotAt, { fields = DELTA_TIMESTAMP_FIELDS, collectionName = 'newsletter_subscribers' } = {}) {
  const since = new Date(snapshotAt.getTime() - DELTA_SLACK_MS);
  const sinceIso = since.toISOString();
  const found = new Map();
  const queries = [];
  for (const field of fields) {
    queries.push(db.collection(collectionName).where(field, '>=', since).get());
    queries.push(db.collection(collectionName).where(field, '>=', sinceIso).get());
  }
  for (const snapshot of await Promise.all(queries)) {
    for (const doc of snapshot.docs || []) {
      if (doc.id !== '_meta_') found.set(doc.id, doc);
    }
  }
  return found;
}

/**
 * Documenti da rivalutare in una ripresa: i residui del pubblico congelato (riletti,
 * non cache) piu' il delta, senza doppioni e senza chi ha gia' una ricevuta o un invio.
 *
 * @param {object} options
 * @param {object} options.db
 * @param {{docIds: string[], snapshotAt: Date}} options.frozen
 * @param {(docId: string) => boolean} options.isAttempted `true` se l'indirizzo ha gia' un invio o una ricevuta
 * @returns {Promise<{docs: Array<{id: string, data: () => object}>, residualCount: number, deltaCount: number, readCount: number}>}
 */
export async function resolveFrozenAudienceDocs({ db, frozen, isAttempted, collectionName = 'newsletter_subscribers', chunkSize = RESIDUAL_GET_ALL_CHUNK }) {
  const residualIds = frozen.docIds.filter((id) => !isAttempted(id));
  const byId = new Map();
  let readCount = 0;
  for (let i = 0; i < residualIds.length; i += chunkSize) {
    const refs = residualIds.slice(i, i + chunkSize).map((id) => db.collection(collectionName).doc(id));
    const snaps = await db.getAll(...refs);
    readCount += refs.length;
    for (const snap of snaps) {
      // Un documento sparito non e' piu' un destinatario.
      if (snap.exists) byId.set(snap.id, snap);
    }
  }
  const delta = await loadAudienceDelta(db, frozen.snapshotAt, { collectionName });
  let deltaCount = 0;
  for (const [id, doc] of delta) {
    if (isAttempted(id)) continue;
    deltaCount += 1;
    // Il delta e' piu' recente dello snapshot dei residui: vince.
    byId.set(id, doc);
  }
  // Stesso ordine della scansione piena (id crescente): a parita' di priorita' decide l'ordine.
  const docs = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { docs, residualCount: residualIds.length, deltaCount, readCount };
}

/**
 * Confronto fra due insiemi di destinatari (id). Solo conteggi e hash.
 *
 * @returns {{mismatch: number, onlyFull: number, onlyFrozen: number, fullSize: number, frozenSize: number,
 *   fullHash: string, frozenHash: string, sampleOnlyFull: string[], sampleOnlyFrozen: string[]}}
 */
export function compareAudiences(fullIds, frozenIds, { sample = 5 } = {}) {
  const full = new Set(fullIds);
  const frozen = new Set(frozenIds);
  const onlyFull = [...full].filter((id) => !frozen.has(id));
  const onlyFrozen = [...frozen].filter((id) => !full.has(id));
  return {
    mismatch: onlyFull.length + onlyFrozen.length,
    onlyFull: onlyFull.length,
    onlyFrozen: onlyFrozen.length,
    fullSize: full.size,
    frozenSize: frozen.size,
    fullHash: hashAudienceIds(full),
    frozenHash: hashAudienceIds(frozen),
    sampleOnlyFull: onlyFull.sort().slice(0, sample).map(shortIdHash),
    sampleOnlyFrozen: onlyFrozen.sort().slice(0, sample).map(shortIdHash),
  };
}
