/**
 * Record one API page's stable source identities and fail closed when the
 * page cannot advance the crawl.
 *
 * A repeated identity is not harmless pagination noise by default: accepting
 * it can make a declared total look complete while the published snapshot is
 * incomplete. Some mutable vendor feeds can overlap at a page boundary,
 * though; those callers may opt in to known identities as long as every
 * non-empty page still contributes at least one new identity.
 */
export function recordUniquePageProgress(seen, items, {
  getIdentity,
  source = 'pagination',
  page = '',
  allowPreviouslySeen = false,
} = {}) {
  if (!(seen instanceof Set)) throw new TypeError('pagination identity set is required');
  if (!Array.isArray(items)) throw new TypeError('pagination page items must be an array');
  if (typeof getIdentity !== 'function') throw new TypeError('pagination identity resolver is required');

  const pageIdentities = [];
  const pageSeen = new Set();
  let newIdentityCount = 0;
  for (const item of items) {
    const identity = String(getIdentity(item) ?? '').trim();
    if (!identity) {
      throw new Error(`${source} page ${page}: row without a stable source identity.`);
    }
    if (pageSeen.has(identity)) {
      throw new Error(`${source} page ${page}: duplicate source identity "${identity}".`);
    }
    if (seen.has(identity) && !allowPreviouslySeen) {
      throw new Error(`${source} page ${page}: duplicate source identity "${identity}".`);
    }
    pageSeen.add(identity);
    pageIdentities.push(identity);
    if (!seen.has(identity)) newIdentityCount += 1;
  }

  if (items.length > 0 && newIdentityCount === 0) {
    throw new Error(`${source} page ${page}: page made no unique progress.`);
  }
  for (const identity of pageIdentities) seen.add(identity);
  return pageIdentities;
}
