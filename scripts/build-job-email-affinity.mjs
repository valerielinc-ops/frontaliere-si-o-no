#!/usr/bin/env node
/**
 * build-job-email-affinity.mjs — costruisce e aggiorna, ogni notte, il profilo
 * di interessi per persona (`job_email_affinity/{pseudonimo}`) dai clic sugli
 * annunci delle email. Forma del documento, semantica e promesse della privacy
 * policy: functions/src/lib/jobEmailAffinity.js. Questo e' l'unico scrittore.
 *
 * DA DOVE LEGGE I CLIC. Dalla sottocollection `events` degli iscritti
 * (`newsletter_subscribers/{email}/events`, `job_alert_subscribers/{email}/events`),
 * con la query collection-group `event_type == 'click'` + range di `timestamp`
 * coperta dall'indice composito di firestore.indexes.json. Non da
 * `job_email_ranking_events`: li' quasi tutti i campi sono esentati
 * dall'indice e lo `user_id` scritto dai webhook non e' lo pseudonimo HMAC.
 *
 * QUALI CLIC CONTANO.
 *  - solo i link degli annunci (`je=1`, parseJobRankingClick);
 *  - solo i clic di una persona: functions/src/lib/syntheticClicks.js
 *    (link di uscita, user-agent automatici, IP degli scanner, raffiche di 5 o
 *    piu' link dallo stesso messaggio entro 3 secondi), applicato per messaggio;
 *  - un clic per persona, consegna e annuncio;
 *  - niente invii di QA/operatore (`is_operator_verification`);
 *  - niente persone escluse: opposizione (`ranking_personalization_opt_out`),
 *    disiscritte da tutto, account cancellato. Per queste il profilo esistente
 *    viene cancellato.
 *
 * DA DOVE PRENDE LE QUATTRO CARATTERISTICHE dell'annuncio cliccato:
 *  1. il manifest `job_email_ranking_deliveries/{hash(delivery_id)}.jobs`;
 *  2. se li' mancano (consegne precedenti al manifest con gli attributi), il
 *     `ranking_jobs` di `campaign_deliveries` dello stesso iscritto, passato
 *     dalla stessa jobManifestEntry del manifest. Le schede della newsletter
 *     non hanno il cantone: si ricava dalla localita' con lo stesso resolver
 *     che usa matchJobsForSubscriber.
 *  Un clic senza caratteristiche risolvibili si salta e si conta.
 *
 * IDEMPOTENZA. Un cursore (`job_email_affinity_meta/cursor.processed_until`)
 * avanza solo dopo che tutti i profili sono stati scritti; applyAffinityClick
 * ignora i clic non piu' recenti dell'ultimo gia' applicato al profilo, quindi
 * un giro ripetuto o ripartito a meta' non conta due volte lo stesso clic.
 *
 * LOG: solo conteggi. Mai email, pseudonimi o URL.
 *
 * Uso:
 *   node scripts/build-job-email-affinity.mjs                 # giro notturno dal cursore
 *   node scripts/build-job-email-affinity.mjs --bootstrap-since 2026-09-08T00:00:00Z
 *   node scripts/build-job-email-affinity.mjs --dry-run [--bootstrap-since <ISO>]
 *   node scripts/build-job-email-affinity.mjs --forget-email <email> [--dry-run]
 *   opzioni: --max-reads <n> (default 60000), --lag-minutes <n> (default 15)
 *
 * Ambiente: GOOGLE_APPLICATION_CREDENTIALS, NEWSLETTER_SECRET
 * (eval "$(node scripts/load-rc-env.mjs)").
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyClickEvents, toMillis } from '../functions/src/lib/syntheticClicks.js';
import { parseJobRankingClick } from '../functions/src/lib/jobEmailRankingLinks.js';
import { stableJobId } from '../functions/src/lib/jobEmailRanking.js';
import {
  JOB_EMAIL_RANKING_DELIVERIES_COLLECTION,
  jobManifestEntry,
  rankingDeliveryDocumentId,
} from '../functions/src/lib/jobEmailRankingStore.js';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';
import { isAccountDeletedTombstone } from '../functions/src/authAccountCleanup.js';
import {
  AFFINITY_PROFILE_VERSION,
  JOB_EMAIL_AFFINITY_COLLECTION,
  JOB_EMAIL_AFFINITY_CURSOR_DOC,
  JOB_EMAIL_AFFINITY_META_COLLECTION,
  RANKING_PERSONALIZATION_OPT_OUT_FIELD,
  affinityAttributes,
  affinityDocId,
  applyAffinityClick,
  emptyAffinityProfile,
  hasAffinityAttributes,
  hasAffinityProfile,
  isStoppedFromAllEmail,
} from '../functions/src/lib/jobEmailAffinity.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 60 * 60 * 1000;
export const SUBSCRIBER_COLLECTIONS = Object.freeze(['newsletter_subscribers', 'job_alert_subscribers']);
/** Clic letti prima dell'inizio solo per riconoscere una raffica a cavallo. */
export const BURST_CONTEXT_MS = 60 * 1000;
export const DEFAULT_MAX_READS = 60000;
export const DEFAULT_LAG_MINUTES = 15;
const PAGE_SIZE = 500;
const GET_ALL_CHUNK = 100;
const WRITE_BATCH_SIZE = 400;

