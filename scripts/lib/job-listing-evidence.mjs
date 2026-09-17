const EXPLICIT_EMPTY_JOB_LISTING_RE = /\b(no\s+(?:open\s+)?(?:jobs|positions|vacancies)|no\s+openings|nessun(?:a)?\s+(?:posizione|offerta)|keine\s+(?:offene\s+)?stellen|aucun(?:e)?\s+(?:poste|offre))/i;

/**
 * An explicit empty-state marker is evidence about the listing container, not
 * merely the absence of parsed rows. Keep the marker vocabulary in one place
 * so every source-specific authoritative-zero validator has the same baseline.
 *
 * The scope flag is deliberately mandatory: document.body text can contain
 * unrelated footer/help copy and therefore cannot prove an empty listing.
 */
export function hasExplicitEmptyJobListing(text = '', { scopedToListing = false } = {}) {
  if (scopedToListing !== true) return false;
  return EXPLICIT_EMPTY_JOB_LISTING_RE.test(String(text || ''));
}

/**
 * A previous page cannot prove that a paginated source reached a trustworthy
 * terminal page. Callers pass the evidence observed on the page that actually
 * terminated the read, never an OR-aggregate over earlier pages.
 */
export function hasAuthoritativeListingPageEvidence({
  isTerminalPage = false,
  listingMarkupSeen = false,
  emptyStateObserved = false,
} = {}) {
  return isTerminalPage === true
    && (listingMarkupSeen === true || emptyStateObserved === true);
}
