const PDF_PAGE_NOISE_PATTERNS = [
  /^\d+\s*\/\s*\d+$/,
  /^page\s+\d+\s+of\s+\d+$/i,
  /^pagina\s+\d+\s+di\s+\d+$/i,
  /^seite\s+\d+\s+von\s+\d+$/i,
  /^page\s+\d+\s+sur\s+\d+$/i,
];

function normalizeLine(raw = '') {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+\d+\s*\/\s*\d+\s*$/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

function isNoiseLine(line = '') {
  if (!line) return true;
  if (PDF_PAGE_NOISE_PATTERNS.some((pattern) => pattern.test(line))) return true;
  if (/^(www\.|https?:\/\/)/i.test(line) && line.length < 120) return true;
  return false;
}

export function normalizePdfJobText(raw = '') {
  const lines = String(raw || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(normalizeLine);

  const paragraphs = [];
  let buffer = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const merged = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (merged) paragraphs.push(merged);
    buffer = [];
  };

  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    if (isNoiseLine(line)) continue;

    if (/^[-•*]\s+/.test(line) || /^[A-ZÀ-ÖØ-Ý][^.!?]{0,120}:$/.test(line)) {
      flush();
      paragraphs.push(line);
      continue;
    }

    buffer.push(line);
  }

  flush();

  const deduped = [];
  const seen = new Set();
  for (const paragraph of paragraphs) {
    const key = paragraph.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(paragraph);
  }

  return deduped.join('\n\n').trim();
}

export function buildPdfBackedDescription({
  introLines = [],
  pdfText = '',
  fallbackText = '',
  footerLines = [],
  maxChars = 7000,
} = {}) {
  const chunks = [
    ...introLines.map((line) => normalizeLine(line)).filter(Boolean),
    normalizePdfJobText(pdfText || fallbackText),
    ...footerLines.map((line) => normalizeLine(line)).filter(Boolean),
  ].filter(Boolean);

  const joined = chunks.join('\n\n').trim();
  if (!joined) return '';
  if (joined.length <= maxChars) return joined;

  return `${joined.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Minimum character threshold for merged extraction. If the merged result
 * contains fewer characters than this despite the PDF having pages, we
 * fall back to page-by-page extraction which handles some font-encoding
 * and multi-column layout edge cases better.
 */
const MIN_MERGED_TEXT_LENGTH = 100;

async function defaultExtractTextFromPdfBytes(arrayBuffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));

  try {
    // Fast path: merged extraction (single string result)
    const merged = await extractText(pdf, { mergePages: true });
    const mergedText = String(merged?.text || '');
    const totalPages = Number(merged?.totalPages || 0);

    if (mergedText.trim().length >= MIN_MERGED_TEXT_LENGTH) {
      return merged;
    }

    // Fallback: page-by-page extraction.
    // Some PDFs with unusual font encoding or multi-column layouts yield
    // empty/partial text with mergePages:true but succeed page-by-page.
    if (totalPages > 0) {
      try {
        const perPage = await extractText(pdf, { mergePages: false });
        const pageTexts = Array.isArray(perPage?.text)
          ? perPage.text.filter(Boolean)
          : [];
        const joinedLength = pageTexts.reduce((sum, t) => sum + t.length, 0);

        if (joinedLength > mergedText.trim().length) {
          return { text: pageTexts, totalPages };
        }
      } catch {
        // page-by-page also failed — return whatever merged gave us
      }
    }

    return merged;
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // noop
    }
  }
}

export async function extractPdfJobContentFromUrl(
  pdfUrl,
  {
    fetchImpl = fetch,
    extractTextImpl = defaultExtractTextFromPdfBytes,
    timeoutMs = 30_000,
    headers = {},
  } = {},
) {
  if (!pdfUrl) return { text: '', totalPages: 0, rawText: '', sourceUrl: '' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(pdfUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/pdf,*/*;q=0.8',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        ...headers,
      },
    });

    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status || 'unknown'} while fetching PDF`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const extracted = await extractTextImpl(arrayBuffer);
    const rawText = Array.isArray(extracted?.text)
      ? extracted.text.join('\n\n')
      : String(extracted?.text || '');
    const totalPages = Number(extracted?.totalPages || 0);
    const normalizedText = normalizePdfJobText(rawText);

    // Diagnostic: detect image-only PDFs (pages exist but no text layer)
    const thinContent = totalPages > 0 && normalizedText.length < 50;
    const warning = thinContent
      ? `PDF has ${totalPages} page(s) but only ${normalizedText.length} chars extracted (possible image-only/scanned PDF)`
      : undefined;

    return {
      text: normalizedText,
      rawText,
      totalPages,
      sourceUrl: pdfUrl,
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    return {
      text: '',
      rawText: '',
      totalPages: 0,
      sourceUrl: pdfUrl,
      error: error instanceof Error ? error.message : String(error || 'Unknown PDF extraction error'),
    };
  } finally {
    clearTimeout(timer);
  }
}
