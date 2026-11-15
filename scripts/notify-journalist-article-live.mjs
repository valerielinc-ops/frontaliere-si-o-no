#!/usr/bin/env node
import { realpathSync } from 'node:fs';
/**
 * notify-journalist-article-live.mjs — Sends the "your article is online"
 * email only once the article is actually reachable, not at publish/commit
 * time (issue: journalists received the "online" email while the deploy was
 * still queued behind other commits and every URL 404'd for 30+ minutes).
 *
 * scripts/publish-journalist-article.mjs registers the article files, stamps
 * Firestore `status:'published'`, `liveVerifiedAt: null`, and returns — the
 * CALLING WORKFLOW then commits/pushes, which triggers a deploy. That deploy
 * can take anywhere from a couple minutes to much longer (queued behind other
 * rapid-fire commits to main), so "published" (files registered) and "live"
 * (deploy landed, URL returns 200) are DIFFERENT moments.
 *
 * This script is meant to run after "Deploy to GitHub Pages" completes
 * (.github/workflows/notify-journalist-article-live.yml, workflow_run
 * trigger + a schedule fallback). For every `status:'published'` doc still
 * missing `liveVerifiedAt`, it curls all 4 locale URLs; only once every one
 * of them returns 200 does it stamp `liveVerifiedAt` and send the email. A
 * doc whose deploy hasn't landed yet (still 404) is left untouched for the
 * next run — no bogus partial state, no email.
 *
 * Exit codes:
 *   0 — ran fine (including per-doc live-check misses, which are expected
 *       and just mean "try again next run", not a failure).
 *   1 — hard infra failure only (Firestore query itself failed).
 *
 * Which docs are read (perf-plan email senders, F3, review round 1). The DEFAULT stays the
 * historical scan: every `status:'published'` article, filtered in memory on
 * `liveVerifiedAt`. A server-side `liveVerifiedAt == null` query would save reads, but
 * equality-null only matches an EXPLICIT null: a published article with the field entirely
 * absent would never be seen again. Production has 13 such articles in total (read-only
 * `count()` on 2026-11-15, 0 without the field), so the saving is negligible and the
 * risk is not worth it. `JOURNALIST_PENDING_SCOPE=pending` (Remote Config) opts in to the
 * narrowed query for the day the collection is large enough to matter and the writers are
 * proven to always stamp `null` (tests/notify-journalist-article-live.test.ts pins that).
 *
 * The email is claimed before it is sent. The "online" email used to leave BEFORE the
 * `liveVerifiedAt` stamp, so a failed stamp made the next run send it again. Now a
 * transaction writes `liveNotifyClaimedAt` first, the email goes out, and the stamp
 * comes last. A claim left by a crash or by an AMBIGUOUS outcome (timeout, provider that
 * may have accepted) blocks the resend (the article is still stamped live on the next
 * run, without a second email). A DEFINITE failure (the provider explicitly refused
 * before accepting) releases the claim, only if it is ours and the article is not yet
 * stamped, and does NOT stamp: the next run retries the email.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/notify-journalist-article-live.mjs [--dry-run]
 *   --dry-run: reads and live-checks, claims/sends/stamps/requeues nothing.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { FieldValue } from 'firebase-admin/firestore';
import { checkLink, runWithConcurrency } from './lib/live-link-check.mjs';
import { sendEmailCascade } from './lib/email-cascade.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { checkArticleIdExists, slugify } from './lib/journalist-article-identity.mjs';

const LIVE_CHECK_TIMEOUT_MS = 15_000;
const ARTICLE_LOCALES = ['it', 'en', 'de', 'fr'];

// A `status:'published'` doc whose commit never actually landed on main
// (e.g. the calling workflow's git-push hit an unresolved rebase conflict
// and aborted — incident 2026-07-16, run 29485706663) is otherwise invisible
// forever: nothing else reprocesses a 'published' doc, so it stays orphaned
// while this script logs "not live yet" every run for good. Worst observed
// real deploy took 2h4m37s (run 29505580973); 3h gives that a safety margin
// before concluding the article was never committed and requeuing it.
const ORPHAN_THRESHOLD_MS = 3 * 60 * 60 * 1000;

async function initDb() {
  return { db: await getFirestoreDb(), FieldValue };
}

/** True only when EVERY locale URL present on the doc is live (checkLink —
 * see scripts/lib/live-link-check.mjs) — a partial deploy (e.g. IT live,
 * EN/DE/FR not yet) must not trigger the "online in 4 languages" email.
 * Missing locale URLs (shouldn't normally happen once status is 'published')
 * count as not-live rather than being silently ignored. */
async function checkAllLocalesLive(publishedUrls) {
  const urls = ARTICLE_LOCALES.map((locale) => publishedUrls?.[locale]);
  if (urls.some((url) => !url)) return false;
  const results = await runWithConcurrency(urls, urls.length, (url) => checkLink(url, LIVE_CHECK_TIMEOUT_MS));
  return results.every(Boolean);
}

