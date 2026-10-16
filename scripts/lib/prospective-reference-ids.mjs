/**
 * Ids for crawlers of Prospective boards (OHWS `szas` listings) that derive
 * the id from the employer's reference code.
 *
 * Normally the id is `<key>-` + the hash of `<key>:<reference>`, or of the
 * vacancy URL when no reference is published. An employer can reuse one
 * reference code for distinct postings: on 2026-10-15 Emmi published
 * «Projektleiter/in Engineering» in Dagmersellen twice under one code, at two
 * vacancy URLs. Both got the same id, the parser kept only one, the slice kept
 * both, and translate-pending's scatter parity failed on the duplicate key
 * (run 38854975768). When a code covers several URLs, the first URL in sorted
 * order keeps the code's id and every other URL gets the hash of code and URL,
 * so each posting has its own id. Listings that repeat the same URL keep
 * sharing one id and are merged as before.
 */
import { createHash } from 'node:crypto';

/** The reference a listing's id is derived from (empty: none published). */
export function prospectiveStableRef(listing = {}) {
  const szas = listing?.szas || {};
  return String(szas.sza_reference_code || listing?.viewkey || listing?.id || '').trim();
}

/**
 * @param {Array<{stableRef: string, publicUrl: string}>} entries
 * @param {string} key  crawler key, both id prefix and hash namespace
 * @returns {string[]} one id per entry
 */
export function assignReferenceJobIds(entries = [], key) {
  const urlsByRef = new Map();
  for (const { stableRef, publicUrl } of entries) {
    if (!stableRef) continue;
    if (!urlsByRef.has(stableRef)) urlsByRef.set(stableRef, new Set());
    urlsByRef.get(stableRef).add(publicUrl);
  }
  const hash = (value) => createHash('sha1').update(value).digest('hex').slice(0, 12);
  return entries.map(({ stableRef, publicUrl }) => {
    if (!stableRef) return `${key}-${hash(publicUrl)}`;
    const [owner] = [...urlsByRef.get(stableRef)].sort();
    return publicUrl === owner
      ? `${key}-${hash(`${key}:${stableRef}`)}`
      : `${key}-${hash(`${key}:${stableRef}|${publicUrl}`)}`;
  });
}

/** Ids for a whole listing array, in order. */
export function assignProspectiveListingIds(listings = [], key, fallbackUrl) {
  return assignReferenceJobIds(listings.map((listing) => ({
    stableRef: prospectiveStableRef(listing),
    publicUrl: listing?.links?.directlink || fallbackUrl,
  })), key);
}
