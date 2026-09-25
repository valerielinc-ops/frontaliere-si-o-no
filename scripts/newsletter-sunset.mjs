#!/usr/bin/env node
/**
 * Newsletter inactivity sunset runner.
 *
 * Graduated, reversible list hygiene for never-engaging subscribers — see the
 * classifier in scripts/lib/subscriberSunset.mjs for the policy and rationale.
 * Three transitions, each computed purely then applied in batched writes:
 *
 *   winback    → send ONE "are you still there?" email, stamp winback_sent_at
 *   sunset     → status = 'inactive' (soft, excluded from sends, resubscribable)
 *   reactivate → an 'inactive' subscriber who has since engaged → status 'active'
 *   reprobe    → an 'inactive' subscriber silent long enough that reactivate's
 *                engagement evidence can never arrive → one-time, capped
 *                return to 'active' so a real send can produce it (#5559)
 *
 * `inactive` is honored by the newsletter sender via NEWSLETTER_EXCLUDED_STATUSES
 * (services/emailSuppression.mjs); it is NOT a cross-channel hard signal, so job
 * alerts are unaffected.
 *
 * Usage:
 *   node scripts/newsletter-sunset.mjs            # DRY-RUN (no writes, no email)
 *   node scripts/newsletter-sunset.mjs --apply    # apply status transitions, mark winback
 *   node scripts/newsletter-sunset.mjs --apply --send   # also send the win-back emails
 *   node scripts/newsletter-sunset.mjs --test-email me@x.ch [--locale it]  # one-off preview send
 *
 * Requires Firebase application-default credentials (CI runs load-rc-env first);
 * --test-email needs only email-provider keys (no Firestore).
 */
import { classifySunset } from './lib/subscriberSunset.mjs';
import { buildWinbackEmail } from '../services/winbackEmail.mjs';
import { commitInChunks } from './lib/firestore-batch.mjs';
import { localeOf } from './lib/subscriberLocale.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes('--apply');
const SEND = process.argv.includes('--send');
const TEST_EMAIL = argValue('--test-email');
const TEST_LOCALE = argValue('--locale') || 'it';
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';

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
}

/**
 * Build + send win-back emails via the provider cascade.
 * @param {Array<{email:string, locale:string}>} items
 * @returns {Promise<Set<string>>} lowercased emails that FAILED to send
 */
