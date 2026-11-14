/**
 * Bounded, serializable evidence from a crawler fetch.
 *
 * A zero-job summary is not enough to tell a dead selector from a page that
 * was never observed.  Keep the transport evidence small and source-shaped so
 * the prospector can pass it through the shared crawler template without ever
 * copying response bodies or unbounded request data into corpus summaries.
 */

const MAX_SEED_URLS = 20;
const MAX_HTTP_STATUS_ENTRIES = 50;
const MAX_PROXY_NAMES = 10;
const MAX_STRING_LENGTH = 500;

function boundedString(value, maxLength = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href.slice(0, MAX_STRING_LENGTH);
  } catch {
    return null;
  }
}

function uniqueSafeUrls(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(safeHttpUrl)
      .filter(Boolean),
  )].slice(0, MAX_SEED_URLS);
}

function normalizedPhase(value) {
  return value === 'detail' ? 'detail' : 'listing';
}

/**
 * @param {Record<string, any>} spec
 * @returns {Record<string, any>}
 */
export function createCrawlerFetchReceipt(spec = {}) {
  return {
    specKey: boundedString(String(spec.companyKey || ''), 120),
    seedUrls: uniqueSafeUrls(spec.seedUrls),
    phase: 'listing',
    pages: 0,
    httpStatuses: [],
    proxiedBy: [],
    fetchOutcome: null,
    fetchDetail: null,
  };
}

/**
 * Record one successful or failed page observation. The caller supplies only
 * response metadata; this helper deliberately ignores bodies and headers.
 *
 * @param {Record<string, any>} receipt
 * @param {Record<string, any>} page
 * @param {string} [requestedUrl]
 * @returns {Record<string, any>}
 */
export function recordCrawlerFetchReceiptPage(receipt, page = {}, requestedUrl = '') {
  if (!receipt || typeof receipt !== 'object') return receipt;
  receipt.pages = Number.isInteger(receipt.pages) && receipt.pages >= 0
    ? receipt.pages + 1
    : 1;
  const status = Number(page?.status);
  const url = safeHttpUrl(page?.url || requestedUrl);
  const proxiedBy = boundedString(page?.proxiedBy, 80);
  if (proxiedBy && !receipt.proxiedBy.includes(proxiedBy)) {
    receipt.proxiedBy = [...receipt.proxiedBy, proxiedBy].slice(0, MAX_PROXY_NAMES);
  }
  if (Number.isFinite(status) && status > 0 && receipt.httpStatuses.length < MAX_HTTP_STATUS_ENTRIES) {
    receipt.httpStatuses.push({
      status: Math.trunc(status),
      ...(url ? { url } : {}),
      ...(proxiedBy ? { proxiedBy } : {}),
    });
  }
  return receipt;
}

/**
 * Finish the receipt with the source parser's own verdict. An error message is
 * a last-resort detail only; it never changes the outcome or fail-closed state.
 *
 * @param {Record<string, any>} receipt
 * @param {Record<string, any>} [metadata]
 * @param {unknown} [error]
 * @param {'listing'|'detail'} [phase]
 * @returns {Record<string, any>}
 */
export function finalizeCrawlerFetchReceipt(receipt, metadata = {}, error = null, phase = receipt?.phase) {
  const normalized = normalizeCrawlerFetchReceipt(receipt) || createCrawlerFetchReceipt();
  normalized.phase = normalizedPhase(phase);
  const outcome = boundedString(metadata?.fetchOutcome, 120);
  const detail = boundedString(metadata?.fetchDetail)
    || boundedString(error instanceof Error ? error.message : '');
  normalized.fetchOutcome = outcome;
  normalized.fetchDetail = detail;
  return normalized;
}

/**
 * Copy only the bounded receipt contract into a summary/guard counter.
 *
 * @param {unknown} receipt
 * @returns {Record<string, any>|null}
 */
export function normalizeCrawlerFetchReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  const httpStatuses = Array.isArray(receipt.httpStatuses)
    ? receipt.httpStatuses.flatMap((entry) => {
      const status = Number(entry?.status);
      if (!Number.isFinite(status) || status <= 0) return [];
      const url = safeHttpUrl(entry?.url);
      const proxiedBy = boundedString(entry?.proxiedBy, 80);
      return [{
        status: Math.trunc(status),
        ...(url ? { url } : {}),
        ...(proxiedBy ? { proxiedBy } : {}),
      }];
    }).slice(0, MAX_HTTP_STATUS_ENTRIES)
    : [];
  const proxiedBy = [...new Set(
    (Array.isArray(receipt.proxiedBy) ? receipt.proxiedBy : [])
      .map((value) => boundedString(value, 80))
      .filter(Boolean),
  )].slice(0, MAX_PROXY_NAMES);
  const pages = Number(receipt.pages);
  return {
    specKey: boundedString(receipt.specKey, 120),
    seedUrls: uniqueSafeUrls(receipt.seedUrls),
    phase: normalizedPhase(receipt.phase),
    pages: Number.isInteger(pages) && pages >= 0 ? pages : 0,
    httpStatuses,
    proxiedBy,
    fetchOutcome: boundedString(receipt.fetchOutcome, 120),
    fetchDetail: boundedString(receipt.fetchDetail),
  };
}
