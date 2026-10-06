/** Canonical finding codes shared by the Bing-compatible SEO checks. */

export const BING_TITLE_TOO_LONG = 'title-too-long';
export const BING_META_DESCRIPTION_TOO_SHORT = 'meta-description-too-short';

export const BING_METADATA_FINDING_CODES = Object.freeze([
  BING_TITLE_TOO_LONG,
  BING_META_DESCRIPTION_TOO_SHORT,
]);

// Frontier findings describe an internal link target, not sitemap membership.
// Keep the names short because they are repeated in every large JSON finding.
export const BING_FRONTIER_NOINDEX = 'frontier-noindex';
export const BING_FRONTIER_NOINDEX_BRIDGE = 'frontier-noindex-bridge';
export const BING_FRONTIER_CANONICAL_DRIFT = 'frontier-canonical-drift';
export const BING_FRONTIER_CANONICAL_EXPECTED = 'frontier-canonical-expected';
export const BING_FRONTIER_REDIRECT = 'frontier-redirect';
export const BING_FRONTIER_HTTP_ERROR = 'frontier-http-error';

/**
 * Scope-specific frontier codes and their issue classification.
 *
 * A declared noindex/follow bridge whose canonical mismatch is already
 * accepted by `classifyCanonicalMismatch` is evidence, not a repair target.
 * A redirect, HTTP error, or unrecognised noindex/canonical target points to
 * an emitter defect and remains actionable.
 */
export const BING_FRONTIER_FINDING_DEFINITIONS = Object.freeze({
  [BING_FRONTIER_NOINDEX]: Object.freeze({
    scope: 'discovered-frontier',
    actionable: true,
    reason: 'Link interno verso una pagina noindex non riconosciuta come bridge dichiarato.',
  }),
  [BING_FRONTIER_NOINDEX_BRIDGE]: Object.freeze({
    scope: 'discovered-frontier',
    actionable: false,
    reason: 'Pagina bridge dichiarata: noindex/follow con canonical consolidato secondo classifyCanonicalMismatch.',
  }),
  [BING_FRONTIER_CANONICAL_DRIFT]: Object.freeze({
    scope: 'discovered-frontier',
    actionable: true,
    reason: 'Link interno verso una pagina con canonical altrove non riconosciuto come consolidamento previsto.',
  }),
  [BING_FRONTIER_CANONICAL_EXPECTED]: Object.freeze({
    scope: 'discovered-frontier',
    actionable: false,
    reason: 'Canonical altrove riconosciuto da classifyCanonicalMismatch come consolidamento previsto.',
  }),
  [BING_FRONTIER_REDIRECT]: Object.freeze({
    scope: 'discovered-frontier',
    actionable: true,
    reason: 'Link interno verso un redirect: il template referente emette una URL non finale.',
  }),
  [BING_FRONTIER_HTTP_ERROR]: Object.freeze({
    scope: 'discovered-frontier',
    actionable: true,
    reason: 'Link interno verso un errore HTTP: il template referente emette una destinazione non servita.',
  }),
});

// The sitemap codes deliberately keep their existing meaning. The only
// additions here are the actionable frontier variants; informative codes are
// omitted so the issue's actionable total cannot count declared bridges.
export const BING_ACTIONABLE_FINDING_CODES = Object.freeze([
  'fetch-error',
  'http-error',
  'redirect',
  'noindex-in-sitemap',
  'canonical-missing',
  'canonical-drift',
  'soft-404',
  'title-missing',
  BING_TITLE_TOO_LONG,
  'meta-description-missing',
  BING_META_DESCRIPTION_TOO_SHORT,
  'internal-link-malformed',
  BING_FRONTIER_NOINDEX,
  BING_FRONTIER_CANONICAL_DRIFT,
  BING_FRONTIER_REDIRECT,
  BING_FRONTIER_HTTP_ERROR,
]);

export function isBingActionableCode(code) {
  return BING_ACTIONABLE_FINDING_CODES.includes(String(code || ''));
}
