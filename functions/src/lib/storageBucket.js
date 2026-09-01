/**
 * Resolves the default Storage bucket name for Cloud Functions that read/write
 * CV-adjacent objects (`cv-uploads/**`, `assisted-application-uploads/**`).
 * Extracted (#6408) so the fallback env-var chain lives in exactly one place —
 * `publisherApplicationsCore.js` and `assistedApplicationCvScanCore.js` both
 * need it, and the Admin SDK may be initialised without an explicit
 * `storageBucket` option.
 */
export const DEFAULT_STORAGE_BUCKET = 'frontaliere-ticino.firebasestorage.app';

export function resolveStorageBucketName() {
  return process.env.FIREBASE_STORAGE_BUCKET || process.env.STORAGE_BUCKET || DEFAULT_STORAGE_BUCKET;
}
