/**
 * Per-family URL-count ratchet used by the post-deploy sitemap comparison.
 * Counts include each unique canonical loc and its listed hreflang URLs.
 */

export const SITEMAP_FAMILY_COVERAGE_KEYS = Object.freeze([
  'events',
  'fuel-italian-stations',
  'job-market',
  'orphan-landings',
  'profession-cantons',
  'profession-cities',
  'topics',
]);

export function sitemapCoverageFamilyForKey(key) {
  const name = String(key || '').split('/').pop().toLowerCase();
  if (name === 'sitemap-orphan-landings.xml') return 'orphan-landings';
  if (name === 'sitemap-profession-cantons.xml') return 'profession-cantons';
  if (name === 'sitemap-profession-cities.xml') return 'profession-cities';
  if (name === 'sitemap-fuel-italian-stations.xml') return 'fuel-italian-stations';
  if (name === 'sitemap-job-market.xml') return 'job-market';
  if (/^sitemap-topics-[a-z0-9-]+\.xml$/i.test(name)) return 'topics';
  if (/^sitemap-eventi(?:-[a-z0-9-]+)?\.xml$/i.test(name)) return 'events';
  return null;
}

/** Count unique URLs across each restored family, merging its sitemap shards. */
export function countSitemapFamilyUrls(snapshot) {
  if (!snapshot || Array.isArray(snapshot) || !snapshot.perSitemap || typeof snapshot.perSitemap !== 'object') {
    throw new Error('A per-sitemap snapshot is required for family coverage comparison');
  }

  const urlsByFamily = new Map(SITEMAP_FAMILY_COVERAGE_KEYS.map((family) => [family, new Set()]));
  for (const [key, urls] of Object.entries(snapshot.perSitemap)) {
    const family = sitemapCoverageFamilyForKey(key);
    if (!family) continue;
    if (!Array.isArray(urls)) throw new Error(`Invalid URL list for ${key}`);
    const familyUrls = urlsByFamily.get(family);
    for (const url of urls) {
      if (typeof url !== 'string' || !url) throw new Error(`Invalid sitemap URL in ${key}`);
      familyUrls.add(url);
    }
  }
  return Object.fromEntries([...urlsByFamily].map(([family, urls]) => [family, urls.size]));
}

function declarationsByFamily(declarations) {
  if (!declarations || declarations.version !== 1 || !Array.isArray(declarations.decreases)) {
    throw new Error('Coverage declarations must use schema version 1 and a decreases array');
  }
  const byFamily = new Map();
  const invalid = [];
  for (const [index, declaration] of declarations.decreases.entries()) {
    const family = declaration?.family;
    const reason = typeof declaration?.reason === 'string' ? declaration.reason.trim() : '';
    const valid = SITEMAP_FAMILY_COVERAGE_KEYS.includes(family)
      && Number.isInteger(declaration?.previousCount)
      && declaration.previousCount >= 0
      && Number.isInteger(declaration?.currentCount)
      && declaration.currentCount >= 0
      && declaration.currentCount < declaration.previousCount
      && reason.length >= 20;
    if (!valid || byFamily.has(family)) {
      invalid.push({ index, family: String(family || ''), reason: 'invalid or duplicate decrease declaration' });
      continue;
    }
    byFamily.set(family, { ...declaration, reason });
  }
  return { byFamily, invalid };
}

/** Compare current family counts with the pre-deploy snapshot. */
export function evaluateSitemapFamilyCoverage(previous, current, declarations) {
  const before = countSitemapFamilyUrls(previous);
  const after = countSitemapFamilyUrls(current);
  const { byFamily, invalid } = declarationsByFamily(declarations);
  const usedDeclarations = new Set();
  const families = SITEMAP_FAMILY_COVERAGE_KEYS.map((family) => ({
    family,
    previousCount: before[family],
    currentCount: after[family],
    delta: after[family] - before[family],
  }));
  const regressions = [];
  const allowedDecreases = [];

  for (const entry of families) {
    if (entry.delta >= 0) continue;
    const declaration = byFamily.get(entry.family);
    if (!declaration
      || declaration.previousCount !== entry.previousCount
      || declaration.currentCount !== entry.currentCount) {
      regressions.push(entry);
      continue;
    }
    usedDeclarations.add(entry.family);
    allowedDecreases.push({ ...entry, reason: declaration.reason });
  }

  const staleDeclarations = [...byFamily.keys()]
    .filter((family) => !usedDeclarations.has(family))
    .map((family) => ({ family, reason: 'declaration does not match a current decrease' }));

  return { families, regressions, allowedDecreases, invalidDeclarations: invalid, staleDeclarations };
}
