/**
 * Shim — canonical module now lives at `functions/src/lib/newsletterSegments.js`
 * because `functions/src/newsletterWelcomeEmail.js` needs the same
 * inferInterest/resolveDripSegment classifiers at Cloud Functions runtime (to
 * write a `drip_segment` that the nightly scripts/send-onboarding-drip.mjs
 * runner agrees with), and Cloud Functions have no bundler and cannot import
 * anything outside `functions/`. Re-exported here so every existing
 * `scripts/`/`services/`/test importer (send-newsletter.mjs,
 * newsletter-winback-campaign.mjs, send-onboarding-drip.mjs,
 * tests/newsletter-segments.test.ts) keeps resolving to the exact same
 * module, zero edits required (AGENTS.md #6, docs/AGENTS-HISTORY.md#sibling-pattern-fix).
 *
 * Edit functions/src/lib/newsletterSegments.js, not this file.
 */
export {
  INTERESTS,
  CONTENT_STRATEGIES,
  inferInterest,
  contentStrategyForLevel,
  describeSegment,
  resolveSegment,
  summarizeSegments,
  selectWinnerCandidates,
  selectArticleCandidates,
  resolveDripSegment,
} from '../functions/src/lib/newsletterSegments.js';
