/**
 * Shim — canonical module now lives at `functions/src/lib/newsletterUrls.js`
 * because `functions/src/newsletterWelcomeEmail.js` needs the HMAC-signed
 * unsubscribe/resubscribe/autologin URL builders at Cloud Functions runtime,
 * and Cloud Functions have no bundler and cannot import anything outside
 * `functions/`. Re-exported here so every existing `scripts/`/`services/`/
 * test importer (send-newsletter.mjs, send-onboarding-drip.mjs,
 * blast-publisher-ads.mjs, preview-welcome-email.mjs, winbackEmail.mjs,
 * dormantWinbackStage1Email.mjs, tests/newsletter-unsubscribe-oneclick.test.ts)
 * keeps resolving to the exact same module, calling with the same
 * single-argument signature — no drift between the two call sites.
 *
 * Edit functions/src/lib/newsletterUrls.js, not this file.
 */
export {
  makeUnsubscribeUrl,
  makeOneClickUnsubscribeUrl,
  makeResubscribeUrl,
  generateAutologinCode,
  makeAuthenticatedActionUrl,
} from '../functions/src/lib/newsletterUrls.js';
