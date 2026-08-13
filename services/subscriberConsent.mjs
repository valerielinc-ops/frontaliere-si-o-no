/**
 * Shim — canonical module now lives at `functions/src/lib/subscriberConsent.js`,
 * exactly as the previous body of this file prescribed: "If a Cloud Function
 * ever needs this gate, move the body to `functions/src/lib/` and leave a
 * re-export here". #5692 is that moment — the confirmation-email function must
 * be able to tell a double-opt-in request apart from a passwordless login link
 * and from a re-probe of an already-confirmed address, and Cloud Functions have
 * no bundler and cannot import anything outside `functions/`.
 *
 * Re-exported here so every existing `scripts/`/`services/`/test importer keeps
 * resolving to the exact same module — the shape `services/emailSuppression.mjs`
 * already has, so there is still exactly ONE definition and no drift between
 * the two call sites. The reasoning, the production measurements and the
 * `pending`-with-a-stamp trap now live in the canonical file.
 */
export { hasConfirmationProof } from '../functions/src/lib/subscriberConsent.js';
