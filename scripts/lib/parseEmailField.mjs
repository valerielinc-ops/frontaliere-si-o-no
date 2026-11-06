/**
 * Re-export shim. Canonical implementation lives in functions/src/lib/parseEmailField.js
 * (Cloud Functions ships without a bundler, so the webhook cores need their own copy
 * inside functions/; this file keeps scripts/ on the same implementation instead of a
 * second, drift-prone copy).
 */
export { parseEmailField, normalizeEmailAddress } from '../../functions/src/lib/parseEmailField.js';
