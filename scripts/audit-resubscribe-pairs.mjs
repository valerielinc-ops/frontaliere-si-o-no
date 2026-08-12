/**
 * audit-resubscribe-pairs.mjs — how many opt-outs were undone within seconds?
 *
 * THE MEASUREMENT #5711 ASKS FOR, and the reason it cannot reuse the previous one.
 * ------------------------------------------------------------------------------
 * The 186 resurrections of #5672 were found by querying for documents that
 * carry `unsubscribed_at` and are nevertheless active. Against THIS defect that
 * query returns nothing, because until #5711 a re-subscription deleted the
 * stamp: the production case that opened the issue (unsubscribe 12:40:53 →
 * `confirmed`/active 12:40:55, `source_channel: resubscribe_link`) reads back
 * with `unsubscribed_at: null`. A one-and-a-half-second reactivation left the
 * tidiest document in the collection.
 *
 * The `events` subcollection is append-only — nothing in this repository
 * deletes an event — so the count is recoverable there, as PAIRS: an opt-out
 * event followed within a short window by a re-opt-in event on the same
 * address. The pairing rule itself is in scripts/lib/resubscribePairs.mjs,
 * pure and fixture-tested (tests/resubscribe-pairs.test.ts); this file is only
 * the Firestore half.
 *
 * Usage:
 *   node scripts/audit-resubscribe-pairs.mjs                  # DRY-RUN (default): reads, prints, writes nothing
 *   node scripts/audit-resubscribe-pairs.mjs --window 120     # widen the pairing window (seconds, default 60)
 *   node scripts/audit-resubscribe-pairs.mjs --limit 500      # cap the documents scanned (debug)
 *   node scripts/audit-resubscribe-pairs.mjs --json out.json  # also write the full pair list to a file
 *   node scripts/audit-resubscribe-pairs.mjs --apply          # ALSO append a marker event to each matched doc
 *
 * `--apply` is deliberately the WEAKEST write this script could make: one
 * `resubscribe_scan_suspected` event per matched pair, appended to the trail it
 * just read. It changes no status, no flag and no stamp. Deciding what to DO
 * about a subscription that was reactivated by a machine is a decision about
 * other people's mail, and it belongs to the chained remediation the issue
 * defers, not to the script that counts them. Re-running is safe: a marker
 * already present for the same pair is not written twice.
 *
 * Requires Firebase application-default credentials (see bin/rc-env.sh). The
 * scan is a collection-group read over `events`, so it is billed per event
 * document — hence `--limit`.
 */

import { writeFileSync } from 'node:fs';
import {
  findRapidResubscribePairs,
  summarizePairs,
  OPT_OUT_EVENT_TYPES,
  RE_OPT_IN_EVENT_TYPES,
  DEFAULT_WINDOW_SECONDS,
} from './lib/resubscribePairs.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const WINDOW_SECONDS = Number(argValue('--window')) > 0
  ? Number(argValue('--window'))
  : DEFAULT_WINDOW_SECONDS;
const LIMIT = Number(argValue('--limit')) > 0 ? Number(argValue('--limit')) : 0;
const JSON_OUT = argValue('--json');

let db;

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  db = a.firestore();
  return a;
}

/**
 * Read the event trail of every subscriber that has one.
 *
 * Per-document rather than a collection-group query on purpose: the events live
 * at `newsletter_subscribers/<email>/events`, so the document id IS the address
 * and no composite index is needed. A collection-group read would be one query
 * but would need `email` present on every event row, which older rows are not
 * guaranteed to carry.
 */
