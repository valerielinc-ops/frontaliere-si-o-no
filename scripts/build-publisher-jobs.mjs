#!/usr/bin/env node
/**
 * build-publisher-jobs.mjs
 *
 * Reads paid publisher ads from Firestore (`publisher_jobs` where status == 'paid')
 * and projects them into the source-agnostic by-crawler slice
 * `data/jobs/by-crawler/publisher-submitted.json` via the canonical
 * writeJobsCrawlerSlice() funnel (same write-time normalization as every crawler).
 *
 * The assemble pipeline then emits a static SEO page per (ad × location) exactly
 * like a crawled job — this is the "disponibile tra 1–2 ore" path (deploy latency).
 *
 * Run by .github/workflows/publisher-jobs-sync.yml (scheduled), which commits the
 * regenerated slice to main (test-gated) → deploy → live page.
 *
 * Auth: Firebase Admin via GOOGLE_APPLICATION_CREDENTIALS (applicationDefault),
 * same as scripts/send-newsletter.mjs.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/build-publisher-jobs.mjs [--stats]
 */

import { writeJobsCrawlerSlice } from './assemble-jobs-dataset.mjs';
import { publisherJobsToSlice, PUBLISHER_SOURCE_KEY } from './lib/publisherJobProjection.mjs';

async function initDb() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return a.firestore();
}

async function main() {
  const db = await initDb();
  const snap = await db.collection('publisher_jobs').where('status', '==', 'paid').get();

  const pubJobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nowIso = new Date().toISOString();
  const records = publisherJobsToSlice(pubJobs, { nowIso });

  // writeJobsCrawlerSlice always writes the file (empty array clears the slice
  // when the last paid ad expires — keeps the slice authoritative, not stale).
  writeJobsCrawlerSlice(PUBLISHER_SOURCE_KEY, records);

  console.log(
    `[build-publisher-jobs] ${pubJobs.length} paid ad(s) → ${records.length} job record(s) in ` +
      `data/jobs/by-crawler/${PUBLISHER_SOURCE_KEY}.json`,
  );

  if (process.argv.includes('--stats')) {
    const byCanton = records.reduce((m, r) => ((m[r.canton] = (m[r.canton] || 0) + 1), m), {});
    console.log('[build-publisher-jobs] by canton:', JSON.stringify(byCanton));
  }
}

main().catch((err) => {
  console.error('[build-publisher-jobs] FATAL:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
