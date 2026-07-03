#!/usr/bin/env node
/**
 * Write per-company crawled-traffic counts to Firestore for the publisher
 * dashboard ("vi abbiamo mandato N candidati dai vostri annunci gratuiti").
 *
 * Input: the JSON produced by employer-traffic-report.mjs --json (employers[]
 * with { key, name, candidates, clicks }). Writes one doc per company to
 * `employer_crawled_traffic/{key}` (key = slugified company, matches the
 * dashboard's slugify(companyName) lookup). Read-only public collection
 * (firestore.rules); writes happen here via the Admin SDK only.
 *
 * Stale-doc pruning: buildTrafficDocs() only emits rows with candidates > 0
 * (no "0 candidati" noise), so a company that drops OUT of this run's set —
 * e.g. its previous count came from a source that couldn't exclude sponsored
 * traffic and the corrected free-only count is now 0 — must not keep its old
 * (now-wrong) doc forever. Any existing `employer_crawled_traffic/{key}` doc
 * whose key is NOT in the current run's key set is deleted, UNLESS that would
 * remove more than PRUNE_FLOOR_PCT (default 50%) of existing docs in one run
 * — a GA4 report that "succeeds" (no fetch error) but is missing rows for a
 * subset of employer/is_sponsored combos (transient API glitch) looks
 * identical to "these companies really have 0 candidates now", so a mass
 * drop is treated as suspect and skipped (logged, not silently dropped)
 * rather than wiping the collection. The one known LEGITIMATE mass-drop is
 * the one-time PostHog→GA4 cutover correction (sponsored-inflated employers
 * flipping to their true free-only count, possibly 0) — force it once with
 * EMPLOYER_TRAFFIC_PRUNE_FORCE=1.
 *
 * Usage (CI, after the report):
 *   node scripts/employer-traffic-report.mjs --json /tmp/report.json
 *   node scripts/write-employer-traffic.mjs /tmp/report.json
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS (service-account file) or
 * FIREBASE_SERVICE_ACCOUNT_JSON. No-op-safe: empty/invalid report → exit 0
 * (skips pruning too — a broken/empty report must never wipe the collection).
 */

import fs from 'node:fs';

const COLLECTION = 'employer_crawled_traffic';
const PRUNE_FLOOR_PCT = Number(process.env.EMPLOYER_TRAFFIC_PRUNE_FLOOR_PCT) || 50;

/** Shape the Firestore docs from a report JSON. Pure → unit-testable. */
export function buildTrafficDocs(report) {
  if (!report || !Array.isArray(report.employers)) return [];
  const days = Number(report.days) || 0;
  return report.employers
    .filter((e) => e && e.key && Number.isFinite(e.candidates) && e.candidates > 0)
    .map((e) => ({
      key: String(e.key),
      data: {
        company: String(e.name || e.key),
        candidates: Number(e.candidates) || 0,
        clicks: Number(e.clicks) || 0,
        windowDays: days,
        source: String(report.source || 'posthog'),
      },
    }));
}

async function getDb() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = path.join(os.tmpdir(), `firebase-sa-${process.pid}.json`);
    fs.writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
  }
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath || !fs.existsSync(credPath)) throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    if (cred.project_id) initializeApp({ credential: cert(cred) });
    else initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
  }
  return { db: getFirestore(), FieldValue };
}

async function run() {
  const reportPath = process.argv[2];
  if (!reportPath) { console.error('usage: write-employer-traffic.mjs <report.json>'); process.exit(2); }
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (e) { console.error(`report illeggibile: ${e.message}`); process.exit(1); }

  const docs = buildTrafficDocs(report);
  if (!docs.length) { console.log('Nessuna azienda con candidati > 0 — niente da scrivere (pruning skippato, report vuoto).'); return; }

  const { db, FieldValue } = await getDb();
  const { commitInChunks } = await import('./lib/firestore-batch.mjs');
  const written = await commitInChunks(db, docs, (batch, { key, data }) => {
    batch.set(db.collection(COLLECTION).doc(key), { ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });

  // Prune stale docs (see header comment): delete every existing doc whose key
  // is NOT in this run's set, so a company that dropped to 0 candidates loses
  // its old (possibly inflated) doc instead of keeping it forever — unless
  // that would remove more than PRUNE_FLOOR_PCT of existing docs at once,
  // which looks more like a partial/glitched report than real churn.
  const currentKeys = new Set(docs.map((d) => d.key));
  const existingSnap = await db.collection(COLLECTION).select().get();
  const staleRefs = existingSnap.docs.filter((d) => !currentKeys.has(d.id)).map((d) => d.ref);
  const staleRatio = existingSnap.size > 0 ? (staleRefs.length / existingSnap.size) * 100 : 0;

  let deleted = 0;
  let pruneSkipped = false;
  if (staleRefs.length && staleRatio > PRUNE_FLOOR_PCT && process.env.EMPLOYER_TRAFFIC_PRUNE_FORCE !== '1') {
    pruneSkipped = true;
    console.warn(`⚠️ prune skippato: rimuoverebbe ${staleRefs.length}/${existingSnap.size} doc (${staleRatio.toFixed(0)}%), oltre il floor ${PRUNE_FLOOR_PCT}% — probabile report parziale, non churn reale. Per il cutover one-time PostHog→GA4 forza con EMPLOYER_TRAFFIC_PRUNE_FORCE=1.`);
  } else if (staleRefs.length) {
    deleted = await commitInChunks(db, staleRefs, (batch, ref) => batch.delete(ref));
  }

  console.log(`✅ ${COLLECTION}: scritte ${written} aziende (window ${report.days}gg, source ${report.source})${deleted ? `, ${deleted} stale rimosse` : ''}${pruneSkipped ? ' [prune skippato: floor]' : ''}.`);
}

// Esegui solo se invocato direttamente (buildTrafficDocs resta importabile per i test).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((e) => { console.error(e.message || e); process.exit(1); });
}
