#!/usr/bin/env node
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
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/notify-journalist-article-live.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkLink, runWithConcurrency } from './lib/live-link-check.mjs';
import { checkArticleIdExists } from './create-article.mjs';
import { slugify } from './publish-journalist-article.mjs';
import { sendEmailCascade } from './lib/email-cascade.mjs';

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
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps?.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return { db: admin.firestore(), FieldValue: admin.firestore.FieldValue };
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
async function sendPublishedEmail(doc, publishedUrls) {
  try {
    const to = doc.authorEmail;
    if (!to) return;
    const linkList = Object.entries(publishedUrls)
      .map(([locale, url]) => `<li>${locale.toUpperCase()}: <a href="${url}">${url}</a></li>`)
      .join('');
    const { failed } = await sendEmailCascade([{
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
    if (failed.length > 0) {
      console.warn(`  ⚠️  publish notification email failed: ${failed[0].error}`);
    }
  } catch (err) {
    console.warn(`  ⚠️  publish notification email failed (non-fatal): ${err.message}`);
  }
}

async function processDoc(FieldValue, docSnap) {
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
  await sendPublishedEmail(doc, publishedUrls);
  await docSnap.ref.update({ liveVerifiedAt: FieldValue.serverTimestamp() });
}

async function main() {
  const { db, FieldValue } = await initDb();

  // In-memory filter, not `.where('liveVerifiedAt', '==', null)`: Firestore
  // equality-null only matches docs where the field is explicitly null, not
  // docs where it's entirely absent — and every doc published before this
  // script existed has no `liveVerifiedAt` field at all. Fetch-all + filter
  // matches the pattern already used correctly in
  // check-journalist-article-links.mjs.
  const snap = await db.collection('journalist_articles').where('status', '==', 'published').get();
  const pending = snap.docs.filter((docSnap) => !docSnap.data().liveVerifiedAt);
  console.log(`[notify-journalist-article-live] ${pending.length} published article(s) awaiting live confirmation.`);

  for (const docSnap of pending) {
    try {
      await processDoc(FieldValue, docSnap);
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
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
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
