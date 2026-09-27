const NO_UNIQUE_PROGRESS_CODE = 'ERR_PAGINATION_NO_UNIQUE_PROGRESS';
const DEFAULT_MUTABLE_FEED_PAGE_RETRIES = 2;
const DEFAULT_MUTABLE_FEED_RETRY_DELAY_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record one API page's stable source identities and fail closed when the
 * page cannot advance the crawl.
 *
 * A repeated identity is not harmless pagination noise by default: accepting
 * it can make a declared total look complete while the published snapshot is
 * incomplete. Some mutable vendor feeds can overlap at a page boundary,
 * though; those callers may opt in to known identities as long as every
 * non-empty page still contributes at least one new identity.
 */
export function recordUniquePageProgress(seen, items, {
  getIdentity,
  source = 'pagination',
  page = '',
  allowPreviouslySeen = false,
} = {}) {
  if (!(seen instanceof Set)) throw new TypeError('pagination identity set is required');
  if (!Array.isArray(items)) throw new TypeError('pagination page items must be an array');
  if (typeof getIdentity !== 'function') throw new TypeError('pagination identity resolver is required');

  const pageIdentities = [];
  const pageSeen = new Set();
  let newIdentityCount = 0;
  for (const item of items) {
    const identity = String(getIdentity(item) ?? '').trim();
    if (!identity) {
      throw new Error(`${source} page ${page}: row without a stable source identity.`);
    }
    if (pageSeen.has(identity)) {
      throw new Error(`${source} page ${page}: duplicate source identity "${identity}".`);
    }
    if (seen.has(identity) && !allowPreviouslySeen) {
      throw new Error(`${source} page ${page}: duplicate source identity "${identity}".`);
    }
    pageSeen.add(identity);
    pageIdentities.push(identity);
    if (!seen.has(identity)) newIdentityCount += 1;
  }

  if (items.length > 0 && newIdentityCount === 0) {
    throw Object.assign(
      new Error(`${source} page ${page}: page made no unique progress.`),
      { code: NO_UNIQUE_PROGRESS_CODE },
    );
  }
  for (const identity of pageIdentities) seen.add(identity);
  return pageIdentities;
}

/**
 * Re-read a mutable-feed page only when its first response is a semantic
 * no-progress page. A retry may recover a page that moved while the vendor's
 * date-sorted feed was being scanned, but an empty retry stays ambiguous and
 * therefore fails closed. Duplicate rows within one response and missing
 * identities are never retried.
 *
 * @returns {Promise<{items: unknown[], pageIdentities: string[], retries: number}>}
 */
export async function recordMutableFeedPageWithRetry({
  tracker,
  items,
  page = '',
  reload,
  maxRetries = DEFAULT_MUTABLE_FEED_PAGE_RETRIES,
  retryDelayMs = DEFAULT_MUTABLE_FEED_RETRY_DELAY_MS,
} = {}) {
  if (!tracker || typeof tracker.record !== 'function') {
    throw new TypeError('mutable-feed pagination tracker is required');
  }
  if (!Array.isArray(items)) throw new TypeError('pagination page items must be an array');
  if (typeof reload !== 'function') throw new TypeError('mutable-feed page reload is required');
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError('mutable-feed page retry count must be a non-negative integer');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError('mutable-feed page retry delay must be a non-negative number');
  }

  let currentItems = items;
  for (let retries = 0; ; retries += 1) {
    try {
      return {
        items: currentItems,
        pageIdentities: tracker.record(currentItems, page),
        retries,
      };
    } catch (error) {
      if (error?.code !== NO_UNIQUE_PROGRESS_CODE || retries >= maxRetries) throw error;
      const delayMs = retryDelayMs * (retries + 1);
      if (delayMs > 0) await sleep(delayMs);
      const reloadedItems = await reload(retries + 1);
      if (!Array.isArray(reloadedItems)) {
        throw new TypeError('mutable-feed page reload must return an array');
      }
      if (reloadedItems.length === 0) throw error;
      currentItems = reloadedItems;
    }
  }
}

/**
 * Track a mutable feed whose declared total counts rows while stable source
 * identities are used only for deduplication and forward-progress checks.
 */
export function createMutableFeedPaginationTracker({
  getIdentity,
  source = 'pagination',
} = {}) {
  if (typeof getIdentity !== 'function') throw new TypeError('pagination identity resolver is required');

  const identities = new Set();
  let scannedRows = 0;

  return {
    record(items, page = '') {
      const pageIdentities = recordUniquePageProgress(identities, items, {
        getIdentity,
        source,
        page,
        allowPreviouslySeen: true,
      });
      scannedRows += items.length;
      return pageIdentities;
    },
    hasReached(declaredTotal) {
      return Number.isFinite(declaredTotal) && declaredTotal > 0 && scannedRows >= declaredTotal;
    },
    get scannedRows() {
      return scannedRows;
    },
    get uniqueCount() {
      return identities.size;
    },
  };
}
