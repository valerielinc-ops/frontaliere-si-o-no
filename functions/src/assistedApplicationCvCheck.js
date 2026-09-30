/**
 * Server-side type check for assisted-application CV uploads.
 *
 * storage.rules can only trust the client-declared contentType; this reads
 * the first bytes of the stored object (Admin SDK) and records whether they
 * really are a PDF, a legacy Word (OLE2) or a DOCX (ZIP) file. The owner queue
 * shows the CV as "type verified, not virus-scanned" and withholds the link
 * when the bytes do not match — see assistedApplicationAdminCore.js.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

const STORAGE_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET ||
  process.env.STORAGE_BUCKET ||
  'frontaliere-ticino.firebasestorage.app';

const SIGNATURES = [
  { type: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { type: 'doc', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // OLE2 compound file
  { type: 'docx', bytes: [0x50, 0x4b, 0x03, 0x04] }, // ZIP (Office Open XML)
];

/** @param {Uint8Array|Buffer} head the first bytes of the file */
export function detectCvFileType(head) {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  for (const signature of SIGNATURES) {
    if (signature.bytes.every((value, index) => bytes[index] === value)) return signature.type;
  }
  return null;
}

export function isAssistedApplicationCvKey(orderId, key) {
  const value = String(key || '');
  const prefix = `assisted-application-uploads/${orderId}/`;
  return value.startsWith(prefix)
    && value.length <= 600
    && /^[A-Za-z0-9._-]+$/.test(value.slice(prefix.length));
}

/**
 * Read the object's head, record `cvFileCheck` on the order and return it.
 * Verdicts: `ok` (bytes match a CV format), `type_mismatch`, `missing`
 * (object not found), `invalid_key` (reference outside this order's folder).
 */
export async function checkAssistedApplicationCv({ orderId, key, db = getFirestore(), bucket = null } = {}) {
  const checkedAt = new Date();
  let verdict;
  let detectedType = null;
  if (!isAssistedApplicationCvKey(orderId, key)) {
    verdict = 'invalid_key';
  } else {
    const file = (bucket || getStorage().bucket(STORAGE_BUCKET)).file(key);
    try {
      const [head] = await file.download({ start: 0, end: 7 });
      detectedType = detectCvFileType(head);
      verdict = detectedType ? 'ok' : 'type_mismatch';
    } catch (error) {
      if (Number(error?.code) !== 404) throw error;
      verdict = 'missing';
    }
  }
  const cvFileCheck = { key: String(key || ''), verdict, detectedType, checkedAt };
  await db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId))
    .set({ cvFileCheck }, { merge: true });
  return cvFileCheck;
}
