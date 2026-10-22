/**
 * Runtime-neutral matcher for salary-intent profession×canton pages.
 *
 * The build source owns the route set in
 * `build-plugins/salaryProfessionCantonData.ts`, but the dist audits run under
 * plain Node and cannot import that TypeScript module. The existing generated
 * route snapshot is therefore the single bridge between the two runtimes.
 * Matching the exact set keeps a similarly shaped editorial slug from being
 * mistaken for a structured salary record.
 */
import routes from '../../data/profession-landing-routes.json' with { type: 'json' };

const SALARY_PROFESSION_CANTON_ROUTE_SET = new Set(routes.salaryProfessionCantonRoutes ?? []);

function normalizePath(urlPath) {
  const raw = String(urlPath || '').replace(/\\/g, '/');
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const withoutIndex = withLeadingSlash.replace(/\/index\.html$/, '/');
  return withoutIndex.endsWith('/') ? withoutIndex : `${withoutIndex}/`;
}

/**
 * @param {string} urlPath canonical URL path or dist-relative index path
 * @returns {boolean} whether the path is an emitted salary-intent page
 */
export function isSalaryProfessionCantonPath(urlPath) {
  return SALARY_PROFESSION_CANTON_ROUTE_SET.has(normalizePath(urlPath));
}

export { SALARY_PROFESSION_CANTON_ROUTE_SET };
