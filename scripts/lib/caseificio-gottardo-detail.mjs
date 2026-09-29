/**
 * Detail-page text of a Caseificio dimostrativo del Gottardo vacancy.
 * Kept out of `update-caseificio-gottardo-jobs.mjs` because that runner starts
 * crawling on import.
 *
 * The text runs from the page's content block (or, without one, from the
 * `</h1>`) to the first end marker: the "Caseificio dimostrativo del Gottardo"
 * contact box, `<footer`, or a `footer` class. There is no length cap
 * (issue 5253), so a page without any end marker yields no body at all rather
 * than its tail (menus, language switcher, cookie UI) — the title-only line
 * is published instead.
 */
import { stripScriptsAndStyles } from './crawler-template.mjs';

export function decodeHtmlEntities(html = '') {
  return String(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#039;/gi, "'")
    .replace(/&ndash;/gi, '–')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '\u2019');
}

export function stripHtml(html = '') {
  return decodeHtmlEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
      // Open each <li> as a line-start bullet so list structure survives the strip (#2476).
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

const END_MARKER_RE = /Caseificio dimostrativo del Gottardo|<footer|class="[^"]*footer/i;

/**
 * @param {string} html detail page
 * @returns {string} the vacancy text, or the title-only line when the page
 *   has no delimited body
 */
export function extractCaseificioDetailDescription(html = '') {
  const source = String(html || '');
  const titleMatch = stripScriptsAndStyles(source).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleText = titleMatch ? stripHtml(titleMatch[1]).trim() : '';

  // The content block, closed by the first end marker (the lookahead fails
  // without one, so an unbounded block never matches).
  const contentMatch = source.match(
    /class="[^"]*content[^"]*"[^>]*>([\s\S]*?)(?=Caseificio dimostrativo del Gottardo|<footer|class="[^"]*footer)/i,
  );

  let description = '';
  if (contentMatch) {
    description = stripHtml(contentMatch[1]);
  } else {
    // Fallback: the text after the h1, but only up to an end marker. Without
    // one there is no delimited body: safe-fail to the title-only line.
    const afterTitle = source.split(/<\/h1>/i).slice(1).join('');
    const end = afterTitle.search(END_MARKER_RE);
    description = end >= 0 ? stripHtml(afterTitle.slice(0, end)) : '';
  }

  // Clean up CSS/JS noise that may leak through
  description = description
    .replace(/\.Menu_[^}]+\}/g, '')
    .replace(/@[\w-]+keyframes[^}]+\}/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s{3,}/g, '\n\n')
    .trim();

  return description || `${titleText}\n\nPer maggiori dettagli, consultare la pagina dell'offerta.`;
}