/** Best-effort "your article is live" email — never throws. Routed through
 * the multi-provider cascade (2026-07-16, was a direct Resend fetch) so a
 * low volume already-quota-aware/paced send never competes unaccounted
 * against the dynamic Resend cap, and falls back to another provider
 * instead of silently dropping the email if Resend alone is exhausted. */
/**
 * @returns {Promise<'sent'|'skipped'|'definite-failure'|'ambiguous'>}
 *   - `skipped`: nothing to send (no author address);
 *   - `sent`: a provider accepted the message;
 *   - `definite-failure`: every provider explicitly refused BEFORE accepting (cascade
 *     `failed` entries without `ambiguousDelivery`): safe to retry;
 *   - `ambiguous`: anything else (an exception such as the timeout abort, a failure the
 *     cascade flags `ambiguousDelivery`, or an empty result): the message may have gone
 *     out, so it is NOT retried.
 */
async function sendPublishedEmail(doc, publishedUrls) {
  try {
    const to = doc.authorEmail;
    if (!to) return 'skipped';
    const linkList = Object.entries(publishedUrls)
      .map(([locale, url]) => `<li>${locale.toUpperCase()}: <a href="${url}">${url}</a></li>`)
      .join('');
    const { sent = [], failed = [] } = await sendEmailCascade([{
      payload: {
        from: 'Frontaliere Ticino <redazione@frontaliereticino.ch>',
        to,
        subject: 'Il tuo articolo è online',
        html:
          `<h2>Il tuo articolo è stato pubblicato</h2>` +
          `<p>Ciao ${doc.authorName || ''},</p>` +
          `<p>Il tuo articolo "${doc.content?.it?.title || ''}" è ora online nelle 4 lingue del sito:</p>` +
          `<ul>${linkList}</ul>` +
          `<p>Puoi seguire statistiche e stato pubblicazione dalla tua dashboard.</p>`,
        tags: [{ name: 'campaign_id', value: 'journalist_article_live' }],
      },
      recipient: { email: to },
      meta: {},
    }], {
      // Bounds this send the same way as the hero-image download in
      // publish-journalist-article.mjs (issue #3209 item 3) — a hung
      // provider API call must not block this run indefinitely.
      signal: AbortSignal.timeout(LIVE_CHECK_TIMEOUT_MS),
    });
    if (sent.length > 0) return 'sent';
    if (failed.length > 0) {
      console.warn(`  ⚠️  publish notification email failed: ${failed[0].error}`);
      return failed.some((failure) => failure?.ambiguousDelivery === true) ? 'ambiguous' : 'definite-failure';
    }
    return 'ambiguous';
  } catch (err) {
    console.warn(`  ⚠️  publish notification email failed (non-fatal): ${err.message}`);
    return 'ambiguous';
  }
}

/**
 * Atomically claim the "online" email of one article before it is sent.
 *
 *   - `liveVerifiedAt` already set (another run stamped it): nothing to do;
 *   - `liveNotifyClaimedAt` already present: an earlier run claimed it and may have sent
 *     the email, so it is NEVER sent again;
 *   - otherwise the claim is written and the caller may send.
 *
 * @returns {Promise<'claimed'|'already-claimed'|'already-verified'|'missing'>}
 */
export async function claimLiveNotification(docRef, FieldValue, claimId) {
  return docRef.firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(docRef);
    if (!snapshot.exists) return 'missing';
    const data = snapshot.data() || {};
    if (data.liveVerifiedAt) return 'already-verified';
    if (data.liveNotifyClaimedAt) return 'already-claimed';
    tx.update(docRef, {
      liveNotifyClaimedAt: FieldValue.serverTimestamp(),
      liveNotifyClaimId: claimId,
    });
    return 'claimed';
  });
}

/**
 * Release OUR claim after a definite failure: only if `liveNotifyClaimId` is ours and the
 * article is not stamped live. Anything else (another run's claim, an already verified
 * article) is left alone.
 *
 * @returns {Promise<'released'|'not-owner'|'already-verified'|'missing'>}
 */
export async function releaseLiveNotificationClaim(docRef, FieldValue, claimId) {
  return docRef.firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(docRef);
    if (!snapshot.exists) return 'missing';
    const data = snapshot.data() || {};
    if (data.liveVerifiedAt) return 'already-verified';
    if (data.liveNotifyClaimId !== claimId) return 'not-owner';
    tx.update(docRef, { liveNotifyClaimedAt: FieldValue.delete(), liveNotifyClaimId: FieldValue.delete() });
    return 'released';
  });
}

