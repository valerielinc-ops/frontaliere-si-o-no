/**
 * URL of one advertisement on a page that lists every ad under its own
 * heading but gives none of them an id or a page of its own: the page URL
 * plus a text fragment (`#:~:text=…`, the browsers' scroll-to-text address)
 * naming the ad's heading. Browsers scroll to the ad; the parser-quality
 * audit reads the section that heading opens (textFragmentBlock) instead of
 * the whole page. An invented `#job-<hash>` anchor does neither.
 *
 * The text directive reserves `-`, `,` and `&`: they are percent-encoded on
 * top of encodeURIComponent, which leaves `-` alone.
 */
export function textFragmentUrl(pageUrl = '', text = '') {
  const base = String(pageUrl || '').split('#')[0];
  const directive = encodeURIComponent(String(text || '').replace(/\s+/g, ' ').trim()).replace(/-/g, '%2D');
  return directive ? `${base}#:~:text=${directive}` : base;
}
