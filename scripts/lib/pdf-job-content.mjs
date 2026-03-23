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

async function defaultExtractTextFromPdfBytes(arrayBuffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));

  try {
    return await extractText(pdf, { mergePages: true });
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
    timeoutMs = 20000,
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

    return {
      text: normalizePdfJobText(rawText),
      rawText,
      totalPages: Number(extracted?.totalPages || 0),
      sourceUrl: pdfUrl,
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