export async function sendWinbacks(items) {
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const cascade = items.map((w) => {
    const { subject, html, text, unsubscribeUrl } = buildWinbackEmail({ email: w.email, locale: w.locale });
    return {
      payload: {
        from: FROM_EMAIL,
        to: [w.email],
        subject,
        html,
        text,
        // Skip click-tracking link rewriting: the CTA is a direct resubscribe
        // action on our canonical https origin (valid cert), and the resubscribe
        // hit is our own re-engagement signal — we don't need the ESP click event.
        tracking: false,
        // campaign_id tag (#6317/#6765): forceProvider below is Resend, whose
        // webhook only reads campaign_id off this tag — Maileroo's per-message
        // ref fallback (functions/src/lib/mailerooRef.js defaultCampaignId)
        // never applies here, so without it every send fell to the
        // `unknown:<messageId>` fallback and was filed `unattributed`.
        tags: [{ name: 'campaign_id', value: 'sunset_winback' }],
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      recipient: { email: w.email },
      meta: { type: 'winback' },
    };
  });
  // forceProvider: 'resend' (#6198) — Maileroo's tracking param is a single
  // flag (opens+clicks together), so tracking:false above would also blind
  // the open-rate measurement. Resend's send fn already sets open_tracking
  // and click_tracking independently, so it's the only cascade provider that
  // can honor "clicks off, opens on". Volume is weekly/low (sunset cohort
  // only); the shared cascade enforces Resend's free-plan 100/day ceiling.
  const result = await sendEmailCascade(cascade, { concurrency: 3, forceProvider: 'resend' });
  logProviderSummary();
  return new Set(
    (result.failed || []).map((f) => String(f?.recipient?.email || f?.payload?.to?.[0] || '').toLowerCase()),
  );
}

async function main() {
  // One-off test send — no Firestore, just deliver a single win-back to inspect it.
  if (TEST_EMAIL) {
    console.log(`✉️  Test win-back → ${TEST_EMAIL} (locale=${TEST_LOCALE})`);
    const failed = await sendWinbacks([{ email: TEST_EMAIL, locale: TEST_LOCALE }]);
    if (failed.has(TEST_EMAIL.toLowerCase())) {
      console.error('❌ send failed');
      process.exit(1);
    }
    console.log('✅ sent');
    return;
  }

  await initFirebase();
  const { FieldValue } = await import('firebase-admin/firestore');
  const now = Date.now();

  const snap = await db.collection('newsletter_subscribers').get();
  const winback = [];
  const sunset = [];
  const reactivate = [];
  const reprobe = [];

  snap.forEach((doc) => {
    if (doc.id === '_meta_') return;
    const data = doc.data() || {};
    const { action } = classifySunset(data, now);
    if (action === 'winback') winback.push({ ref: doc.ref, email: data.email || doc.id, locale: localeOf(data) });
    else if (action === 'sunset') sunset.push({ ref: doc.ref, email: data.email || doc.id });
    else if (action === 'reactivate') reactivate.push({ ref: doc.ref, email: data.email || doc.id });
    else if (action === 'reprobe') reprobe.push({ ref: doc.ref, email: data.email || doc.id });
  });

  console.log(`📊 Sunset scan: ${snap.size} subscribers`);
  console.log(`   win-back to send : ${winback.length}`);
  console.log(`   to sunset        : ${sunset.length}`);
  console.log(`   to reactivate    : ${reactivate.length}`);
  console.log(`   to re-probe      : ${reprobe.length}`);

  if (!APPLY) {
    console.log('\n🔍 DRY-RUN — no writes, no emails. Re-run with --apply (and --send to email).');
    for (const w of winback.slice(0, 10)) console.log(`   [winback] ${w.email} (${w.locale})`);
    for (const s of sunset.slice(0, 10)) console.log(`   [sunset]  ${s.email}`);
    for (const r of reactivate.slice(0, 10)) console.log(`   [reactivate] ${r.email}`);
    for (const p of reprobe.slice(0, 10)) console.log(`   [reprobe] ${p.email}`);
    return;
  }

  // 1. Reactivate first — cheapest, and frees mistakenly-silent users immediately.
  //    Also clears sunset_source/inactive_at so a doc reactivated out of the
  //    dormant win-back track (scripts/newsletter-winback-campaign.mjs, #4299)
  //    doesn't carry a stale marker into whichever track sunsets it next
  //    (review PR #4338, bug C).
  if (reactivate.length) {
    await commitInChunks(db, reactivate, (batch, it) => {
      batch.set(it.ref, {
        status: 'active',
        reactivated_at: FieldValue.serverTimestamp(),
        winback_sent_at: FieldValue.delete(),
        winback_pending: FieldValue.delete(),
        sunset_source: FieldValue.delete(),
        inactive_at: FieldValue.delete(),
      }, { merge: true });
    });
    console.log(`✅ Reactivated ${reactivate.length}`);
  }

  // 1b. Re-probe: one-time, capped return to mailable for subscribers who've
  //     been inactive too long for `reactivate`'s engagement evidence to ever
  //     arrive (#5559). Distinct field from reactivated_at/reactivate so this
  //     doesn't get counted as a proven re-engagement — it's a chance, not a
  //     confirmation. sunset_reprobe_count caps it at REPROBE_MAX_ATTEMPTS
  //     forever. Deliberately NOT the bare reprobe_count/reprobed_at names —
  //     scripts/suppression-decay.mjs already owns those on this same
  //     collection for its own unrelated recovery mechanism; sharing the name
  //     would let one mechanism's counter exhaust the other's budget.
  if (reprobe.length) {
    await commitInChunks(db, reprobe, (batch, it) => {
      batch.set(it.ref, {
        status: 'active',
        sunset_reprobed_at: FieldValue.serverTimestamp(),
        sunset_reprobe_count: FieldValue.increment(1),
        winback_sent_at: FieldValue.delete(),
        winback_pending: FieldValue.delete(),
        sunset_source: FieldValue.delete(),
        inactive_at: FieldValue.delete(),
      }, { merge: true });
    });
    console.log(`🔁 Re-probed ${reprobe.length}`);
  }

  // 2. Sunset the grace-expired non-responders.
  if (sunset.length) {
    await commitInChunks(db, sunset, (batch, it) => {
      batch.set(it.ref, { status: 'inactive', inactive_at: FieldValue.serverTimestamp() }, { merge: true });
    });
    console.log(`🌙 Sunset (→ inactive) ${sunset.length}`);
  }

  // 3. Win-back: send the email, then stamp winback_sent_at ONLY for confirmed sends
  //    (so the grace clock starts when the user actually received their chance).
  if (winback.length) {
    if (!SEND) {
      console.log(`✉️  ${winback.length} win-back candidate(s) — --send not set, NOT sending/marking.`);
    } else {
      const failedEmails = await sendWinbacks(winback);
      const confirmed = winback.filter((w) => !failedEmails.has(w.email.toLowerCase()));
      await commitInChunks(db, confirmed, (batch, w) => {
        batch.set(w.ref, { winback_sent_at: FieldValue.serverTimestamp(), winback_pending: true }, { merge: true });
      });
      console.log(`✉️  Win-back sent ${confirmed.length}/${winback.length} (failed ${winback.length - confirmed.length})`);
    }
  }
}

main().catch((err) => {
  console.error('[newsletter-sunset] fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
