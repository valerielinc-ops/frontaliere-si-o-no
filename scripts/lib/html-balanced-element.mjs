/**
 * Read one HTML element to its own closing tag.
 *
 * Detail parsers that used to take "everything after the opening tag" and cut
 * the text at N characters (issue 5253) read the vacancy container instead:
 * the element ends where the posting ends, so no length cap is needed and no
 * page chrome after it can leak in. Built on the shared nesting walker of
 * `hospital-custom-html-helpers.mjs`, with the scan window set to the whole
 * remainder of the page (its 20k default would cut long containers).
 */
import { extractBalancedTagBlockWithStatus, locateTagByAttribute } from './hospital-custom-html-helpers.mjs';

/**
 * @param {string} html
 * @param {string} attrMatcher regex source matched inside the opening tag,
 *   e.g. `id="contenu-ficheoffre"` (see `locateTagByAttribute`)
 * @returns {{ inner: string, complete: boolean, rest: string } | null}
 *   `inner` is the element's inner HTML, `complete` whether its closing tag
 *   was found, `rest` the page after the opening tag; null when no such element.
 */
export function readBalancedElement(html, attrMatcher) {
  const located = locateTagByAttribute(String(html || ''), attrMatcher, { skipVoidTags: true });
  if (!located) return null;
  const { html: inner, complete } = extractBalancedTagBlockWithStatus(located.rest, located.tagName, located.rest.length);
  return { inner, complete, rest: located.rest };
}

/**
 * Inner HTML of the element, or '' when it is missing or never closes (an
 * unclosed element would otherwise extend to the end of the page).
 *
 * @param {string} html
 * @param {string} attrMatcher
 * @returns {string}
 */
export function readClosedElement(html, attrMatcher) {
  const element = readBalancedElement(html, attrMatcher);
  return element?.complete ? element.inner : '';
}
