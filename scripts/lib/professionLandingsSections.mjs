/**
 * Shared profession-canton / profession-city landing classifier.
 * ─────────────────────────────────────────────────────────────────────────
 * `build-plugins/professionCantonData.ts` (`/lavoro-{canton}-{role}/`) and
 * `build-plugins/professionCityData.ts` (`/lavoro-{city}-{role}/`) shipped
 * in the same #4323 bundle (2026-07-17) but neither ever got a matcher in
 * `audit-title-length`/`audit-text-html-ratio`'s classifier chain — both
 * fell through into the generic spa-locale/spa-other catch-all, whose
 * baselines were captured before this family existed (audit regression
 * #4593, sibling of the employer-profiles gap fixed by #4550's
 * EMPLOYER_PROFILES_RX in `employerLandingSections.mjs`).
 *
 * Why exact-route-set instead of a regex. Both slug shapes cram THREE
 * meaningful parts into one hyphen-separated path segment
 * (`{areaWord}-{place}-{role}`), and both `place` (e.g. "san-gallo") and
 * `role` (e.g. "assistente-sociale") can themselves contain hyphens — the
 * boundary between them isn't regex-decidable without the exact token
 * lists. A naive `lavoro-{known-place}-[a-z-]+/` regex false-positives on
 * unrelated pages that happen to combine a real place name with other
 * words (e.g. the blog slug `/lavoro-lugano-mercato-annunci/` — "lugano"
 * is a real profession-city key, "mercato-annunci" isn't a role). Both
 * route lists are fully static (enumerated from PROFESSION_IDS x
 * cantons/cities x locales, no live job data) so an exact Set built once
 * at module load — same "precompile the Set, never rebuild per file"
 * discipline as `searchConsoleCompat.ts`'s self-maps — is both precise and
 * cheap. Source: `data/profession-landing-routes.json`, regenerated via
 * `npx tsx scripts/generate-profession-landing-routes.mjs` (see that
 * script for why a live `.ts` import doesn't work under the plain `node`
 * these audits run under in CI).
 */
import routes from '../../data/profession-landing-routes.json' with { type: 'json' };

const CANTON_ROUTE_SET = new Set(routes.professionCantonRoutes);
const CITY_ROUTE_SET = new Set(routes.professionCityRoutes);

/**
 * @param {string} normalizedPath Leading-slash, trailing-slash path with
 *   `index.html` already stripped (the shape every classifyFeature() in
 *   this codebase builds before calling sibling matchers).
 * @returns {'profession-canton'|'profession-city'|null}
 */
export function classifyProfessionLandingFeature(normalizedPath) {
  if (CANTON_ROUTE_SET.has(normalizedPath)) return 'profession-canton';
  if (CITY_ROUTE_SET.has(normalizedPath)) return 'profession-city';
  return null;
}
