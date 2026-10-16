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

function urlKey(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** The ids the slice already gives each vacancy URL, for `key`'s crawler. */
export function existingIdsByUrl(existingJobs = [], key) {
  const byUrl = new Map();
  for (const job of Array.isArray(existingJobs) ? existingJobs : []) {
    const id = String(job?.id || '');
    const url = urlKey(job?.url);
    if (!url || !id.startsWith(`${key}-`) || byUrl.has(url)) continue;
    byUrl.set(url, id);
  }
  return byUrl;
}

/**
 * One id per entry. A URL the slice already knows keeps its id, so a
 * posting's id never moves to another one between crawls (review of PR
 * 13506: «the first URL in sorted order» rotated the code's id to a newly
 * published URL). An id claimed by two URLs at once (the corrupted state of
 * 2026-10-15) stays with the first in sorted order. A new URL gets the code's
 * id when nobody holds it (the last URL in sorted order, when several are new),
 * else the hash of code and URL; without a code, the hash of the URL, as before.
 *
 * @param {Array<{stableRef: string, publicUrl: string}>} entries
 * @param {string} key  crawler key, both id prefix and hash namespace
 * @param {{existingIdByUrl?: Map<string, string>}} [options]
 * @returns {string[]} one id per entry
 */
export function assignReferenceJobIds(entries = [], key, { existingIdByUrl = new Map() } = {}) {
  if (!key) throw new TypeError('assignReferenceJobIds: crawler key is required');
  const hash = (value) => createHash('sha1').update(value).digest('hex').slice(0, 12);
  const idByUrl = new Map();
  const claimed = new Set();
  const urls = [...new Set(entries.map(({ publicUrl }) => urlKey(publicUrl)))].sort();

  for (const url of urls) {
    const known = existingIdByUrl.get(url);
    if (known && !claimed.has(known)) {
      idByUrl.set(url, known);
      claimed.add(known);
    }
  }
  const refByUrl = new Map(entries.map(({ stableRef, publicUrl }) => [urlKey(publicUrl), stableRef]));
  // URLs with no known id, last in sorted order first: without history the
  // order is a tie-break, and the code's id goes to the last URL so that a
  // newly listed URL sorting before a lone known one does not take its id
  // even when the caller passes no history (review of PR 13506). Callers in
  // production pass the slice's ids, which decide before this order does.
  for (const url of [...urls].reverse()) {
    if (idByUrl.has(url)) continue;
    const stableRef = refByUrl.get(url);
    let id;
    if (!stableRef) id = `${key}-${hash(url)}`;
    else {
      const codeId = `${key}-${hash(`${key}:${stableRef}`)}`;
      id = claimed.has(codeId) ? `${key}-${hash(`${key}:${stableRef}|${url}`)}` : codeId;
    }
    idByUrl.set(url, id);
    claimed.add(id);
  }
  return entries.map(({ publicUrl }) => idByUrl.get(urlKey(publicUrl)));
}

/** Ids for a whole listing array, in order. */
export function assignProspectiveListingIds(listings = [], key, fallbackUrl, { existingJobs = [] } = {}) {
  const entries = listings.map((listing) => ({
    stableRef: prospectiveStableRef(listing),
    publicUrl: listing?.links?.directlink || fallbackUrl,
  }));
  const urlsByRef = new Map();
  for (const { stableRef, publicUrl } of entries) {
    if (!stableRef) continue;
    if (!urlsByRef.has(stableRef)) urlsByRef.set(stableRef, new Set());
    urlsByRef.get(stableRef).add(urlKey(publicUrl));
  }
  const shared = [...urlsByRef].filter(([, urls]) => urls.size > 1);
  if (shared.length > 0) {
    console.log(`  🔀 ${key}: ${shared.length} reference code(s) shared by distinct postings, one id per posting (${shared.slice(0, 3).map(([ref, urls]) => `${ref}×${urls.size}`).join(', ')})`);
  }
  return assignReferenceJobIds(entries, key, { existingIdByUrl: existingIdsByUrl(existingJobs, key) });
}
