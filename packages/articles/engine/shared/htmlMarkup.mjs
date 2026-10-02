// Descriptions can mix actual HTML with plain technical tokens such as <SQL>
// and List<T>. Share the same recognized-tag contract in crawlers and renderers.
// Standard HTML vocabulary: https://html.spec.whatwg.org/multipage/indices.html#elements-3
// Keep recognized legacy HTML tags as well; unknown technical tokens stay text.
const TAG_NAMES = 'a|abbr|acronym|address|applet|area|article|aside|audio|b|base|basefont|bdi|bdo|big|blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|dir|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|frame|frameset|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noframes|noscript|object|ol|optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|script|search|section|select|selectedcontent|slot|small|source|span|strike|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|tt|u|ul|var|video|wbr';
const TAG_SOURCE = `<\\/?(?:${TAG_NAMES})(?=[\\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>`;
const TAG_RE = new RegExp(TAG_SOURCE, 'gi');
const HAS_TAG_RE = new RegExp(TAG_SOURCE, 'i');
const SVG_BLOCK_RE = /<svg(?=[\s/>])[^>]*>[\s\S]*?<\/svg\s*>/gi;
const SVG_TAG_RE = /<\/?[a-z][a-z0-9:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;

export function stripHtmlTags(value = '', replacement = ' ') {
  return String(value || '')
    .replace(/<(script|style|svg)(?=[\s/>])[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!doctype(?=[\s>])[^>]*>/gi, ' ')
    .replace(TAG_RE, replacement);
}

export function hasHtmlTags(value = '') {
  return HAS_TAG_RE.test(String(value || ''));
}

export function countHtmlTags(value = '') {
  let svgCount = 0;
  const outsideSvg = String(value || '').replace(SVG_BLOCK_RE, (svg) => {
    svgCount += (svg.match(SVG_TAG_RE) || []).length;
    return '';
  });
  return svgCount + (outsideSvg.match(TAG_RE) || []).length;
}
