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

const LIVE_CHECK_TIMEOUT_MS = 15_000;
const ARTICLE_LOCALES = ['it', 'en', 'de', 'fr'];

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

/** Best-effort "your article is live" email — never throws. */
async function sendPublishedEmail(doc, publishedUrls) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('  ⚠️  RESEND_API_KEY not set — skipping publish notification email.');
      return;
    }
    const to = doc.authorEmail;
    if (!to) return;
    const linkList = Object.entries(publishedUrls)
      .map(([locale, url]) => `<li>${locale.toUpperCase()}: <a href="${url}">${url}</a></li>`)
      .join('');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: 'Frontaliere Ticino <redazione@frontaliereticino.ch>',
        to,
        subject: 'Il tuo articolo è online',
        html:
          `<h2>Il tuo articolo è stato pubblicato</h2>` +
          `<p>Ciao ${doc.authorName || ''},</p>` +
          `<p>Il tuo articolo "${doc.content?.it?.title || ''}" è ora online nelle 4 lingue del sito:</p>` +
          `<ul>${linkList}</ul>` +
          `<p>Puoi seguire statistiche e stato pubblicazione dalla tua dashboard.</p>`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`  ⚠️  publish notification email failed: Resend ${res.status}: ${errText.slice(0, 200)}`);
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
