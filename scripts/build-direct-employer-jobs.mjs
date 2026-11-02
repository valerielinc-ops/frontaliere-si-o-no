#!/usr/bin/env node
/**
 * Build the moderated direct-employer crawler slice.
 *
 * The Remote Config gate is fail-closed. A disabled channel writes an empty
 * authoritative slice, so an old approved listing can never remain indexed
 * after the owner turns the feature off.
 */

import { readExistingCrawlerJobs, writeJobsCrawlerSliceVerified } from './assemble-jobs-dataset.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { directEmployerSubmissionsToSlice } from './lib/directEmployerJobProjection.mjs';
import { DIRECT_EMPLOYER_SOURCE_KEY, readDirectEmployerChannelEnabled } from '../functions/src/directEmployerCore.js';

async function main() {
  const db = await getFirestoreDb();
  const enabled = await readDirectEmployerChannelEnabled();
  const now = new Date();
  const snapshot = enabled
    ? await db.collection('direct_employer_submissions').get()
    : { docs: [] };
  const submissions = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const approved = submissions.filter((submission) => submission.status === 'approved');
  const records = enabled ? directEmployerSubmissionsToSlice(approved, { now }) : [];
  const currentRecordIds = new Set(records.map((record) => record.directEmployerSubmissionId));
  const sourceById = new Map(submissions.map((submission) => [submission.id, submission]));
  const priorJobs = readExistingCrawlerJobs(DIRECT_EMPLOYER_SOURCE_KEY);
  const housekeepingProof = priorJobs
    .filter((job) => job?.source === DIRECT_EMPLOYER_SOURCE_KEY)
    .map((job) => {
      const submissionId = job.directEmployerSubmissionId || String(job.id || '').replace(/^direct-/u, '');
      const source = sourceById.get(submissionId);
      const expiry = source?.expiresAt?.toDate?.() || new Date(source?.expiresAt || job.validThrough || '');
      const expired = Number.isFinite(expiry.getTime()) && expiry.getTime() <= now.getTime();
      const thin = typeof source?.description === 'string' && source.description.trim().split(/\s+/u).filter(Boolean).length < 51;
      const removedByContract = !enabled || !source || source.status !== 'approved' || expired || thin || !currentRecordIds.has(submissionId);
      if (!removedByContract) return null;
      const reason = !enabled
        ? 'direct-employer-channel-disabled'
        : !source
          ? 'direct-employer-record-absent'
          : source.status !== 'approved'
            ? 'direct-employer-status-not-approved'
            : expired
              ? 'direct-employer-expired'
              : thin
                ? 'direct-employer-below-index-floor'
                : 'direct-employer-record-not-indexable';
      return { job, reason, definitive: true };
    })
    .filter(Boolean);
  await writeJobsCrawlerSliceVerified(DIRECT_EMPLOYER_SOURCE_KEY, records, {
    preserveExistingSlugs: true,
    ...(housekeepingProof.length > 0 ? { housekeepingProof } : {}),
  });
  console.log(`[build-direct-employer-jobs] enabled=${enabled} submissions=${submissions.length} approved=${approved.length} indexable=${records.length}`);
}

main().catch((error) => {
  console.error('[build-direct-employer-jobs] FATAL:', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
