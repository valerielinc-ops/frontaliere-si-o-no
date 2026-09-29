/**
 * Talentsoft vacancy page: the posting lives in `<div id="contenu-ficheoffre">`
 * (general information, position description, requirements, offer, location).
 * Shared by the aarReha Schinznach, Molecular Partners and Victorinox parsers.
 *
 * The container is read by walking its own `<div>` nesting, so the text ends
 * where the vacancy ends. The parsers used to take a fixed 14-16k HTML window
 * after the opening tag and then cut the text at 6000 characters: on pages
 * without a `<footer>`/`</main>` marker (Molecular Partners) that window was
 * the rest of the page, and long postings lost their offer section to the
 * character cap (issue 5253).
 */
import { readBalancedElement } from './html-balanced-element.mjs';

// Page chrome that follows the container: the apply bar, the Talentsoft footer
// (`<div id="footer">`, "Rechtliche Hinweise"/"Mentions légales" menu).
const PAGE_TAIL_RE = /<div[^>]*\bclass="[^"]*\bts-offer-page__cta\b|<div[^>]*\bid="footer"|<footer\b|<\/main>|<\/form>|Rechtliche\s+Hinweise|Mentions\s+l[ée]gales/i;

/**
 * Inner HTML of the `#contenu-ficheoffre` container, or '' when the page has
 * none. Unbalanced markup falls back to the text before the page tail.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractTalentsoftOfferHtml(html = '') {
  const element = readBalancedElement(html, 'id="contenu-ficheoffre"');
  if (!element) return '';
  if (element.complete) return element.inner;
  const tail = element.rest.search(PAGE_TAIL_RE);
  return tail > 0 ? element.rest.slice(0, tail) : '';
}
