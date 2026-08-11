#!/usr/bin/env node
/**
 * restore-mailtrap-suspension-suppressions.mjs — undo the suppressions caused by
 * Mailtrap `suspension` webhooks.
 *
 * Mailtrap posts `suspension` when its own send stream stops. It is an
 * account/stream-level signal and says nothing about the recipient — its payload
 * carries no bounce_category, no response and no response_code. Until
 * 2026-07-29 `mapMailtrapEvent` translated it into a per-subscriber suppression
 * (functions/src/newsletterMailtrapWebhookCore.js), so healthy addresses were
 * removed from the newsletter: a 400-doc sample found 400 of 400 suppressed
 * subscribers caused this way, none by a real bounce or complaint, some
 * suppressed seconds after a recorded delivery and open.
 *
 * The restored STATUS is not assumed. A subscriber suppressed while still
 * `pending` (signed up but never clicked the double opt-in link) must NOT come
 * back as `confirmed` — that would fabricate a consent they never gave, a worse
 * state than the bug being repaired. So the script restores `confirmed` only
 * with positive evidence of consent (a `confirmed_at` stamp, a `confirm` /
 * `subscribe_completed` event, or an origin that is auto-confirmed by design
 * such as a job-unlock gate or a social sign-in), and `pending` otherwise.
 *
 * This restores ONLY the ones whose suppression is attributable purely to that
 * mis-mapping. A subscriber is restored when:
 *   - status is a machine-inferred suppression (`suppressed` OR `bounced` —
 *     DECAYABLE_STATUSES, see below), AND
 *   - `classifySuppressionDecay()` does NOT return the `terminal` tier (no hard
 *     bounce, no human decision, no exhausted re-probe budget), AND
 *   - it has at least one `suppressed` event whose mailtrap_event is 'suspension', AND
 *   - it has NO suppression event from any other cause (bounce, complaint, reject), AND
 *   - it never unsubscribed (no unsubscribed_at, no `unsubscribe` event).
 * Anything else is left alone and counted, so a real bounce is never resurrected
 * and an explicit opt-out is never overridden.
 *
 * ── Why the status filter is `in ['suppressed','bounced']`, and why that alone
 *    would have been dangerous ────────────────────────────────────────────────
 *
 * The original `where('status','==','suppressed')` finds 2 documents in
 * production (2026-08-11). The population this script was written for is
 * 281 documents in `status: 'bounced'` — `bounce_reason` exactly `reject`, no
 * `bounce_severity` field at all (written before
 * functions/src/lib/bounceClassification.js existed), all bounced between
 * 2026-06-13 and 2026-06-27 and none after 2026-07-01. Today's code cannot
 * produce that state: `mapMailtrapEvent` maps `reject → 'bounce'`,
 * `classifyBounceSeverity()` calls a mailtrap `reject` `'soft'`, and
 * `bounceUpdateFields({ severity: 'soft' })` never writes `status`. Those docs
 * are the residue of a writer already removed from the repo.
 *
 * Widening the status filter WITHOUT the terminal gate would restore 295 docs,
 * 14 of them genuine `bounce_severity: 'hard'` — two Gmail `NoSuchUser`, one
 * `address unknown`, four escalated after 3 consecutive soft rejects, three
 * mailbox-full, two over-quota marked hard. The reason the old precedence
 * cannot catch them is spelled out in scripts/lib/mailtrapSuspensionClassify.mjs:
 * `classify()` reads only `event_type === 'suppressed'` events, and a hard
 * bounce is logged as `event_type: 'bounce'` — invisible to it, exactly as the
 * recoverable `reject` is. The `terminal` gate in `decideRestore()` is the ONLY
 * thing separating the 281 from the 14; it is not a descriptive nicety.
 *
 * Modes (dry-run is the default — this writes to production data):
 *   --dry-run   (default) report what would change, write nothing
 *   --apply     perform the writes
 *   --limit <n> cap the number of docs restored in one run (default: no cap)
 */