async function processDoc(FieldValue, docSnap, { dryRun = false, claimId = `journalist-live-${Date.now()}` } = {}) {
  const docId = docSnap.id;
  const doc = docSnap.data();
  const publishedUrls = doc.publishedUrls || {};

  const live = await checkAllLocalesLive(publishedUrls);
  if (!live) {
    const publishedAtMs = doc.publishedAt?.toMillis ? doc.publishedAt.toMillis() : null;
    const ageMs = publishedAtMs ? Date.now() - publishedAtMs : 0;
    if (ageMs > ORPHAN_THRESHOLD_MS) {
      const articleId = slugify(docId) || docId;
      if (!checkArticleIdExists(articleId)) {
        if (dryRun) {
          console.log(`  🔵 [dry-run] ${docId}: would requeue (not live after ${Math.round(ageMs / 3_600_000)}h, absent from the registry).`);
          return;
        }
        console.warn(
          `  ♻️  ${docId}: still not live after ${Math.round(ageMs / 3_600_000)}h and "${articleId}" is absent ` +
            `from the article registry — requeuing (publish commit likely never landed on main).`,
        );
        await docSnap.ref.update({
          status: 'queued',
          publishedAt: FieldValue.delete(),
          publishedUrls: FieldValue.delete(),
          slugs: FieldValue.delete(),
          liveVerifiedAt: FieldValue.delete(),
        });
        return;
      }
    }
    console.log(`  ⏭️  ${docId}: not live yet (deploy pending) — will retry next run.`);
    return;
  }

  console.log(`  ✅ ${docId}: live in all ${ARTICLE_LOCALES.length} locales.`);
  if (dryRun) {
    console.log(`  🔵 [dry-run] ${docId}: would claim, send the email and stamp liveVerifiedAt.`);
    return;
  }
  const claim = await claimLiveNotification(docSnap.ref, FieldValue, claimId);
  if (claim === 'already-verified' || claim === 'missing') return;
  if (claim === 'already-claimed') {
    // An earlier run claimed the email and then died before stamping. It may have been
    // sent, so it is not sent again; the page IS live, so the article is stamped.
    console.warn(`  ⚠️  ${docId}: a previous run already claimed the notification — not sending it again; stamping liveVerifiedAt.`);
    await docSnap.ref.update({ liveVerifiedAt: FieldValue.serverTimestamp() });
    return;
  }
  const outcome = await sendPublishedEmail(doc, publishedUrls);
  if (outcome === 'definite-failure') {
    // Every provider refused before accepting: nothing went out. Release our claim and do
    // NOT stamp, so the next run retries the email (a stamp here would lose it for good).
    try {
      await releaseLiveNotificationClaim(docSnap.ref, FieldValue, claimId);
    } catch (err) {
      console.warn(`  ⚠️  ${docId}: could not release the notification claim (${err.message}); the next run will stamp without re-sending.`);
    }
    console.warn(`  ↻ ${docId}: notification not sent (definite failure) — will retry next run.`);
    return;
  }
  // `sent`, `skipped` and `ambiguous` all stamp: a message that may have left is never retried.
  await docSnap.ref.update({ liveVerifiedAt: FieldValue.serverTimestamp() });
}

/**
 * The pending articles: published and not yet stamped live. Narrowed server-side to
 * `liveVerifiedAt == null` only when explicitly asked (`scope === 'pending'`, see the
 * header); the default `all` is the historical read-everything-and-filter scan, which also
 * sees a published article that lacks the field entirely.
 */
export async function loadPendingArticles(db, { scope = 'all' } = {}) {
  const published = db.collection('journalist_articles').where('status', '==', 'published');
  if (scope !== 'pending') {
    const snap = await published.get();
    return snap.docs.filter((docSnap) => !docSnap.data().liveVerifiedAt);
  }
  const snap = await published.where('liveVerifiedAt', '==', null).get();
  return snap.docs;
}

async function main() {
  const { db, FieldValue } = await initDb();
  const dryRun = process.argv.includes('--dry-run');

  const scope = String(process.env.JOURNALIST_PENDING_SCOPE || '').trim().toLowerCase() === 'pending' ? 'pending' : 'all';
  const pending = await loadPendingArticles(db, { scope });
  console.log(`[notify-journalist-article-live] ${pending.length} published article(s) awaiting live confirmation${dryRun ? ' (dry-run)' : ''}.`);

  const claimId = `journalist-live-${Date.now()}`;
  for (const docSnap of pending) {
    try {
      await processDoc(FieldValue, docSnap, { dryRun, claimId });
    } catch (err) {
      // Best-effort per doc: a live-check hiccup on one article must never
      // abort the run or block the others.
      console.error(`  ❌ ${docSnap.id}: unexpected failure (non-fatal, skipping doc): ${err.message}`);
    }
  }

  console.log('[notify-journalist-article-live] done.');
}

const invokedDirectly = (() => {
  try {
    return (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[notify-journalist-article-live] FATAL:', err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}

export { checkAllLocalesLive, sendPublishedEmail, processDoc };
