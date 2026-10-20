/**
 * The fonts of a PDF page's text, as pdf.js (unpdf) resolved them. One reading
 * of "this font is in the file", shared by the ATS check of the runner
 * (scripts/assisted-application/lib/pdf-ats-check.mjs) and by the renderer's
 * self-check in the Cloud Functions (assistedApplicationRendererCheck.js).
 */

/**
 * Call after `page.getOperatorList()`: pdf.js has loaded the page's fonts by then.
 * @param {object} page a pdf.js page
 * @param {Array<{fontName:string}>} items its text items
 * @returns {Array<{name:string, embedded:boolean, resolved:boolean}>} one entry per font.
 *   `embedded` is false for a standard font (Helvetica: no font file, and no č, ł, ș);
 *   `resolved` is false for a font pdf.js could not load: it cannot be shown embedded.
 */
export function pageTextFonts(page, items) {
  const fonts = new Map();
  for (const { fontName } of items) {
    if (fonts.has(fontName)) continue;
    try {
      const font = page.commonObjs.get(fontName);
      fonts.set(fontName, { name: String(font?.name || ''), embedded: !font?.missingFile, resolved: true });
    } catch {
      fonts.set(fontName, { name: '', embedded: false, resolved: false });
    }
  }
  return [...fonts.values()];
}
