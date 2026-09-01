/**
 * Assisted-application CV antivirus scan (#6408).
 *
 * CAUSA: no path in the repo runs any malware scan on an uploaded CV before
 * it is reachable by an admin. Storage rules already deny client reads on
 * `cv-uploads/**` (only the Admin SDK / forward function bypass them), but
 * "unreadable by the browser" is not "scanned" — an infected file uploaded to
 * the new assisted-application flow (#6406) would still be handed to a human
 * admin (#6407) unexamined.
 *
 * This module is the Storage-trigger core: it runs the scan and writes the
 * verdict to Firestore. The trigger wrapper lives in `functions/index.js`
 * (`scanAssistedApplicationCv`, `onObjectFinalized`) — kept out of this file,
 * like every other `*Core.js` module here, so it can be unit-tested without
 * `firebase-functions` (not a root-level dependency; see
 * `newsletterResendWebhookCore.js` for the same split).
 *
 * Scan strategy: the EICAR standard antivirus test string
 * (https://www.eicar.org/) is the industry-standard way every AV engine —
 * real or stubbed — signals "treat this file as malicious", detected here
 * with zero external dependency. `VIRUSTOTAL_API_KEY` is deliberately NOT
 * read here: it is absent from both `process.env` and `scripts/load-rc-env.mjs`
 * (RC_TO_ENV) in this repo — a real signature-database scanner is future work
 * once that credential is provisioned, not a blocker to gating visibility
 * today. Until then this fails CLOSED on any read/scan error (treated as
 * `infected`, i.e. NOT surfaced to admin) rather than failing open.
 */

import admin from 'firebase-admin';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { resolveStorageBucketName } from './lib/storageBucket.js';

// assisted-application-uploads/{orderId}/{file} — mirrors the cv-uploads/{jobId}/{file}
// shape already used by the publisher apply form (storage.rules).
export const ASSISTED_APPLICATION_UPLOAD_PATH_RE = /^assisted-application-uploads\/([^/]+)\/[^/]+$/;

export const EICAR_TEST_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const STORAGE_BUCKET = resolveStorageBucketName();

/**
 * @param {string} filePath
 * @returns {string|null} the orderId, or null when the path isn't an
 *   assisted-application upload.
 */
export function parseAssistedApplicationOrderId(filePath) {
  const m = ASSISTED_APPLICATION_UPLOAD_PATH_RE.exec(String(filePath || ''));
  return m ? m[1] : null;
}

/**
 * @param {Buffer|string} content
 * @returns {'clean'|'infected'}
 */
export function scanBufferForThreats(content) {
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : String(content ?? '');
  return text.includes(EICAR_TEST_SIGNATURE) ? 'infected' : 'clean';
}

/**
 * Reused by the admin manual-submission queue (#6407): an order is only
 * eligible once its CV has cleared the scan.
 * @param {{cvScanStatus?: string}|null|undefined} orderData
 * @returns {boolean}
 */
export function isReadyForManualSubmission(orderData) {
  return !!orderData && orderData.cvScanStatus === 'clean';
}

async function defaultReadFile(filePath) {
  const file = admin.storage().bucket(STORAGE_BUCKET).file(filePath);
  const [buffer] = await file.download();
  return buffer;
}

/**
 * Core handler for the `onObjectFinalized` trigger.
 * @param {string} filePath  storage object path
 * @param {object} [options]
 * @param {FirebaseFirestore.Firestore} [options.db]  injectable for tests
 * @param {(filePath: string) => Promise<Buffer>} [options.readFile]  injectable for tests
 * @returns {Promise<{handled: boolean, orderId?: string, cvScanStatus?: 'clean'|'infected', reason?: string}>}
 */
export async function scanAssistedApplicationCvUpload(filePath, options = {}) {
  const orderId = parseAssistedApplicationOrderId(filePath);
  if (!orderId) {
    return { handled: false, reason: 'unrecognized_path' };
  }
  const db = options.db || getAdminDb();
  const readFile = options.readFile || defaultReadFile;

  let cvScanStatus;
  try {
    const buffer = await readFile(filePath);
    cvScanStatus = scanBufferForThreats(buffer);
  } catch (e) {
    console.error('[scanAssistedApplicationCvUpload] scan failed, failing closed (infected)', e);
    cvScanStatus = 'infected';
  }

  await db.collection('assisted_applications').doc(orderId).set(
    {
      cvScanStatus,
      cvScanAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { handled: true, orderId, cvScanStatus };
}
