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
  return `nl-partner-${placementSlot(index)}-${id}`;
}

/**
 * Normalise a slot index to the 1-based integer the shapes above embed. A
 * missing/invalid index falls back to 1 (the only slot a surface that renders
 * the block once has), never to an empty segment: a placement with a hole in
 * it would still pass the redirect's sanitiser and arrive at Partnerize as a
 * different, unreadable key.
 *
 * @param {number|string} [index]
 * @returns {number}
 */
export function placementSlot(index) {
  const n = Math.floor(Number(index));
  return Number.isFinite(n) && n > 0 ? n : 1;
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
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Placement of a "Consigliato per te" affiliate recommendation:
 * `nl-recommended-<1-based slot>-<campaign>-<goId>`.
 *
 * Two dimensions, both needed, neither decoration:
 *  - the CAMPAIGN, because the SAME block is rendered by four surfaces (weekly
 *    newsletter, job alert, welcome, drip) all linking to the same
 *    `/go/{goId}/`: keyed on the goId alone those four collapse into one
 *    indistinguishable `pubref` and no surface is comparable to another;
 *  - the SLOT index, because within a SINGLE send nothing stops a caller from
 *    rendering the block twice (or two recommendations resolving to the same
 *    goId), and campaign+goId are identical in both — the two clicks would come
 *    back under one `pos` and the ambiguity the partner rows avoid by carrying
 *    `nl-partner-<n>-<id>` would survive here. Same shape family, same reason.
 *
 * @param {string} campaign campaign of the surface rendering the block
 * @param {string} goId registry go id of the recommended partner
 * @param {number} [slot=1] 1-based position of the block inside the send
 * @returns {string}
 */
export function newsletterRecommendedPlacement(campaign, goId, slot) {
  return `nl-recommended-${placementSlot(slot)}-${placementToken(campaign || 'recommended')}-${goId}`;
}

/**
 * Every shape this module can emit. The redirect sanitises `pos` to
 * `[a-z0-9-]`, so a placement that does not match here would survive the
 * sanitiser and still be unreadable by the consumer — the test pins both sides
 * against this.
 */
export const NEWSLETTER_PLACEMENT_RE = /^nl-(partner-\d+|recommended-\d+-[a-z0-9]+(?:-[a-z0-9]+)*)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