export class AffinityBuildError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'AffinityBuildError';
    this.exitCode = exitCode;
  }
}

/** Toglie email e pseudonimi da un messaggio d'errore prima di stamparlo. */
export function redact(message) {
  return String(message || '')
    .replace(/[^\s/'"`]+@[^\s/'"`]+/g, '<email>')
    .replace(/\b[0-9a-f]{32}\b/gi, '<pseudonimo>');
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    dryRun: false,
    bootstrapSince: null,
    forgetEmail: null,
    maxReads: DEFAULT_MAX_READS,
    lagMinutes: DEFAULT_LAG_MINUTES,
  };
  const value = (index, name) => {
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) throw new AffinityBuildError(`${name} richiede un valore`, { exitCode: 2 });
    return next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--bootstrap-since') { options.bootstrapSince = value(index, arg); index += 1; }
    else if (arg === '--forget-email') { options.forgetEmail = value(index, arg); index += 1; }
    else if (arg === '--max-reads') { options.maxReads = Number(value(index, arg)); index += 1; }
    else if (arg === '--lag-minutes') { options.lagMinutes = Number(value(index, arg)); index += 1; }
    else throw new AffinityBuildError(`opzione sconosciuta: ${arg}`, { exitCode: 2 });
  }
  if (options.bootstrapSince !== null && !Number.isFinite(Date.parse(options.bootstrapSince))) {
    throw new AffinityBuildError('--bootstrap-since vuole una data ISO', { exitCode: 2 });
  }
  if (!Number.isFinite(options.maxReads) || options.maxReads <= 0) {
    throw new AffinityBuildError('--max-reads vuole un numero positivo', { exitCode: 2 });
  }
  if (!Number.isFinite(options.lagMinutes) || options.lagMinutes < 0) {
    throw new AffinityBuildError('--lag-minutes vuole un numero non negativo', { exitCode: 2 });
  }
  return options;
}

function createReadBudget(maxReads) {
  return {
    used: 0,
    add(count) {
      this.used += Math.max(1, count);
      if (this.used > maxReads) {
        throw new AffinityBuildError(`tetto di letture superato (${this.used} > ${maxReads}): nessuna scrittura eseguita`);
      }
    },
  };
}

async function getAllInChunks(db, refs, budget) {
  const out = [];
  for (let offset = 0; offset < refs.length; offset += GET_ALL_CHUNK) {
    const chunk = refs.slice(offset, offset + GET_ALL_CHUNK);
    budget.add(chunk.length);
    out.push(...await db.getAll(...chunk));
  }
  return out;
}

/** Clic con `timestamp` in [fromMs, toMs), giorno per giorno, pagine dal piu' recente. */
async function readClickDocs(db, fromMs, toMs, budget) {
  const docs = [];
  for (let dayStart = fromMs; dayStart < toMs; dayStart += DAY_MS) {
    const dayEnd = Math.min(dayStart + DAY_MS, toMs);
    let last = null;
    for (;;) {
      let query = db.collectionGroup('events')
        .where('event_type', '==', 'click')
        .where('timestamp', '>=', new Date(dayStart))
        .where('timestamp', '<', new Date(dayEnd))
        .orderBy('timestamp', 'desc')
        .limit(PAGE_SIZE);
      if (last) query = query.startAfter(last);
      const snapshot = await query.get();
      budget.add(snapshot.docs.length);
      docs.push(...snapshot.docs);
      if (snapshot.docs.length < PAGE_SIZE) break;
      last = snapshot.docs[snapshot.docs.length - 1];
    }
  }
  return docs;
}

