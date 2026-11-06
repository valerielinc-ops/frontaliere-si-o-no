/**
 * Shared pdfkit page geometry, base palette, and buffer-streaming helper.
 *
 * Extracted from pdfWhitepapersPlugin.ts (identical A4 page/margin/color
 * literals + doc.on('data'|'end'|'error') boilerplate were about to be
 * copy-pasted verbatim into selfCertificationFormsPlugin.ts — AGENTS.md #6
 * requires extracting a shared module instead of a second literal copy).
 */

export const PDF_PAGE_A4 = { width: 595.28, height: 841.89 };

export const PDF_MARGIN_DEFAULT = { top: 56, bottom: 56, left: 56, right: 56 };

export const PDF_BASE_PALETTE = {
  headerBg: '#1e293b', // slate-800
  white: '#ffffff',
  body: '#334155', // slate-700
  heading: '#1e40af', // blue-800
  muted: '#64748b', // slate-500
  rule: '#cbd5e1', // slate-300
};

/**
 * Buffers a pdfkit document's streamed output into a single Buffer.
 * Caller must still build the document content and call `doc.end()`
 * after invoking this (the returned promise resolves on the 'end' event).
 */
export function collectPdfBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
