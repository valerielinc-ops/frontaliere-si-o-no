/**
 * Text of a sitemap `<loc>` element as the URL it names. A `<loc>` is XML
 * text: all five predefined entities (and numeric references) can appear,
 * and `&amp;` is decoded last so an escaped entity is not decoded twice.
 * Manor's SuccessFactors sitemap writes "Basel-Buyer-%28Women&apos;s-
 * Fashion%29-100": decoding only `&amp;` left `&apos;` in the published URL.
 */
export function decodeSitemapLoc(value = '') {
  return String(value || '')
    .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&#0*38;|&#x0*26;/gi, '&')
    .replace(/&#0*60;|&#x0*3c;/gi, '<')
    .replace(/&#0*62;|&#x0*3e;/gi, '>')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}
