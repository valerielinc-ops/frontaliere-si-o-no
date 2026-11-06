/**
 * Shim — canonical module now lives at `functions/src/lib/newsletterUrls.js`
 * because `functions/src/newsletterWelcomeEmail.js` needs the HMAC-signed
 * unsubscribe/resubscribe/preferences/autologin URL builders at Cloud
 * Functions runtime, and Cloud Functions have no bundler and cannot import
 * anything outside `functions/`. Re-exported here so every existing
 * `scripts/`/`services/`/test importer (send-newsletter.mjs,
 * send-job-alerts.mjs, send-onboarding-drip.mjs, blast-publisher-ads.mjs,
 * preview-welcome-email.mjs, winbackEmail.mjs, dormantWinbackStage1Email.mjs,
 * tests/newsletter-unsubscribe-oneclick.test.ts) keeps resolving to the exact
 * same module, calling with the same signature — no drift between call
 * sites (AGENTS.md #6, docs/AGENTS-HISTORY.md#sibling-pattern-fix).
 *
 * Edit functions/src/lib/newsletterUrls.js, not this file.
 */
export {
  makeUnsubscribeUrl,
  makeOneClickUnsubscribeUrl,
  makeResubscribeUrl,
  generateAutologinCode,
  makeAuthenticatedActionUrl,
  makeAuthenticatedUrl,
  isOwnRewritableHref,
  shouldWrapAuthenticatedHref,
  autologinDestination,
  AUTOLOGIN_DESTINATIONS,
  wrapAuthenticatedHrefs,
  makePreferencesUrl,
  PREFERENCES_SLUG,
  FOLLOWED_COMPANIES_SLUG,
} from '../functions/src/lib/newsletterUrls.js';
