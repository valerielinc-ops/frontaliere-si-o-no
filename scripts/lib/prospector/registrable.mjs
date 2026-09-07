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

import { canonicalJobHost } from '../job-url-host.mjs';

/** Multi-label public suffixes seen on Swiss/EU employer sites. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'co.jp', 'co.in',
  'com.br', 'com.mx', 'com.tr', 'com.cn', 'com.hk', 'com.sg',
  'co.il', 'org.il', 'com.pl', 'com.es', 'com.pt', 'com.ua',
  'gov.it', 'edu.it', 'gob.es',
]);

/**
 * Normalise a host: lowercase, punycode, strip a leading `www.`/`www2.`, drop a
 * trailing dot and any port.
 *
 * The punycode step closes an asymmetry inside this very function: the `://`
 * branch hands the host to `new URL()`, which returns it punycoded, while a
 * BARE host is kept in whatever alphabet it was written in. The prospector then
 * compares the two forms of the same IDN domain by equality
 * (`coverage.domains.has(domain)`) and they never match — a covered employer
 * reads as uncovered and gets prospected again, the same mute match as #7769.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeHost(raw = '') {
  let h = String(raw || '').trim().toLowerCase();
  if (h.includes('://')) {
    try { h = new URL(h).hostname; } catch { /* not a URL, treat as bare host */ }
  }
  h = canonicalJobHost(h.split('/')[0].split(':')[0]);
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
 * The host with its public suffix removed — the part a brand actually owns.
 *
 * Splitting off a single trailing label is wrong on every compound suffix in
 * `MULTI_LABEL_SUFFIXES`: `foo.com.br` keeps `com`, so a fold that compares a
 * brand to its own host stops matching and the host quietly leaves the compared
 * population (#7770). `.co.uk` only survived by the coincidence that `co` reads
 * as a generic word downstream. Same table as `registrableDomain()`, so the two
 * can never disagree about where the suffix starts.
 *
 * @param {string} raw host or URL
 * @returns {string} `foo` for `foo.com.br`, `jobs.acme` for `jobs.acme.ch`
 */
export function stripPublicSuffix(raw = '') {
  const host = normalizeHost(raw);
  if (!host || !host.includes('.')) return host;
  const parts = host.split('.').filter(Boolean);
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && parts.length >= 3) return parts.slice(0, -2).join('.');
  return parts.slice(0, -1).join('.');
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
 * Il pathname di un URL, decodificato quando si puo'.
 *
 * `decodeURIComponent` LANCIA su un escape percentuale non valido, e i siti che
 * il loop visita ne sono pieni: un `%E9` Latin-1 su una pagina qualsiasi basta.
 * Misurato in produzione: un solo link malformato su un solo datore ha ucciso
 * l'intero stadio SYNTHESIZE con `URIError: URI malformed`.
 *
 * Il ripiego e' il path grezzo, non una stringa vuota: per riconoscere un
 * percorso di carriera va benissimo, e perdere il path renderebbe invisibile il
 * datore invece che solo un po' meno leggibile.
 *
 * @param {string|URL} urlOrPath
 * @returns {string}
 */
export function safeDecodePath(urlOrPath) {
  let raw = '';
  try {
    raw = typeof urlOrPath === 'string' ? new URL(urlOrPath).pathname : urlOrPath.pathname;
  } catch {
    raw = String(urlOrPath ?? '');
  }
  try { return decodeURIComponent(raw); } catch { return raw; }
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