import admin from 'firebase-admin';
// DECAYABLE_STATUSES is the single declaration of "which statuses are a MACHINE
// inference about the mailbox" — the only ones any recovery path may propose
// undoing. Driving the Firestore query off it (rather than a literal array
// here) means a third machine-inferred status added there is picked up by this
// script instead of silently leaving a new population unreachable.
import {
  DECAYABLE_STATUSES,
  maskAddress,
  publishableReason,
  suppressionReason,
} from './lib/suppressionDecay.mjs';
// Pure decision function, extracted to scripts/lib/ so the whole precedence —
// including the hard-bounce gate below — is importable and unit-testable
// without this file's Firebase init.
import { decideRestore } from './lib/mailtrapSuspensionClassify.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const APPLY = flag('apply');
const LIMIT = Number(opt('limit', '0')) || 0;

if (!admin.apps?.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
  });
}
const db = admin.firestore();

/**
 * Human-readable label per `decideRestore()` code, so the dry-run report says
 * WHY a document was kept instead of only how many were. Keyed on the
 * machine-readable code (never on the prose `reason`), same contract as
 * `classifySuppressionEvidence()`.
 */
const KEEP_LABEL = {
  // Terminal — from classifySuppressionDecay(), the hard-bounce/human gate.
  'hard-severity': "bounce_severity === 'hard' (verdetto strutturato del classificatore)",
  'hard-reason': 'reason che matcha il pattern hard-bounce condiviso (fallback legacy)',
  'human-status': "decisione umana: status 'complained'/'unsubscribed'",
  'human-complaint-stamp': 'decisione umana: reclamo spam registrato',
  'human-unsubscribe-stamp': 'decisione umana: unsubscribed_at registrato',
  'probe-exhausted': 'budget di re-probe esaurito senza mai una consegna',
  // Event-log precedence — this script's own signals.
  'not-suppressed': 'status non è una soppressione inferita dalla macchina',
  unsubscribed: 'opt-out esplicito (stamp o event log)',
  'real-failure': 'evento suppressed da una causa diversa da suspension',
  'no-suspension-evidence': 'nessun evento suppressed con mailtrap suspension',
};

/** Terminal codes, i.e. the ones the hard-bounce/human gate is responsible for. */
const TERMINAL_CODES = new Set([
  'hard-severity', 'hard-reason', 'human-status',
  'human-complaint-stamp', 'human-unsubscribe-stamp', 'probe-exhausted',
]);

