/**
 * Free-tier abuse cap (anti-spam, gap-review P1).
 *
 * The free tier self-publishes (status:'published') with no payment. To stop a
 * single account flooding the index with free SEO pages, this onCreate trigger
 * counts the publisher's free ads created in the last 24h and, beyond the cap,
 * flips the new ad to 'rejected' (kept out of the slice by the projection, which
 * only emits paid|published). reCAPTCHA + the 50-word floor are the other layers.
 */

import admin from 'firebase-admin';

const FREE_ADS_PER_DAY = 5;

function db() {
  return admin.firestore();
}

/**
 * @param {object} jobData  the created publisher_jobs doc data
 * @param {string} jobId
 * @param {number} [nowMs]   injectable for tests
 * @returns {Promise<{capped: boolean, count?: number}>}
 */
export async function enforceFreeTierCap(jobData, jobId, nowMs = Date.now()) {
  if (!jobData || jobData.tier !== 'free' || jobData.status !== 'published') {
    return { capped: false };
  }
  const uid = jobData.publisherUid;
  if (!uid) return { capped: false };

  const cutoff = admin.firestore.Timestamp.fromMillis(nowMs - 24 * 3600 * 1000);
  const snap = await db()
    .collection('publisher_jobs')
    .where('publisherUid', '==', uid)
    .where('tier', '==', 'free')
    .where('createdAt', '>=', cutoff)
    .get();

  // Includes the just-created doc. Over the daily cap → reject this one.
  if (snap.size > FREE_ADS_PER_DAY) {
    await db().collection('publisher_jobs').doc(String(jobId)).set(
      { status: 'rejected', rejectedReason: 'free_daily_cap', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { capped: true, count: snap.size };
  }
  return { capped: false, count: snap.size };
}
