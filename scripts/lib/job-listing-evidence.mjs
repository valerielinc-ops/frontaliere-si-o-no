const EXPLICIT_EMPTY_JOB_LISTING_RE = /\b(no\s+(?:open\s+)?(?:jobs|positions|vacancies)|no\s+openings|nessun(?:a)?\s+(?:posizione|offerta)|keine\s+(?:offene\s+)?stellen|aucun(?:e)?\s+(?:poste|offre))/i;

/**
 * An explicit empty-state marker is evidence about the listing container, not
 * merely the absence of parsed rows. Keep the marker vocabulary in one place
 * so every source-specific authoritative-zero validator has the same baseline.
 */
export function hasExplicitEmptyJobListing(text = '') {
  return EXPLICIT_EMPTY_JOB_LISTING_RE.test(String(text || ''));
}
