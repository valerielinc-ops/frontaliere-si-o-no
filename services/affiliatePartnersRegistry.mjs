/**
 * Shim — canonical module now lives at
 * `functions/src/lib/affiliatePartnersRegistry.js` because
 * `functions/src/lib/welcomeEmailTemplate.js` and
 * `functions/src/lib/recommendedBlock.js` need the enable gate at Cloud
 * Functions runtime, and Cloud Functions have no bundler and cannot import
 * anything outside `functions/`. Re-exported here so every existing
 * `services/`/`scripts/`/test importer (services/affiliateService.ts,
 * services/newsletter-template.mjs, services/newsletter/recommendedBlock.mjs,
 * scripts/send-onboarding-drip.mjs) keeps resolving to the exact same module
 * — no drift between the two call sites.
 */
export {
  PARTNERS_REGISTRY,
  goPathFromId,
  isGoIdEnabled,
  getEnabledPartner,
} from '../functions/src/lib/affiliatePartnersRegistry.js';
