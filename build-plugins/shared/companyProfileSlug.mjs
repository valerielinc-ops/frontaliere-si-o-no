/**
 * Canonical company slug for the evergreen employer-profile surface.
 *
 * Shared by BOTH the dataset generator (scripts/build-employer-profiles.mjs)
 * and the SSG plugin (build-plugins/employerProfilePagesPlugin.ts) so the slug
 * written into data/employer-profiles.json and the slug the plugin emits pages
 * at (`/aziende/<slug>/`) can never drift.
 *
 * Mirrors build-plugins/weeklyEmployersData.ts:canonicalCompanySlug (itself a
 * documented mirror of jobsSeoPagesPlugin.ts:canonicalCompanySlugBuild) — same
 * Lidl special-case + ASCII slugify. Kept as a plain .mjs because a .ts plugin
 * can import it (tsconfig allowJs) AND a node .mjs script can import it, whereas
 * a .ts module cannot be imported by the raw-node dataset script.
 *
 * @param {string} company    Company display name (job.company).
 * @param {string} [companyKey] Optional crawler company key (job.companyKey).
 * @returns {string} URL-safe canonical slug (no leading/trailing dash).
 */
export function canonicalCompanyProfileSlug(company, companyKey) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const keyNorm = norm(companyKey || '');
  const nameNorm = norm(company);
  if (keyNorm.includes('lidl') || nameNorm.includes('lidl')) return 'lidl';
  return norm(company).replace(/\s+/g, '-');
}
