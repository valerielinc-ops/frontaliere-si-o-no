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
import { commitInChunks } from './lib/firestore-batch.mjs';

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
  // Live ads = sponsored+paid OR free+published.
  const snap = await db
    .collection('publisher_jobs')
    .where('status', 'in', ['paid', 'published'])
    .get();

  const pubJobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nowIso = new Date().toISOString();
  const records = publisherJobsToSlice(pubJobs, { nowIso });

  // writeJobsCrawlerSlice always writes the file (empty array clears the slice
  // when the last paid ad expires — keeps the slice authoritative, not stale).
  writeJobsCrawlerSlice(PUBLISHER_SOURCE_KEY, records);

  // Stamp each projected ad with its public URL + projection timestamp so the
  // publisher dashboard can distinguish "In revisione" (paid but not yet picked
  // up by this sync) from "Online" (projected into the slice + deploy triggered)
  // and link to the live page. Best-effort — never fail the slice write over it.
  try {
    const adminMod = await import('firebase-admin');
    const FieldValue = (adminMod.default || adminMod).firestore.FieldValue;
    const firstUrlByAd = new Map();
    for (const r of records) {
      if (r.publisherJobId && !firstUrlByAd.has(r.publisherJobId)) {
        // Canonical trailing slash (site convention) on the public link.
        firstUrlByAd.set(r.publisherJobId, r.url.endsWith('/') ? r.url : `${r.url}/`);
      }
    }
    if (firstUrlByAd.size) {
      // Chunk the writeback so it scales past the Firestore 500-op batch cap:
      // a single batch.commit() over >500 ads throws (caught non-fatal below),
      // which would leave every paid ad stuck on "In revisione" that run.
      const stamped = await commitInChunks(db, [...firstUrlByAd], (batch, [jobId, publicUrl]) =>
        batch.set(
          db.collection('publisher_jobs').doc(jobId),
          { publicUrl, projectedAt: FieldValue.serverTimestamp() },
          { merge: true },
        ),
      );
      console.log(`[build-publisher-jobs] stamped publicUrl + projectedAt on ${stamped} ad(s).`);
    }
  } catch (err) {
    console.warn('[build-publisher-jobs] writeback (publicUrl/projectedAt) failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  console.log(
    `[build-publisher-jobs] ${pubJobs.length} live ad(s) (paid + free-published) → ${records.length} job record(s) in ` +
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
