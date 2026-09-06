/**
 * newsletterPlacements.js — single source for the placement contract between
 * the surfaces that EMIT `/go/{id}/?pos=…` links and the redirect page that
 * CONSUMES them (`build-plugins/affiliateRedirectPlugin.ts`). Issue #7695,
 * follow-up of #7656.
 *
 * Why a module and not three string literals: the redirect turns `pos` into the
 * Partnerize `pubref`, and it does so by reading a query parameter by NAME. If
 * an emitter renames the parameter (or drifts the placement shape) the redirect
 * does not fail — it silently falls back to the referring path and the click
 * lands in an undifferentiated bucket, so affiliate revenue stops being
 * attributable to the slot that produced it and nothing goes red. Pinning the
 * name and the shapes here, plus the regex the test asserts against, makes a
 * divergence a failing test instead of an empty `pubref`.
 *
 * Canonical home is functions/src/lib/ for the same reason as recommendedBlock.js:
 * functions/src/lib/welcomeEmailTemplate.js reaches it at Cloud Functions
 * runtime, where firebase.json's `source: "functions"` forbids importing
 * anything outside functions/. Everything else (scripts/, services/,
 * build-plugins/) imports it from here by relative path.
 */

/**
 * Query parameter every email surface appends to `/go/{partner}/` to declare
 * WHICH slot the click came from. Read by the redirect page to build `pubref`.
 */
export const PLACEMENT_PARAM = 'pos';

/** Prefix of every newsletter-emitted placement. */
export const NEWSLETTER_PLACEMENT_PREFIX = 'nl-';

/**
 * Placement of an affiliate row in the newsletter partners block:
 * `nl-partner-<1-based slot>-<id>`. The index comes from the row order inside
 * the email, so the slot stays identifiable even when the partner occupying it
 * changes.
 *
 * @param {number} index 1-based slot position of the row
 * @param {string} id partner id (the `{id}` of `/go/{id}/`)
 * @returns {string}
 */
export function newsletterPartnerPlacement(index, id) {
  return `nl-partner-${index}-${id}`;
}

/**
 * Normalise a free-form token (a campaign name) to the alphabet the redirect's
 * `pubref` sanitiser preserves, so the placement reaches Partnerize byte-identical
 * to what the email emitted. A token normalised here and one normalised there
 * are the same string; a token that isn't would arrive silently rewritten.
 *
 * @param {string} raw
 * @returns {string}
 */
export function placementToken(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Placement of the single "Consigliato per te" affiliate recommendation:
 * `nl-recommended-<campaign>-<goId>`.
 *
 * The campaign is part of the slot, not decoration: the SAME block is rendered
 * by four surfaces (weekly newsletter, job alert, welcome, drip) and they all
 * link to the same `/go/{goId}/`. Keyed on the goId alone, those four collapse
 * into one indistinguishable `pubref` and no surface can be compared against
 * another — the exact ambiguity the partner rows already avoid by carrying
 * their slot index.
 *
 * @param {string} campaign campaign of the surface rendering the block
 * @param {string} goId registry go id of the recommended partner
 * @returns {string}
 */
export function newsletterRecommendedPlacement(campaign, goId) {
  return `nl-recommended-${placementToken(campaign || 'recommended')}-${goId}`;
}

/**
 * Every shape this module can emit. The redirect sanitises `pos` to
 * `[a-z0-9-]`, so a placement that does not match here would survive the
 * sanitiser and still be unreadable by the consumer — the test pins both sides
 * against this.
 */
export const NEWSLETTER_PLACEMENT_RE = /^nl-(partner-\d+|recommended-[a-z0-9_-]+)-[a-z0-9-]+$/;
