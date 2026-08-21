/**
 * Registrable-domain extraction, without pulling in a full Public Suffix List.
 *
 * The prospector only ever compares hosts inside the small set of TLDs Swiss
 * employers actually use, so a curated multi-label suffix table is both smaller
 * and easier to audit than a 9k-entry PSL snapshot that would go stale in the
 * repo. Anything not in the table falls back to "last two labels", which is
 * correct for every flat TLD (.ch, .com, .it, .de, .swiss...).
 *
 * Getting this wrong in EITHER direction breaks the loop:
 *   - too greedy  -> `acme.co.uk` reads as `co.uk`, and every unrelated British
 *                    employer clusters into one bogus "platform";
 *   - too shy     -> `tenant.ats-vendor.example` reads as itself, every tenant
 *                    looks like its own platform and nothing ever clusters.
 */

/** Multi-label public suffixes seen on Swiss/EU employer sites. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'co.jp', 'co.in',
  'com.br', 'com.mx', 'com.tr', 'com.cn', 'com.hk', 'com.sg',
  'co.il', 'org.il', 'com.pl', 'com.es', 'com.pt', 'com.ua',
  'gov.it', 'edu.it', 'gob.es',
]);

/**
 * Normalise a host: lowercase, strip a leading `www.`/`www2.`, drop a trailing
 * dot and any port.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeHost(raw = '') {
  let h = String(raw || '').trim().toLowerCase();
  if (h.includes('://')) {
    try { h = new URL(h).hostname; } catch { /* not a URL, treat as bare host */ }
  }
  h = h.split('/')[0].split(':')[0].replace(/\.$/, '');
  return h.replace(/^www\d?\./, '');
}

/**
 * The registrable domain (eTLD+1) of a host.
 *
 * @param {string} raw host or URL
 * @returns {string} e.g. `ats-vendor.example` for `acme.ats-vendor.example`
 */
export function registrableDomain(raw = '') {
  const host = normalizeHost(raw);
  if (!host || !host.includes('.')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * The subdomain label in front of a registrable domain — the tenant id on a
 * hosted ATS.
 *
 * @param {string} raw
 * @returns {string} `acme` for `acme.ats-vendor.example`, '' when there is none
 */
export function tenantLabel(raw = '') {
  const host = normalizeHost(raw);
  const reg = registrableDomain(host);
  if (!host || host === reg) return '';
  const prefix = host.slice(0, -(reg.length + 1));
  return prefix.split('.').pop() || '';
}

/**
 * True when two hosts belong to the same organisation.
 *
 * @param {string} a
 * @param {string} b
 */
export function sameOrg(a, b) {
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  if (!ra || !rb) return false;
  if (ra === rb) return true;
  // `acme.ch` vs `acme.com` vs `acme-group.ch` — same brand on another TLD.
  const brand = (d) => d.split('.')[0].replace(/[^a-z0-9]/g, '');
  const ba = brand(ra);
  const bb = brand(rb);
  if (!ba || !bb || ba.length < 4 || bb.length < 4) return false;
  return ba === bb || ba.startsWith(bb) || bb.startsWith(ba);
}
