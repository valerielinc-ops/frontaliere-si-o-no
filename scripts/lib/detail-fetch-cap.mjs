/**
 * A detail-fetch cap is allowed for cost/runtime reasons, but a truncated
 * prefix must never be published as if it were the complete source listing.
 */
export function assertDetailFetchComplete(listings, maxDetailPages, label = 'crawler') {
  if (!Array.isArray(listings)) throw new TypeError(`[${label}] listings must be an array`);
  const cap = Number(maxDetailPages);
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new TypeError(`[${label}] detail cap must be a non-negative safe integer`);
  }
  if (listings.length > cap) {
    throw new Error(
      `[${label}] detail discovery incomplete: ${listings.length} listings exceed `
      + `the detail cap ${cap}; refusing to publish a truncated set as complete`,
    );
  }
  return listings;
}
