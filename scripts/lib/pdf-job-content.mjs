import { sourceBodyWordCount } from './source-body-floor.mjs';
import { SOURCE_BODY_FAILURE_REASON } from './source-body-failure.mjs';
import { WAF_IP_BLOCK_STATUS } from './transient-fetch.mjs';
import { detectJinaErrorBody, fetchViaJinaWithRetry } from './jina-proxy.mjs';

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
export const PDF_MULTI_PAGE_MIN_WORDS = 10;

function extractedText(extracted) {
  return Array.isArray(extracted?.text)
    ? extracted.text.join('\n\n')
    : String(extracted?.text || '');
}

function extractedWordCount(extracted) {
  return sourceBodyWordCount(extractedText(extracted));
}

function extractionNeedsFallback(extracted) {
  const text = extractedText(extracted);
  const totalPages = Number(extracted?.totalPages || extracted?.total || 0);
  return !text.trim() || (
    totalPages > 1
    && sourceBodyWordCount(text) < PDF_MULTI_PAGE_MIN_WORDS
  );
}

async function extractTextWithUnpdf(arrayBuffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));

  try {
    // Fast path: merged extraction (single string result)
    const merged = await extractText(pdf, { mergePages: true });
    const mergedText = String(merged?.text || '');
    const totalPages = Number(merged?.totalPages || 0);

    if (mergedText.trim().length >= MIN_MERGED_TEXT_LENGTH) {
      return { ...merged, extractionMethod: 'unpdf' };
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
          return { text: pageTexts, totalPages, extractionMethod: 'unpdf' };
        }
      } catch {
        // page-by-page also failed — return whatever merged gave us
      }
    }

    return { ...merged, extractionMethod: 'unpdf' };
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // noop
    }
  }
}

/**
 * Production dependency fallback for runners where unpdf/PDF.js is absent or
 * cannot decode a source PDF. `pdf-parse` is already in dependencies (unpdf is
 * a devDependency), so this works in the sparse corpus checkout too without an
 * install or a system binary.
 */
async function extractTextWithPdfParse(arrayBuffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(arrayBuffer) });
  try {
    const result = await parser.getText();
    return {
      text: String(result?.text || ''),
      totalPages: Number(result?.total || 0),
      extractionMethod: 'pdf-parse',
    };
  } finally {
    try {
      await parser.destroy();
    } catch {
      // noop
    }
  }
}

async function defaultExtractTextFromPdfBytes(arrayBuffer) {
  let primary;
  let primaryError;

  try {
    primary = await extractTextWithUnpdf(arrayBuffer);
  } catch (error) {
    primaryError = error;
  }

  // An exception, an empty result, or a multi-page result with fewer than ten
  // words is a parser/fetch failure signal, not a thin source. Try the second
  // already-installed extractor before reporting the PDF as failed.
  if (!primaryError && !extractionNeedsFallback(primary)) return primary;

  let fallback;
  let fallbackError;
  try {
    fallback = await extractTextWithPdfParse(arrayBuffer);
  } catch (error) {
    fallbackError = error;
  }

  const primaryWords = extractedWordCount(primary);
  const fallbackWords = extractedWordCount(fallback);
  if (fallback && fallbackWords > primaryWords) {
    return {
      ...fallback,
      fallbackUsed: true,
      ...(primaryError ? { primaryError: primaryError.message } : {}),
    };
  }
  if (primary) {
    return {
      ...primary,
      ...(fallbackError ? { fallbackError: fallbackError.message } : {}),
    };
  }
  if (fallback) return { ...fallback, fallbackUsed: true };

  const messages = [
    primaryError && `unpdf: ${primaryError.message || primaryError}`,
    fallbackError && `pdf-parse: ${fallbackError.message || fallbackError}`,
  ].filter(Boolean);
  throw new Error(
    `PDF text extraction failed${messages.length > 0 ? ` (${messages.join('; ')})` : ''}`,
  );
}

/**
 * Text of a PDF read through the Jina Reader clean-IP proxy, or '' when the
 * rescue is exhausted. Jina parses the PDF on its side and returns its text
 * layer; fetchViaJinaWithRetry rotates egress IPs. On exhaustion it hands back
 * the last response unchanged, which can be a 200 carrying Jina's own error
 * envelope, so the body is checked here again before it counts as the
 * document's text.
 */
async function fetchPdfTextViaJina(pdfUrl, { timeoutMs, fetchImpl, retryDelayMs }) {
  try {
    const res = await fetchViaJinaWithRetry(pdfUrl, {
      format: 'text',
      timeoutMs,
      fetchImpl,
      ...(retryDelayMs != null ? { retryDelayMs } : {}),
    });
    if (!res?.ok) return '';
    const text = String(await res.text() || '');
    return detectJinaErrorBody(text) ? '' : text;
  } catch {
    return '';
  }
}

