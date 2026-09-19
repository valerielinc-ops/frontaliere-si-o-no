/**
 * Record one API page's stable source identities and fail closed when the
 * page cannot advance the crawl.
 *
 * A repeated identity is not harmless pagination noise: accepting it can make
 * a declared total look complete while the published snapshot is incomplete.
 */
export function recordUniquePageProgress(seen, items, {
  getIdentity,
  source = 'pagination',
  page = '',
} = {}) {
  if (!(seen instanceof Set)) throw new TypeError('pagination identity set is required');
  if (!Array.isArray(items)) throw new TypeError('pagination page items must be an array');
  if (typeof getIdentity !== 'function') throw new TypeError('pagination identity resolver is required');

  const pageIdentities = [];
  const pageSeen = new Set();
  for (const item of items) {
    const identity = String(getIdentity(item) ?? '').trim();
    if (!identity) {
      throw new Error(`${source} page ${page}: row without a stable source identity.`);
    }
    if (seen.has(identity) || pageSeen.has(identity)) {
      throw new Error(`${source} page ${page}: duplicate source identity "${identity}".`);
    }
    pageSeen.add(identity);
    pageIdentities.push(identity);
  }

  if (items.length > 0 && pageIdentities.length === 0) {
    throw new Error(`${source} page ${page}: page made no unique progress.`);
  }
  for (const identity of pageIdentities) seen.add(identity);
  return pageIdentities;
}