/** Un clic letto, o null se l'evento non sta sotto un iscritto di primo livello. */
function clickRow(doc) {
  const subscriberRef = doc.ref?.parent?.parent;
  const topCollection = subscriberRef?.parent;
  if (!subscriberRef || !topCollection || topCollection.parent) return null;
  if (!SUBSCRIBER_COLLECTIONS.includes(topCollection.id)) return null;
  const email = String(subscriberRef.id || '').trim().toLowerCase();
  if (!email.includes('@')) return null;
  const data = doc.data() || {};
  const timestampMs = toMillis(data.timestamp);
  if (timestampMs == null) return null;
  return {
    collection: topCollection.id,
    email,
    timestampMs,
    atMs: toMillis(data.occurred_at) ?? timestampMs,
    messageId: data.message_id ? String(data.message_id) : null,
    campaignId: data.campaign_id ? String(data.campaign_id) : null,
    event: data,
  };
}

/**
 * Verdetto umano/sintetico per ogni riga, calcolato per messaggio: e' li' che
 * una raffica di scanner si riconosce (5 link in 3 secondi dallo stesso invio).
 */
/**
 * Impronta di un clic per `applied_clicks` del profilo: hash di consegna (o
 * messaggio) + annuncio, 16 caratteri esadecimali. Non contiene l'email: il
 * profilo e' gia' della persona.
 */
export function clickFingerprint(pairKey) {
  return createHash('sha256').update(String(pairKey)).digest('hex').slice(0, 16);
}

