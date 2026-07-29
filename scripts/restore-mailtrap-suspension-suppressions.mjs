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
 *   - status === 'suppressed', AND
 *   - it has at least one `suppressed` event whose mailtrap_event is 'suspension', AND
 *   - it has NO suppression event from any other cause (bounce, complaint, reject), AND
 *   - it never unsubscribed (no unsubscribed_at, no `unsubscribe` event).
 * Anything else is left alone and counted, so a real bounce is never resurrected
 * and an explicit opt-out is never overridden.
 *
 * Modes (dry-run is the default — this writes to production data):
 *   --dry-run   (default) report what would change, write nothing
 *   --apply     perform the writes
 *   --limit <n> cap the number of docs restored in one run (default: no cap)
 */
import admin from 'firebase-admin';

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
 * Origins that confirm at signup by design (the user performed an explicit act
 * — unlocking a job, signing in with a provider — so no double opt-in is sent).
 * Mirrors CONFIRMED_NEWSLETTER_SOURCES in services/newsletterSubscribers.ts.
 *
 * `publisher_gate_social` only. Its sibling `publisher_gate_email` is
 * pending-BY-DESIGN: components/pages/PublisherPublishPage.tsx deliberately
 * omits status/isActive there so a new address falls to `pending` and gets the
 * opt-in email, and CONFIRMED_NEWSLETTER_SOURCES does not list it. Matching the
 * bare `publisher_gate` prefix would have restored those to `confirmed` —
 * exactly the fabricated consent this function exists to prevent.
 */
const AUTO_CONFIRMED_ORIGIN_RE = /^(signup|auth_|chatbot_|job_|tax_calendar_(google|facebook)|resubscribe_link|newsletter_email_link|one_tap|publisher_gate_social)/i;

function hasConsentEvidence(data, events) {
  if (data?.confirmed_at || data?.confirmedAt) return true;
  for (const e of events) {
    const t = String(e.event_type || '');
    if (t === 'confirm' || t === 'subscribe_completed') return true;
  }
  for (const field of [data?.source_cta, data?.source, data?.source_channel]) {
    if (field && AUTO_CONFIRMED_ORIGIN_RE.test(String(field))) return true;
  }
  return false;
}

function classify(events) {
  let sawSuspension = false;
  let sawRealFailure = false;
  let sawUnsubscribe = false;
  for (const e of events) {
    const type = String(e.event_type || '');
    const raw = String(e.mailtrap_event || e.provider_event || '').toLowerCase();
    if (type === 'unsubscribed' || raw === 'unsubscribe') sawUnsubscribe = true;
    if (type !== 'suppressed') continue;
    // Anything that is not a suspension counts as a real recipient-level
    // failure, INCLUDING an empty/unknown raw event: an unrecognised cause must
    // keep the address suppressed rather than resurrect it on a guess.
    if (raw === 'suspension') sawSuspension = true;
    else sawRealFailure = true;
  }
  return { sawSuspension, sawRealFailure, sawUnsubscribe };
}

async function main() {
  console.log(`🔧 restore-mailtrap-suspension-suppressions — mode=${APPLY ? 'APPLY' : 'dry-run'}${LIMIT ? ` limit=${LIMIT}` : ''}`);
  const snap = await db.collection('newsletter_subscribers').where('status', '==', 'suppressed').get();
  console.log(`   status=suppressed: ${snap.size}`);

  const restore = [];
  let restoredConfirmed = 0;
  let restoredPending = 0;
  const keep = { realFailure: 0, unsubscribed: 0, noSuspensionEvidence: 0 };

  for (const doc of snap.docs) {
    if (doc.id === '_meta_') continue;
    const data = doc.data() || {};
    const evSnap = await doc.ref.collection('events').get();
    const events = evSnap.docs.map((e) => e.data() || {});
    const { sawSuspension, sawRealFailure, sawUnsubscribe } = classify(events);

    if (data.unsubscribed_at || sawUnsubscribe) { keep.unsubscribed++; continue; }
    if (sawRealFailure) { keep.realFailure++; continue; }
    if (!sawSuspension) { keep.noSuspensionEvidence++; continue; }
    const confirmed = hasConsentEvidence(data, events);
    if (confirmed) restoredConfirmed++; else restoredPending++;
    restore.push({ ref: doc.ref, confirmed });
  }

  console.log(`   da ripristinare: ${restore.length} (a 'confirmed' con prova di consenso: ${restoredConfirmed}, a 'pending' senza prova: ${restoredPending})`);
  console.log(`   lasciati soppressi: bounce/complaint reali=${keep.realFailure}, disiscritti=${keep.unsubscribed}, senza prova di suspension=${keep.noSuspensionEvidence}`);

  const targets = LIMIT ? restore.slice(0, LIMIT) : restore;
  if (!APPLY) {
    console.log(`\n🧪 dry-run: nessuna scrittura. Ri-esegui con --apply per ripristinare ${targets.length} iscritti.`);
    return;
  }

  let done = 0;
  const CHUNK = 400;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = db.batch();
    for (const { ref, confirmed } of targets.slice(i, i + CHUNK)) {
      batch.set(ref, {
        status: confirmed ? 'confirmed' : 'pending',
        isActive: confirmed,
        active: confirmed,
        suppressed_at: admin.firestore.FieldValue.delete(),
        restored_at: admin.firestore.FieldValue.serverTimestamp(),
        restored_reason: 'mailtrap_suspension_mismapped',
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
    done += Math.min(CHUNK, targets.length - i);
    console.log(`   ripristinati ${done}/${targets.length}`);
  }
  console.log(`\n✅ Ripristinati ${done} iscritti.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error('❌', err?.message || err); process.exit(1); });