async function collectEvents() {
  const subsSnap = await db.collection('newsletter_subscribers').select().get();
  const ids = subsSnap.docs.map((d) => d.id).filter((id) => id !== '_meta_');
  const scanned = LIMIT ? ids.slice(0, LIMIT) : ids;
  console.log(`📊 ${ids.length} subscriber document(s); scanning ${scanned.length}`);

  const events = [];
  const refsByEmail = new Map();
  let done = 0;
  for (const id of scanned) {
    const ref = db.collection('newsletter_subscribers').doc(id);
    refsByEmail.set(id.toLowerCase(), ref);
    const evSnap = await ref.collection('events').get();
    evSnap.forEach((d) => {
      const data = d.data() || {};
      const type = String(data.event_type || '').trim().toLowerCase();
      if (!OPT_OUT_EVENT_TYPES.includes(type) && !RE_OPT_IN_EVENT_TYPES.includes(type)) return;
      events.push({
        ...data,
        email: String(data.email || id).toLowerCase(),
        // Firestore Timestamps survive the pure layer via toEpochMillis.
        occurred_at: data.occurred_at ?? null,
        timestamp: data.timestamp ?? null,
      });
    });
    done += 1;
    if (done % 500 === 0) console.log(`   …${done}/${scanned.length}`);
  }
  return { events, refsByEmail };
}

async function main() {
  await initFirebase();
  const { FieldValue } = await import('firebase-admin/firestore');

  const { events, refsByEmail } = await collectEvents();
  console.log(`📊 ${events.length} opt-out/re-opt-in event(s) collected`);

  const pairs = findRapidResubscribePairs(events, { windowSeconds: WINDOW_SECONDS });
  const summary = summarizePairs(pairs);

  console.log('');
  console.log(`🔎 window: ${WINDOW_SECONDS}s`);
  console.log(`🔎 pairs: ${summary.total} across ${summary.uniqueEmails} address(es)`);
  console.log(`🔎 gap distribution: ${JSON.stringify(summary.buckets)}`);
  console.log(`🔎 by source_channel: ${JSON.stringify(summary.byChannel)}`);
  console.log(`🔎 by request_method: ${JSON.stringify(summary.byMethod)}`);
  console.log('');
  console.log('   `request_method` is only recorded on re-opt-in events written');
  console.log('   after #5711 shipped. `(unrecorded)` means "before the fix", not "GET".');
  console.log('');

  for (const p of pairs.slice(0, 25)) {
    // The address is redacted in the console output: this runs in CI logs.
    const [local, domain] = p.email.split('@');
    const masked = `${local.slice(0, 2)}***@${domain || ''}`;
    console.log(`   ${String(p.gapMs).padStart(7)}ms  ${masked}  ${p.optOutType} → ${p.reOptInType}  ${p.sourceChannel || '-'}`);
  }
  if (pairs.length > 25) console.log(`   … and ${pairs.length - 25} more`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ windowSeconds: WINDOW_SECONDS, summary, pairs }, null, 2));
    console.log(`\n💾 full pair list → ${JSON_OUT}`);
  }

  if (!APPLY) {
    console.log('\n🧪 DRY-RUN — nothing written. Re-run with --apply to append the marker events.');
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const p of pairs) {
    const ref = refsByEmail.get(p.email);
    if (!ref) { skipped += 1; continue; }
    const existing = await ref.collection('events')
      .where('event_type', '==', 'resubscribe_scan_suspected')
      .where('pair_re_opt_in_at', '==', p.reOptInAt)
      .limit(1)
      .get();
    if (!existing.empty) { skipped += 1; continue; }
    await ref.collection('events').add({
      email: p.email,
      event_type: 'resubscribe_scan_suspected',
      source_channel: p.sourceChannel || null,
      pair_opt_out_at: p.optOutAt,
      pair_re_opt_in_at: p.reOptInAt,
      pair_opt_out_type: p.optOutType,
      pair_re_opt_in_type: p.reOptInType,
      gap_ms: p.gapMs,
      window_seconds: WINDOW_SECONDS,
      detected_by: 'scripts/audit-resubscribe-pairs.mjs',
      timestamp: FieldValue.serverTimestamp(),
      occurred_at: new Date().toISOString(),
    });
    written += 1;
  }
  console.log(`\n✅ marker events written: ${written}, skipped (already marked or no doc): ${skipped}`);
  console.log('   No status, flag or stamp was changed — remediation is chained work on #5711.');
}

main().catch((err) => {
  console.error('❌ audit-resubscribe-pairs failed:', err?.message || err);
  process.exit(1);
});
