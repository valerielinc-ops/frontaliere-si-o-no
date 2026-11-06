/**
 * Sector signal — is this candidate a transport/logistics business?
 *
 * OSM's Ticino census turned up 1'411 businesses with a domain and ZERO in
 * transport/logistics (see PR #6240's follow-up, item 2 of #6251): the
 * community that maps `office`/`craft`/`industrial`/`shop`/... tags in OSM
 * largely doesn't bother mapping hauliers and forwarders. Whether the `web`
 * channel (sector-agnostic Common Crawl sweep) actually closes that gap over
 * time was, until this module, a one-off manual count frozen in a PR body —
 * unmeasurable on any later run. This gives the report an ongoing answer
 * instead of a historical claim: classify candidates by name and let
 * `prospect-report.mjs` show the per-source split every run.
 *
 * Keyword match on the company NAME, not a full NACE/NOGA taxonomy — the
 * candidate store has no sector field and building one is out of scope for
 * closing a measurement gap. Kept to terms specific enough that a name match
 * is high-confidence (no bare "shipping"/"courier", too generic against
 * e-commerce/tech names).
 */

const KEYWORDS = [
  'trasport', 'autotrasport', 'spedizion',
  'logistic', 'logistik',
  'transport', 'spedition', 'fracht', 'spediteur',
  'freight', 'forwarding', 'haulage',
  'camionnage',
];

export const TRANSPORT_LOGISTICS_RX = new RegExp(`\\b(${KEYWORDS.join('|')})\\w*`, 'i');

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isTransportLogistics(name = '') {
  return TRANSPORT_LOGISTICS_RX.test(String(name || ''));
}
