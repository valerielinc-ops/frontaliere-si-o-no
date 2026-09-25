/**
 * Client-side text extraction for journalist document imports (Word/PDF/Markdown).
 * Used by JournalistDashboardPage.tsx to fill the article body textarea from an
 * uploaded file. mammoth/pdfjs-dist are dynamically imported so they stay out of
 * the main bundle — loaded only when a journalist actually picks a file.
 */

const PLAIN_TEXT_EXTENSIONS = ['.md', '.markdown', '.txt'];

export const DOC_LEGACY_UNSUPPORTED = 'DOC_LEGACY_UNSUPPORTED';
export const UNSUPPORTED_FORMAT = 'UNSUPPORTED_FORMAT';

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

async function extractFromDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  return value.trim();
}

async function extractFromPdf(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    pages.push(pageText.trim());
  }
  return pages.join('\n\n').trim();
}

/** Throws DOC_LEGACY_UNSUPPORTED / UNSUPPORTED_FORMAT for unreadable formats — caller maps to a translated message. */
export async function extractArticleBodyFromFile(file: File): Promise<string> {
  const ext = extensionOf(file.name);

  if (PLAIN_TEXT_EXTENSIONS.includes(ext)) {
    return (await file.text()).trim();
  }
  if (ext === '.docx') {
    return extractFromDocx(file);
  }
  if (ext === '.doc') {
    throw new Error(DOC_LEGACY_UNSUPPORTED);
  }
  if (ext === '.pdf') {
    return extractFromPdf(file);
  }
  throw new Error(UNSUPPORTED_FORMAT);
}
