/**
 * Employer-profile floors — ONE definition shared by the dataset generator
 * (scripts/build-employer-profiles.mjs) and the SSG plugin
 * (build-plugins/employerProfilePagesPlugin.ts).
 *
 * The plugin re-gates indexability on the LIVE corpus count at build time
 * (auto-downgrade to noindex on drift); if the floor lived as a literal in
 * each file the two gates could silently diverge (reviewer finding, PR #4511).
 * Plain .mjs for the same dual-consumer reason as companyProfileSlug.mjs.
 */

/** Min active postings for a full, indexable employer profile page. */
export const MIN_ACTIVE_JOBS = 5;

/** Companies with >= this but < MIN_ACTIVE_JOBS get a noindex,follow bridge. */
export const BRIDGE_FLOOR = 2;