async function main() {
  console.log(`🔧 restore-mailtrap-suspension-suppressions — mode=${APPLY ? 'APPLY' : 'dry-run'}${LIMIT ? ` limit=${LIMIT}` : ''}`);
  const nowMs = Date.now();
  const statuses = [...DECAYABLE_STATUSES];
  const snap = await db.collection('newsletter_subscribers').where('status', 'in', statuses).get();
  console.log(`   status in [${statuses.join(', ')}]: ${snap.size}`);

  const restore = [];
  let restoredConfirmed = 0;
  let restoredPending = 0;
  const byStatus = {};
  const keep = {};
  // A few masked examples per kept-terminal code. The owner has to be able to
  // eyeball WHICH addresses the gate is protecting before running --apply, and
  // an aggregate count cannot answer "is that 14 really 14 hard bounces?".
  // Masked + redacted because this output gets pasted into issues and PRs —
  // AGENTS.md Privacy: never surface a subscriber address verbatim.
  const samples = {};
  const SAMPLES_PER_CODE = 5;

  for (const doc of snap.docs) {
    if (doc.id === '_meta_') continue;
    const data = doc.data() || {};
    byStatus[data.status] = (byStatus[data.status] || 0) + 1;
    const evSnap = await doc.ref.collection('events').get();
    const events = evSnap.docs.map((e) => e.data() || {});
    const verdict = decideRestore({ sub: data, events, nowMs });

    if (!verdict.restore) {
      keep[verdict.code] = (keep[verdict.code] || 0) + 1;
      if (TERMINAL_CODES.has(verdict.code)) {
        samples[verdict.code] = samples[verdict.code] || [];
        if (samples[verdict.code].length < SAMPLES_PER_CODE) {
          samples[verdict.code].push(
            `${maskAddress(data.email || doc.id)} — "${publishableReason(suppressionReason(data))}"`,
          );
        }
      }
      continue;
    }
    if (verdict.confirmed) restoredConfirmed++; else restoredPending++;
    restore.push({
      ref: doc.ref,
      confirmed: verdict.confirmed,
      previousStatus: String(data.status || ''),
      previousReason: suppressionReason(data),
    });
  }

  const keptTerminal = Object.entries(keep)
    .filter(([code]) => TERMINAL_CODES.has(code))
    .reduce((n, [, count]) => n + count, 0);
  const keptTotal = Object.values(keep).reduce((n, c) => n + c, 0);

  console.log('\n📊 popolazione letta, per status:');
  for (const [status, count] of Object.entries(byStatus).sort()) console.log(`     ${status}: ${count}`);

  console.log(`\n✅ RIPRISTINABILI (restore.length): ${restore.length}`);
  console.log(`     restoredConfirmed (prova di consenso reale): ${restoredConfirmed}`);
  console.log(`     restoredPending   (nessuna prova → resta in doppio opt-in): ${restoredPending}`);

  console.log(`\n🛑 LASCIATI SOPPRESSI: ${keptTotal} — di cui ${keptTerminal} dal gate terminal (hard bounce / decisione umana), MAI ripristinabili`);
  for (const [code, count] of Object.entries(keep).sort((a, b) => b[1] - a[1])) {
    const mark = TERMINAL_CODES.has(code) ? '⛔' : '  ';
    console.log(`   ${mark} keep.${code}: ${count} — ${KEEP_LABEL[code] || '(codice non etichettato)'}`);
    for (const s of samples[code] || []) console.log(`         es. ${s}`);
  }

  const targets = LIMIT ? restore.slice(0, LIMIT) : restore;
  if (!APPLY) {
    console.log(`\n🧪 dry-run: nessuna scrittura. Ri-esegui con --apply per ripristinare ${targets.length} iscritti.`);
    return;
  }

  let done = 0;
  const CHUNK = 400;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = db.batch();
    for (const { ref, confirmed, previousStatus, previousReason } of targets.slice(i, i + CHUNK)) {
      const fields = {
        status: confirmed ? 'confirmed' : 'pending',
        isActive: confirmed,
        active: confirmed,
        // Disarms the escalation counter. NOT cosmetic and NOT optional now
        // that `bounced` docs are in scope: `maybeEscalateSoftBounce()` writes
        // a DELIBERATELY permanent `bounce_severity: 'hard'` after 3
        // consecutive soft rejects, and these docs carry a counter left
        // mid-way by the June reject storm. Restoring one with the counter
        // still armed means the next single soft bounce escalates it straight
        // to a permanent hard suppression — the address would come back only
        // to be killed for good. scripts/suppression-decay.mjs's
        // `recoveryFields()` writes the same field for the same reason.
        soft_bounce_count: 0,
        previous_suppression_status: previousStatus,
        suppressed_at: admin.firestore.FieldValue.delete(),
        restored_at: admin.firestore.FieldValue.serverTimestamp(),
        restored_reason: 'mailtrap_suspension_mismapped',
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      };
      // Same audit vocabulary as recoveryFields(): which stamp applies is
      // decided by the status we restored FROM, so a later reader can still
      // tell a decayed bounce from a decayed provider suppression.
      if (previousStatus === 'bounced') {
        fields.previous_bounce_reason = previousReason;
        fields.bounce_reactivated_at = admin.firestore.FieldValue.serverTimestamp();
      } else {
        fields.reactivated_at = admin.firestore.FieldValue.serverTimestamp();
        fields.mailtrap_suppression_resolved_at = admin.firestore.FieldValue.serverTimestamp();
      }
      batch.set(ref, fields, { merge: true });
    }
    await batch.commit();
    done += Math.min(CHUNK, targets.length - i);
    console.log(`   ripristinati ${done}/${targets.length}`);
  }
  console.log(`\n✅ Ripristinati ${done} iscritti.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error('❌', err?.message || err); process.exit(1); });
