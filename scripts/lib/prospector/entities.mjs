/**
 * Entity decoding for scraped employer pages.
 *
 * The repo already has `decode-html-entities.mjs`, but it decodes a fixed table
 * aimed at LLM output — quotes, dashes, ampersands — and leaves `&agrave;` and
 * numeric references alone. That is the right scope for the article pipeline and
 * the wrong one here: employer names on Italian, French and German career pages
 * are full of accented named entities, and `Soci&egrave;t&eacute;` surviving
 * undecoded breaks every later name match, against our coverage index and
 * against the employer's own site alike.
 *
 * So: the shared decoder first, then numeric references and the Latin-1 named
 * set on top. Extending the shared file instead would put article-publishing
 * text through a change made for scraping, which is not a trade worth making.
 */
import { decodeHtmlEntities } from '../decode-html-entities.mjs';

/** Latin-1 letters that appear in Swiss employer names. */
export const NAMED = {
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
};

/**
 * @param {string} input
 * @returns {string}
 */
export function decodeEntities(input = '') {
  let out = decodeHtmlEntities(String(input));
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
  });
  out = out.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number(dec);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
  });
  out = out.replace(/&([a-z]+)(uml|grave|acute|circ|tilde|cedil|ring|lig|zlig|slash);/gi, (whole) => {
    const name = whole.slice(1, -1).toLowerCase();
    return NAMED[name] || whole;
  });
  return out;
}
