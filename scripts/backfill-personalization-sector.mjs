#!/usr/bin/env node
/**
 * Backfill: correct STALE auto-derived sector fields on subscriber profiles
 * (issue #2993, follow-up to #3146).
 *
 * The daily personalization enrichment (send-job-alerts.mjs) is no-clobber: it
 * only fills a BLANK field. Before #3146 the sector derivation summed
 * viewed-job categories WITHOUT de-duping, so a subscriber whose ATS mis-tags N
 * roles (e.g. EOC labels nurse jobs "admin") got `sector_interest` set to the
 * repeated mis-tag (N×2 weight) instead of their EXPLICIT on-site category
 * filter (×3). #3146 fixed the derivation for all FUTURE enrichments, but the
 * already-written wrong value sticks forever (no-clobber never re-touches it).
 *
 * This one-shot re-derives sector with the fixed logic and overwrites ONLY when
 * it is safe and demonstrably a correction:
 *   • the profile was auto-enriched by us (`personalization_enriched_at` set);
 *   • the freshly-derived sector is non-blank and DIFFERS from the stored one;
 *   • the STORED sector is NOT one the user explicitly filtered by on-site
 *     (`filterUsage.category`) — so an intentional sector is never overwritten.
 * It touches only `sector_interest` / `job_category`; location/company/search
 * fields (which may come from signup geo, not personalization) are left intact.
 *
 * Reuses the SAME pure `derivePersonalizationPatch` as the live pipeline (no
 * logic fork): the enrichable fields are blanked so the no-clobber derivation
 * re-emits the ideal sector.
 *
 * Default is DRY RUN. Pass --apply to write. --limit N caps scanned profiles;
 * --email <addr> targets a single subscriber (useful for verification).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/backfill-personalization-sector.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/backfill-personalization-sector.mjs --apply
 */

import { pathToFileURL } from 'node:url';
import {
  derivePersonalizationPatch,
  PERSONALIZATION_FIELDS,
} from './lib/subscriber-personalization.mjs';

const SECTOR_FIELDS = ['sector_interest', 'job_category'];

// Bounded concurrency for per-subscriber Firestore reads. The loop below was
// fully sequential (one subscriber's 2 reads awaited before the next started),
// so wall-time scaled linearly with the `newsletter_subscribers` collection
// size — it eventually exceeded the workflow's 10-minute timeout as the
// collection grew (issue #5053). Reads are independent per subscriber, so
// fanning them out is safe.
//
// MEASURED, not assumed (AGENTS.md "unvalidated perf claim"). Dry-run
// workflow_dispatch on this branch, run 30986186256, against the live
// collection:
//   • scan phase 07:46:55.59Z → 07:47:48.28Z = 52.7s for 2383 profiles;
//   • whole job 3m20s including npm ci, vs the 10-minute workflow timeout.
// Baseline for the same code path sequential: run 30797095605 was CANCELLED at
// the timeout after 7m44s WITHOUT finishing a smaller collection (2321
// profiles). So the fix is verified on a LARGER input than the one that failed.
//
// REVERT TRIGGER: this leaves ~9 minutes of headroom at 2383 profiles. If a
// future scheduled run times out again, the collection has outgrown a flat
// concurrency of 20 — raise it or paginate the scan; do NOT raise the workflow
// timeout, which would only re-hide the growth (Non-Negotiable #1).
const READ_CONCURRENCY = 20;

function parseArgs(argv) {
  const args = { apply: false, limit: Infinity, email: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--limit') args.limit = Number(argv[++i]) || Infinity;
    else if (a === '--email') args.email = String(argv[++i] || '').toLowerCase().trim();
  }
  return args;
}

