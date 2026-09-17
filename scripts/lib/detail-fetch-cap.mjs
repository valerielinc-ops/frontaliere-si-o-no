/**
 * Keep an optional detail-fetch cap fail-closed.
 *
 * A cap may protect a crawl's runtime, but it must never silently publish the
 * first N listings as if the source had contained only those listings.
 */
export function assertDetailFetchComplete(listings, maxDetailPages, label = 'crawler') {
  if (!Array.isArray(listings)) {
    throw new TypeError(`[${label}] listings must be an array`);
  }

  const cap = Number(maxDetailPages);
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new TypeError(`[${label}] invalid detail cap: ${maxDetailPages}`);
  }

  if (listings.length > cap) {
    throw new Error(
      `[${label}] detail discovery incomplete: ${listings.length} listings exceed `
      + `the detail cap ${cap}; refusing to publish a truncated set as complete`,
    );
  }

  return listings;
}
