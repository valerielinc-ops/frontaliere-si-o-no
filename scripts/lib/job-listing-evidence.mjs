const EXPLICIT_EMPTY_JOB_LISTING_RE = /\b(no\s+(?:open\s+)?(?:jobs|positions|vacancies)|no\s+openings|nessun(?:a)?\s+(?:posizione|offerta)|keine\s+(?:offene\s+)?stellen|aucun(?:e)?\s+(?:poste|offre))/i;

const HIDDEN_EMPTY_STATE_SELECTOR = [
  '[hidden]',
  '[aria-hidden="true"]',
  '[data-hidden="true"]',
  'template',
  'script',
  'style',
  'noscript',
].join(', ');

const HIDDEN_EMPTY_STATE_CLASS_RE = /(?:^|\s)(?:d-none|display-none|hidden|invisible|is-hidden|sr-only|u-hidden|visually-hidden)(?:\s|$)/i;
const HIDDEN_EMPTY_STATE_STYLE_RE = /(?:^|;)\s*(?:display|visibility|content-visibility)\s*:\s*(?:none|hidden)\b/i;
const EMPTY_STATE_HINT_RE = /(?:empty|no[-_ ]?(?:jobs?|positions?|vacancies?|openings?|results?))/i;

function isHiddenEmptyStateNode(node) {
  if (!node || typeof node.matches !== 'function') return true;
  if (node.matches(HIDDEN_EMPTY_STATE_SELECTOR)) return true;
  if (node.closest?.(HIDDEN_EMPTY_STATE_SELECTOR)) return true;

  const className = String(node.getAttribute?.('class') || '');
  const inlineStyle = String(node.getAttribute?.('style') || '');
  return HIDDEN_EMPTY_STATE_CLASS_RE.test(className)
    || HIDDEN_EMPTY_STATE_STYLE_RE.test(inlineStyle)
    || /(?:^|;)\s*opacity\s*:\s*0(?:\s*;|$)/i.test(inlineStyle);
}

function visibleEmptyStateText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.nodeValue || '');
  if (isHiddenEmptyStateNode(node)) return '';
  return [...(node.childNodes || [])].map(visibleEmptyStateText).join(' ');
}

function isActiveEmptyStateNode(node) {
  if (isHiddenEmptyStateNode(node)) return false;
  const text = visibleEmptyStateText(node);
  if (!EXPLICIT_EMPTY_JOB_LISTING_RE.test(text)) return false;

  // A generic listing root may include hidden/template copy in its textContent.
  // Accept a leaf marker, or a wrapper whose attributes explicitly identify it
  // as an empty-state node; never accept the aggregate root text by itself.
  const hasElementChildren = Number(node.children?.length || 0) > 0;
  const semanticAttributes = [
    node.getAttribute?.('id'),
    node.getAttribute?.('class'),
    node.getAttribute?.('role'),
    node.getAttribute?.('data-testid'),
    node.getAttribute?.('data-state'),
  ].filter(Boolean).join(' ');
  return !hasElementChildren || EMPTY_STATE_HINT_RE.test(semanticAttributes);
}

/**
 * An explicit empty-state marker is evidence about the listing container, not
 * merely the absence of parsed rows. Keep the marker vocabulary in one place
 * so every source-specific authoritative-zero validator has the same baseline.
 *
 * The scope flag is deliberately mandatory: document.body text can contain
 * unrelated footer/help copy and therefore cannot prove an empty listing. The
 * root itself is required so text hidden in a template or inactive node cannot
 * authorize a zero through aggregate `textContent`.
 */
export function hasExplicitEmptyJobListing(listingRoot = null, { scopedToListing = false } = {}) {
  if (scopedToListing !== true || !listingRoot || typeof listingRoot.querySelectorAll !== 'function') {
    return false;
  }
  const nodes = [listingRoot, ...listingRoot.querySelectorAll('*')];
  return nodes.some(isActiveEmptyStateNode);
}

/**
 * A previous page cannot prove that a paginated source reached a trustworthy
 * terminal page. Callers pass the evidence observed on the page that actually
 * terminated the read, never an OR-aggregate over earlier pages.
 */
export function hasAuthoritativeListingPageEvidence({
  isTerminalPage = false,
  listingMarkupSeen = false,
  listingRowsSeen = false,
  emptyStateObserved = false,
  paginationIntegrityProven = false,
} = {}) {
  return isTerminalPage === true
    && paginationIntegrityProven === true
    && (emptyStateObserved === true
      || (listingMarkupSeen === true && listingRowsSeen === true));
}