async function getFirestoreAdmin() {
  const admin = await import('firebase-admin');
  if (!admin.default.apps?.length) {
    admin.default.initializeApp({
      credential: admin.default.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return { db: admin.default.firestore(), FieldValue: admin.default.firestore.FieldValue };
}

const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * Compute the safe sector correction for one subscriber, or null when nothing
 * should change.
 * @returns {Record<string,string>|null}
 */
export function computeSectorCorrection(subscriber, personalization, alerts) {
  // Blank the enrichable fields so the no-clobber derivation re-emits the ideal.
  const blanked = { ...subscriber };
  for (const f of PERSONALIZATION_FIELDS) blanked[f] = '';
  const ideal = derivePersonalizationPatch({ subscriber: blanked, personalization, alerts, clicked: null }) || {};

  // The categories the user EXPLICITLY filtered by on-site. This backfill ONLY
  // repairs the precise #3146 bug — an explicit category filter that was
  // overridden by repeated mis-tagged viewed-job categories. So we correct a
  // field ONLY when the freshly-derived value IS an explicitly-filtered category
  // AND the stored value is NOT. That avoids re-deriving on drifted browsing
  // data (which could flip a still-valid sector, e.g. health → tech, without
  // any explicit signal behind it) — those are left untouched.
  const explicitCategories = new Set(
    Object.keys(personalization?.filterUsage?.category || {}).map(norm),
  );

  const correction = {};
  for (const field of SECTOR_FIELDS) {
    const stored = subscriber[field];
    const next = ideal[field];
    if (!next || !String(next).trim()) continue;          // nothing better to write
    if (norm(stored) === norm(next)) continue;            // already correct
    if (!explicitCategories.has(norm(next))) continue;    // new value isn't an explicit filter → not the bug
    if (stored && explicitCategories.has(norm(stored))) continue; // stored is also explicit → user's choice
    correction[field] = next;
  }
  return Object.keys(correction).length > 0 ? correction : null;
}

async function loadAlerts(db, email) {
  const snap = await db.collection('job_alert_subscribers').doc(email).collection('alerts').get();
  return snap.docs.map((d) => d.data());
}

async function loadPersonalization(db, email) {
  const doc = await db.collection('newsletter_subscribers').doc(email)
    .collection('private').doc('personalization').get();
  return doc.exists ? doc.data() : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(args.apply ? '⚙️  APPLY mode — will write sector corrections' : '🔵 DRY RUN — no writes (pass --apply to commit)');
  const { db, FieldValue } = await getFirestoreAdmin();

  // Only profiles we previously auto-enriched carry the field; orderBy returns
  // exactly those (Firestore skips docs missing the ordered field).
  let query = db.collection('newsletter_subscribers').orderBy('personalization_enriched_at');
  let docs;
  if (args.email) {
    const d = await db.collection('newsletter_subscribers').doc(args.email).get();
    docs = d.exists ? [d] : [];
  } else {
    docs = (await query.get()).docs;
  }
  console.log(`   Candidate enriched profiles: ${docs.length}`);

  const toScan = docs.slice(0, Number.isFinite(args.limit) ? args.limit : docs.length);
  const corrections = [];
  for (let i = 0; i < toScan.length; i += READ_CONCURRENCY) {
    const chunk = toScan.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.all(chunk.map(async (doc) => {
      const email = doc.id;
      const subscriber = doc.data() || {};
      const [personalization, alerts] = await Promise.all([
        loadPersonalization(db, email),
        loadAlerts(db, email),
      ]);
      const correction = computeSectorCorrection(subscriber, personalization, alerts);
      return correction
        ? { email, before: { sector_interest: subscriber.sector_interest, job_category: subscriber.job_category }, after: correction }
        : null;
    }));
    for (const r of results) if (r) corrections.push(r);
  }
  const scanned = toScan.length;

  console.log(`   Scanned: ${scanned}   Corrections: ${corrections.length}`);
  for (const c of corrections.slice(0, 50)) {
    console.log(`   • ${c.email}: ${c.before.sector_interest ?? '∅'}/${c.before.job_category ?? '∅'} → ${c.after.sector_interest ?? '(keep)'}/${c.after.job_category ?? '(keep)'}`);
  }
  if (corrections.length > 50) console.log(`   … and ${corrections.length - 50} more`);

  if (!args.apply) {
    console.log('\n🔵 DRY RUN complete — re-run with --apply to write the above corrections.');
    return;
  }
  if (corrections.length === 0) {
    console.log('\n✅ Nothing to correct.');
    return;
  }

  let written = 0;
  // Small batches; this is a one-shot, no need for the chunked helper.
  const CHUNK = 400;
  for (let i = 0; i < corrections.length; i += CHUNK) {
    const batch = db.batch();
    for (const c of corrections.slice(i, i + CHUNK)) {
      batch.set(db.collection('newsletter_subscribers').doc(c.email), {
        ...c.after,
        sector_backfilled_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      written++;
    }
    await batch.commit();
  }
  console.log(`\n✅ Applied ${written} sector correction(s).`);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
