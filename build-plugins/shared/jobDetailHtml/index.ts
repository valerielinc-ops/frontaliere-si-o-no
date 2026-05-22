/**
 * Barrel re-exports for the static job-detail page HTML emitters.
 *
 * Phase 1 of the L3 refactor — extracts the SPA-parity IIFE blocks from
 * `build-plugins/jobsSeoPagesPlugin.ts` into pure-TS modules. Phase 2
 * will hand these renderers to the React SPA so static and hydrated
 * views render identical markup from one source.
 *
 * Sections still inline in the plugin (deferred to Phase 1.5+ because
 * their helper closure dependencies — localeCopy, buildCantonAwareSection,
 * companyLogo, etc. — would require an export-cascade beyond Phase 1's
 * scope):
 *   - Hero (h1 + sub + meta)
 *   - Panoramica summary section
 *   - Timeline blocks
 *   - Primary apply CTA
 *   - Company card with "Tutte le offerte …" anchor
 *   - Related jobs list
 *   - Frontalier info / FAQ / hub links
 *   - Footer nav
 */
export type {
  JobDetailJob,
  JobDetailLocale,
  JobDetailRenderContext,
} from './context';
export {
  renderHeroBadges,
  type HeroBadgesContext,
} from './heroBadges';
export {
  renderMobileActionBlock,
  type MobileActionBlockContext,
} from './mobileActionBlock';
export {
  renderHighlightsChips,
  type HighlightsChipsContext,
} from './highlightsChips';
export {
  renderRightRail,
  type RightRailContext,
} from './rightRail';