function classifyRows(rows, counts) {
  const groups = new Map();
  let withoutMessage = 0;
  for (const row of rows) {
    // Senza message_id non si sa da quale invio venga il clic: gruppo a se',
    // mai un gruppo condiviso che renderebbe raffica clic di invii diversi.
    const messageKey = row.messageId ? `m:${row.messageId}` : `nomsg:${(withoutMessage += 1)}`;
    const key = `${row.collection}/${row.email}|${messageKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    // classifyClickEvents ordina per istante con un sort stabile: ordinando
    // prima con la stessa chiave, il verdetto i-esimo e' quello della riga i.
    group.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
    const { verdicts } = classifyClickEvents(group.map((row) => ({ ...row.event, at: row.atMs })));
    group.forEach((row, index) => {
      const verdict = verdicts[index];
      if (!verdict || verdict.atMs !== row.atMs) throw new AffinityBuildError('verdetti dei clic non allineati alle righe');
      row.url = verdict.url;
      row.syntheticReason = verdict.synthetic ? verdict.reason : null;
    });
  }
  counts.message_groups = groups.size;
}

let cantonResolver;
/** Resolver del cantone dalla localita', come matchJobsForSubscriber. */
async function defaultResolveCanton(card) {
  if (cantonResolver === undefined) {
    try {
      const { createCantonResolvers } = await import('../build-plugins/shared/cantonResolvers.mjs');
      const read = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', name), 'utf8'));
      cantonResolver = createCantonResolvers({
        cantonSlugFile: read('canton-url-slugs.json'),
        municipalitiesFile: read('canton-municipalities.json'),
      });
    } catch {
      cantonResolver = null;
    }
  }
  return cantonResolver ? cantonResolver.resolveJobCanton(card) : null;
}

/** Id con cui il link dell'email ha citato un annuncio salvato in ranking_jobs. */
function storedJobId(entry) {
  if (entry?.job_id) return String(entry.job_id);
  return stableJobId(entry);
}

/**
 * Le quattro caratteristiche di un annuncio salvato in campaign_deliveries:
 * gia' un manifest (job_id, company_key) oppure l'oggetto completo delle
 * consegne precedenti, normalizzato con la stessa jobManifestEntry.
 */
export async function storedJobAttributes(entry, surface, resolveCanton = defaultResolveCanton) {
  if (!entry || typeof entry !== 'object') return affinityAttributes(null);
  if ('job_id' in entry || 'company_key' in entry) return affinityAttributes(entry);
  let job = entry;
  if (surface === 'newsletter' && !entry.canton) {
    job = { ...entry, canton: (await resolveCanton(entry)) || null };
  }
  return affinityAttributes(jobManifestEntry(job, 0));
}

/** Perche' una persona non deve avere un profilo, o null. */
export function affinityExclusionReason({ newsletter = null, jobAlert = null } = {}) {
  if (!newsletter && !jobAlert) return 'no_subscriber';
  if ((newsletter && isAccountDeletedTombstone(newsletter)) || (jobAlert && isAccountDeletedTombstone(jobAlert))) {
    return 'account_deleted';
  }
  if (newsletter?.[RANKING_PERSONALIZATION_OPT_OUT_FIELD] === true) return 'opt_out';
  if (isStoppedFromAllEmail({ newsletter, jobAlert })) return 'unsubscribed_all';
  return null;
}

function bump(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

async function commitWrites(db, operations) {
  let written = 0;
  for (let offset = 0; offset < operations.length; offset += WRITE_BATCH_SIZE) {
    const batch = db.batch();
    const chunk = operations.slice(offset, offset + WRITE_BATCH_SIZE);
    for (const operation of chunk) {
      if (operation.type === 'delete') batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data);
    }
    await batch.commit();
    written += chunk.length;
  }
  return written;
}

/**
 * Un giro completo. Rende i conteggi; scrive solo fuori da dry-run.
 * @param {object} options
 * @param {import('firebase-admin/firestore').Firestore} options.db
 * @param {string} options.secret NEWSLETTER_SECRET
 * @param {Date} [options.now]
 */
export async function runAffinityBuild({
  db,
  secret,
  now = new Date(),
  dryRun = false,
  bootstrapSince = null,
  maxReads = DEFAULT_MAX_READS,
  lagMinutes = DEFAULT_LAG_MINUTES,
  resolveCanton = defaultResolveCanton,
} = {}) {
  if (!db) throw new AffinityBuildError('Firestore non disponibile');
  if (!affinityDocId('probe@example.invalid', secret)) {
    throw new AffinityBuildError('NEWSLETTER_SECRET mancante: senza, lo pseudonimo non si calcola');
  }
  const budget = createReadBudget(maxReads);
  const nowMs = now.getTime();
  const counts = { dry_run: dryRun };

  const cursorRef = db.collection(JOB_EMAIL_AFFINITY_META_COLLECTION).doc(JOB_EMAIL_AFFINITY_CURSOR_DOC);
  budget.add(1);
  const cursorSnap = await cursorRef.get();
  const cursorMs = cursorSnap.exists ? toMillis(cursorSnap.data()?.processed_until) : null;
  let startMs;
  if (bootstrapSince) startMs = Date.parse(bootstrapSince);
  else if (cursorMs != null) startMs = cursorMs;
  else {
    throw new AffinityBuildError(
      'nessun cursore in job_email_affinity_meta/cursor: lancia la prima costruzione con --bootstrap-since <ISO>',
      { exitCode: 2 },
    );
  }
  const endMs = nowMs - lagMinutes * 60 * 1000;
  counts.window_days = Math.max(0, Number(((endMs - startMs) / DAY_MS).toFixed(2)));
  if (!(startMs < endMs)) {
    counts.reads = budget.used;
    counts.nothing_to_do = true;
    return counts;
  }

  // 1. Clic della finestra, piu' un margine prima dell'inizio per le raffiche.
  const docs = await readClickDocs(db, startMs - BURST_CONTEXT_MS, endMs, budget);
  counts.click_events_read = docs.length;
  const rows = [];
  for (const doc of docs) {
    const row = clickRow(doc);
    if (row) rows.push(row);
    else bump(counts, 'skipped_other_parent');
  }
  classifyRows(rows, counts);

  // 2. Solo link degli annunci, solo persone, un clic per consegna e annuncio.
  // Le righe prima della finestra servono solo al verdetto delle raffiche
  // (classifyRows, sopra): qui si scartano subito, prima della deduplica, cosi'
  // non nascondono un clic della finestra. I clic gia' contati in un giro
  // precedente li riconosce il profilo (applied_clicks, passo 5).
  const seen = new Set();
  const useful = [];
  rows.sort((a, b) => a.timestampMs - b.timestampMs);
  for (const row of rows) {
    if (row.timestampMs < startMs) continue;
    const click = parseJobRankingClick(row.url);
    if (!click) {
      bump(counts, 'skipped_not_job_link');
      continue;
    }
    if (row.syntheticReason) {
      bump(counts, `skipped_synthetic_${row.syntheticReason.replace(/-/g, '_')}`);
      continue;
    }
    const pairKey = `${click.deliveryId || row.messageId || ''}|${click.jobId}`;
    const dedupKey = `${row.email}|${pairKey}`;
    if (seen.has(dedupKey)) {
      bump(counts, 'skipped_duplicate');
      continue;
    }
    seen.add(dedupKey);
    useful.push({ ...row, click, clickKey: clickFingerprint(pairKey) });
  }
  counts.job_clicks_human = useful.length;

  // 3. Esclusioni, per persona.
  const emails = [...new Set(useful.map((row) => row.email))].sort();
  counts.persons_with_clicks = emails.length;
  const subscriberRefs = emails.flatMap((email) => SUBSCRIBER_COLLECTIONS.map((name) => db.collection(name).doc(email)));
  const subscriberSnaps = await getAllInChunks(db, subscriberRefs, budget);
  const exclusion = new Map();
  emails.forEach((email, index) => {
    const [newsletterSnap, jobAlertSnap] = subscriberSnaps.slice(index * 2, index * 2 + 2);
    const reason = affinityExclusionReason({
      newsletter: newsletterSnap?.exists ? (newsletterSnap.data() || {}) : null,
      jobAlert: jobAlertSnap?.exists ? (jobAlertSnap.data() || {}) : null,
    });
    if (reason) {
      exclusion.set(email, reason);
      bump(counts, `persons_excluded_${reason}`);
    }
  });
  const eligible = useful.filter((row) => {
    if (!exclusion.has(row.email)) return true;
    bump(counts, 'skipped_excluded_person');
    return false;
  });

  // 4. Caratteristiche: prima il manifest della consegna, poi campaign_deliveries.
  const deliveryIds = [...new Set(eligible.map((row) => row.click.deliveryId).filter(Boolean))];
  const deliverySnaps = await getAllInChunks(
    db,
    deliveryIds.map((id) => db.collection(JOB_EMAIL_RANKING_DELIVERIES_COLLECTION).doc(rankingDeliveryDocumentId(id))),
    budget,
  );
  const deliveries = new Map(deliveryIds.map((id, index) => [id, deliverySnaps[index]?.exists ? (deliverySnaps[index].data() || {}) : null]));

  const fallbackPaths = new Map();
  for (const row of eligible) {
    const delivery = row.click.deliveryId ? deliveries.get(row.click.deliveryId) : null;
    const entry = Array.isArray(delivery?.jobs)
      ? delivery.jobs.find((job) => String(job?.job_id) === row.click.jobId)
      : null;
    if (entry && hasAffinityAttributes(entry)) {
      row.attrs = affinityAttributes(entry);
      bump(counts, 'attributes_from_delivery_manifest');
      continue;
    }
    const campaignKey = row.click.surface === 'job_alert'
      ? (row.click.deliveryId || row.click.alertId)
      : (row.click.newsletterId || delivery?.newsletter_id || row.campaignId);
    if (!campaignKey) continue;
    row.fallbackPath = `${row.collection}/${row.email}/campaign_deliveries/${buildDeliveryDocId(campaignKey, row.email)}`;
    fallbackPaths.set(row.fallbackPath, null);
  }
  const fallbackKeys = [...fallbackPaths.keys()];
  const fallbackSnaps = await getAllInChunks(db, fallbackKeys.map((docPath) => db.doc(docPath)), budget);
  fallbackKeys.forEach((docPath, index) => {
    fallbackPaths.set(docPath, fallbackSnaps[index]?.exists ? (fallbackSnaps[index].data() || {}) : null);
  });
  const resolved = [];
  for (const row of eligible) {
    if (!row.attrs && row.fallbackPath) {
      const stored = fallbackPaths.get(row.fallbackPath);
      if (stored?.is_operator_verification === true) {
        bump(counts, 'skipped_operator_send');
        continue;
      }
      const entry = Array.isArray(stored?.ranking_jobs)
        ? stored.ranking_jobs.find((job) => storedJobId(job) === row.click.jobId)
        : null;
      if (entry) {
        const attrs = await storedJobAttributes(entry, row.click.surface, resolveCanton);
        if (hasAffinityAttributes(attrs)) {
          row.attrs = attrs;
          bump(counts, 'attributes_from_campaign_delivery');
        }
      }
    }
    if (!row.attrs) {
      bump(counts, 'skipped_no_attributes');
      continue;
    }
    for (const [dimension, value] of Object.entries(row.attrs)) {
      if (value) bump(counts, `usable_clicks_with_${dimension}`);
    }
    resolved.push(row);
  }
  counts.job_clicks_usable = resolved.length;

  // 5. Profili esistenti: di chi ha clic utili e di chi va escluso.
  const byPerson = new Map();
  for (const row of resolved) {
    if (!byPerson.has(row.email)) byPerson.set(row.email, []);
    byPerson.get(row.email).push(row);
  }
  const targets = [...new Set([...byPerson.keys(), ...exclusion.keys()])].sort();
  const ids = targets.map((email) => affinityDocId(email, secret));
  const profileRefs = ids.map((id) => db.collection(JOB_EMAIL_AFFINITY_COLLECTION).doc(id));
  const profileSnaps = await getAllInChunks(db, profileRefs, budget);

  const operations = [];
  let validProfiles = 0;
  targets.forEach((email, index) => {
    const snap = profileSnaps[index];
    const existing = snap?.exists ? (snap.data() || null) : null;
    if (exclusion.has(email)) {
      if (existing) {
        operations.push({ type: 'delete', ref: profileRefs[index] });
        bump(counts, 'profiles_deleted');
      }
      return;
    }
    let profile = existing && Number(existing.version) === AFFINITY_PROFILE_VERSION
      ? existing
      : emptyAffinityProfile(ids[index]);
    const start = profile;
    for (const row of byPerson.get(email) || []) {
      const next = applyAffinityClick(profile, row.attrs, new Date(row.timestampMs), { clickKey: row.clickKey });
      if (next === profile) bump(counts, 'clicks_already_applied');
      else bump(counts, 'clicks_applied');
      profile = next;
    }
    if (profile === start) return;
    profile = { ...profile, user_id: ids[index], updated_at: new Date(nowMs) };
    if (hasAffinityProfile(profile, now)) validProfiles += 1;
    operations.push({ type: 'set', ref: profileRefs[index], data: profile });
    bump(counts, existing ? 'profiles_updated' : 'profiles_created');
  });
  counts.profiles_written = operations.filter((operation) => operation.type === 'set').length;
  counts.profiles_valid_after_write = validProfiles;
  counts.reads = budget.used;

  if (dryRun) {
    counts.writes = 0;
    return counts;
  }
  counts.writes = await commitWrites(db, operations);
  // Il cursore avanza solo a scritture concluse: un errore sopra lascia il
  // giro da ripetere, e la ripetizione non conta due volte (applyAffinityClick).
  await cursorRef.set({
    processed_until: new Date(endMs),
    updated_at: new Date(nowMs),
    version: AFFINITY_PROFILE_VERSION,
  });
  counts.writes += 1;
  return counts;
}

/** Cancella il profilo di un indirizzo (opposizione registrata a mano). */
export async function forgetAffinityProfile({ db, secret, email, dryRun = false }) {
  const id = affinityDocId(String(email || '').trim().toLowerCase(), secret);
  if (!id) throw new AffinityBuildError('NEWSLETTER_SECRET mancante: senza, lo pseudonimo non si calcola');
  const ref = db.collection(JOB_EMAIL_AFFINITY_COLLECTION).doc(id);
  const snap = await ref.get();
  if (snap.exists && !dryRun) await ref.delete();
  return { dry_run: dryRun, profile_found: snap.exists === true, profile_deleted: snap.exists === true && !dryRun };
}

function writeSummary(counts) {
  console.log(JSON.stringify(counts, null, 2));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = ['## job_email_affinity', '', '| conteggio | valore |', '|---|---|'];
  for (const [key, value] of Object.entries(counts)) lines.push(`| ${key} | ${value} |`);
  try {
    fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
  } catch { /* il riepilogo e' un di piu' */ }
}

export async function main(argv = process.argv, { getDb } = {}) {
  const options = parseArgs(argv);
  const secret = process.env.NEWSLETTER_SECRET;
  const db = getDb
    ? await getDb()
    : await (await import('./lib/firestore-admin.mjs')).getFirestoreDb();
  if (options.forgetEmail) {
    writeSummary(await forgetAffinityProfile({ db, secret, email: options.forgetEmail, dryRun: options.dryRun }));
    return 0;
  }
  writeSummary(await runAffinityBuild({ db, secret, ...options }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`job_email_affinity: ${redact(error?.message || error)}`);
      process.exit(error?.exitCode || 1);
    },
  );
}
