/**
 * Shim — canonical module now lives at `functions/src/lib/recommendedBlock.js`
 * because `functions/src/lib/welcomeEmailTemplate.js` needs this at Cloud
 * Functions runtime, and Cloud Functions have no bundler and cannot import
 * anything outside `functions/`. Re-exported here so every existing
 * `services/`/`scripts/`/test importer (services/newsletter-template.mjs,
 * services/newsletter/onboardingDrip.mjs, scripts/send-job-alerts.mjs,
 * tests/newsletter-recommended-block.test.ts) keeps resolving to the exact
 * same module — no drift between the two call sites.
 */
export {
  NEWSLETTER_SPONSORS,
  NEWSLETTER_AFFILIATE_ENTRIES,
  pickNewsletterRecommendation,
  buildRecommendedHref,
  renderRecommendedBlock,
} from '../../functions/src/lib/recommendedBlock.js';
