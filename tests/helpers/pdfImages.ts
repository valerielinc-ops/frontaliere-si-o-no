/**
 * Images in the PDFs of the assisted application: the photo a test gives, and
 * whether a PDF paints an image on any of its pages, read with pdf.js (unpdf).
 * It is how a test tells a tailored CV that carries the candidate's photo from
 * one that does not.
 */

import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';

/** A 1×1 PNG, as the review page stores a photo. */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** A 2×2 baseline JPEG. */
export const JPEG_2X2 = Buffer.from('/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAD/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AQwX/2Q==', 'base64');

export async function pdfPaintsImage(pdfBytes: Uint8Array | Buffer): Promise<boolean> {
  const { OPS } = await getResolvedPDFJS();
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const operators = await (await pdf.getPage(number)).getOperatorList();
    if (operators.fnArray.includes(OPS.paintImageXObject)) return true;
  }
  return false;
}
