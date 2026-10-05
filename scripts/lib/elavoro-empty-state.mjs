/**
 * The AITI e-lavoro.ch portal (Drupal) renders this copy in the listing view's
 * `view-empty` block when a company micro-site has no open positions. It is
 * the only positive "no jobs" signal the portal gives, so the e-lavoro
 * parsers that publish a proven zero (`markAuthoritativeEmptySnapshot`) share
 * one spelling of it instead of a copy each.
 *
 * Compare against text normalised with `normalizeElavoroText`.
 */
export const ELAVORO_EMPTY_MESSAGE = 'purtroppo non ci sono offerte di lavoro, torna a trovarci';

export function normalizeElavoroText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