export async function extractPdfJobContentFromUrl(
  pdfUrl,
  {
    fetchImpl = fetch,
    extractTextImpl = defaultExtractTextFromPdfBytes,
    timeoutMs = 30_000,
    headers = {},
    // Clean-IP rescue for a WAF-class answer (403/406/415/451) keyed on the
    // datacenter egress IP. Defaults to the same transport as the direct read.
    jinaFetchImpl = fetchImpl,
    jinaRetryDelayMs,
  } = {},
) {
  if (!pdfUrl) return { text: '', thin: false, totalPages: 0, rawText: '', sourceUrl: '' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let proxiedBy;

  try {
    response = await fetchImpl(pdfUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/pdf,*/*;q=0.8',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        ...headers,
      },
    });

    let extracted;
    if (!response?.ok) {
      // The HTML fetch helpers already route the WAF/IP-block class through
      // Jina (transient-fetch.mjs WAF_IP_BLOCK_STATUS); the PDF read did not,
      // so a source that answers the GitHub egress with 415 only for its PDFs
      // failed every posting (klinik-wyssholzli, run corpus 36989251899: five
      // text PDFs, all HTTP 415 in CI, all 200 from a clean IP).
      const wafBlocked = WAF_IP_BLOCK_STATUS.has(Number(response?.status));
      if (wafBlocked) {
        try { await response?.body?.cancel?.(); } catch { /* already closed */ }
      }
      const rescuedText = wafBlocked
        ? await fetchPdfTextViaJina(pdfUrl, { timeoutMs, fetchImpl: jinaFetchImpl, retryDelayMs: jinaRetryDelayMs })
        : '';
      if (!rescuedText) {
        throw new Error(
          `HTTP ${response?.status || 'unknown'} while fetching PDF`
          + (wafBlocked ? ' (clean-IP Jina rescue exhausted)' : ''),
        );
      }
      proxiedBy = 'jina';
      extracted = { text: rescuedText, totalPages: 0, extractionMethod: 'jina-reader' };
    } else {
      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        throw new Error('PDF response body is empty');
      }
      extracted = await extractTextImpl(arrayBuffer);
    }
    const rawText = extractedText(extracted);
    const totalPages = Number(extracted?.totalPages || extracted?.total || 0);
    const normalizedText = normalizePdfJobText(rawText);
    const wordCount = sourceBodyWordCount(normalizedText);
    const failure = !normalizedText || (
      totalPages > 1 && wordCount < PDF_MULTI_PAGE_MIN_WORDS
    );

    if (failure) {
      const failureDetail = !normalizedText
        ? 'no text extracted'
        : `${wordCount} words extracted from ${totalPages} pages`;
      return {
        text: '',
        thin: false,
        extractionFailed: true,
        failureReason: SOURCE_BODY_FAILURE_REASON,
        error: `PDF extraction failed: ${failureDetail}`,
        warning: `PDF extraction failed (${failureDetail}); source body was not published`,
        rawText,
        bodyWordCount: wordCount,
        totalPages,
        sourceUrl: pdfUrl,
        ...(extracted?.extractionMethod ? { extractionMethod: extracted.extractionMethod } : {}),
        ...(extracted?.fallbackUsed ? { fallbackUsed: true } : {}),
        httpStatus: Number(response?.status || 0) || undefined,
        contentType: response?.headers?.get?.('content-type') || undefined,
      };
    }

    // Detect image-only PDFs (pages exist but no usable text layer). A thin
    // extraction (1–49 chars: a broken fragment, page number remnant, etc.) is
    // NOT real job content. We must surface `text: ''` for it, not the fragment:
    // consumers reading `pdf.text` fall back to their inline intro via
    // `pdfText || fallbackText` (buildPdfBackedDescription) ONLY when `text` is
    // empty. Returning the thin fragment instead glues intro+fragment+footer
    // into a boilerplate-only description that hard-fails the crawler's
    // boilerplate guard (#1485).
    //
    // `rawText` is intentionally NOT blanked: it carries the image-only
    // diagnostic and is the un-normalized source that `buildPdfBackedDescription`
    // / `buildFartDescription` normalize themselves. But several consumers prefer
    // `pdf.rawText || pdf.text`, which would bypass the `text: ''` guard. They
    // must honor the `thin` flag (`pdf.thin ? '' : (pdf.rawText || pdf.text)`) so
    // the fallback happens for them too. The `warning` is preserved either way so
    // operators still see the image-only diagnostic.
    const thinContent = totalPages > 0 && normalizedText.length < 50;
    const warning = thinContent
      ? `PDF has ${totalPages} page(s) but only ${normalizedText.length} chars extracted (possible image-only/scanned PDF)`
      : undefined;

    return {
      text: thinContent ? '' : normalizedText,
      thin: thinContent,
      rawText,
      bodyWordCount: wordCount,
      totalPages,
      sourceUrl: pdfUrl,
      httpStatus: Number(response?.status || 0) || undefined,
      contentType: response?.headers?.get?.('content-type') || undefined,
      ...(extracted?.extractionMethod ? { extractionMethod: extracted.extractionMethod } : {}),
      ...(extracted?.fallbackUsed ? { fallbackUsed: true } : {}),
      ...(proxiedBy ? { proxiedBy } : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    return {
      text: '',
      thin: false,
      rawText: '',
      totalPages: 0,
      sourceUrl: pdfUrl,
      extractionFailed: true,
      failureReason: SOURCE_BODY_FAILURE_REASON,
      httpStatus: Number(response?.status || 0) || undefined,
      contentType: response?.headers?.get?.('content-type') || undefined,
      error: error instanceof Error ? error.message : String(error || 'Unknown PDF extraction error'),
    };
  } finally {
    clearTimeout(timer);
  }
}
