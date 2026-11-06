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
  allowIdenticalDuplicates = false,
  getFingerprint,
  fingerprints,
} = {}) {
  if (!(seen instanceof Set)) throw new TypeError('pagination identity set is required');
  if (!Array.isArray(items)) throw new TypeError('pagination page items must be an array');
  if (typeof getIdentity !== 'function') throw new TypeError('pagination identity resolver is required');
  if (getFingerprint !== undefined && typeof getFingerprint !== 'function') {
    throw new TypeError('pagination content fingerprint resolver must be a function');
  }
  if (fingerprints !== undefined && !(fingerprints instanceof Map)) {
    throw new TypeError('pagination content fingerprint map is required');
  }

  const pageIdentities = [];
  const pageSeen = new Map();
  let newIdentityCount = 0;
  for (const item of items) {
    const identity = String(getIdentity(item) ?? '').trim();
    if (!identity) {
      throw new Error(`${source} page ${page}: row without a stable source identity.`);
    }
    const fingerprint = getFingerprint ? getFingerprint(item) : undefined;
    if (pageSeen.has(identity)) {
      if (allowIdenticalDuplicates && getFingerprint && pageSeen.get(identity) === fingerprint) {
        // A mutable page can contain the same row twice while the source
        // index is being rebuilt. It is safe to discard only equivalent
        // content; a changed row remains a real source conflict.
        continue;
      }
      const detail = getFingerprint ? ' with conflicting content' : '';
      throw new Error(`${source} page ${page}: duplicate source identity "${identity}"${detail}.`);
    }
    if (seen.has(identity) && !allowPreviouslySeen) {
      throw new Error(`${source} page ${page}: duplicate source identity "${identity}".`);
    }
    if (seen.has(identity) && getFingerprint && fingerprints?.has(identity)
      && fingerprints.get(identity) !== fingerprint) {
      throw new Error(`${source} page ${page}: source identity "${identity}" has conflicting content.`);
    }
    pageSeen.set(identity, fingerprint);
    pageIdentities.push(identity);
    if (!seen.has(identity)) newIdentityCount += 1;
  }

  if (items.length > 0 && newIdentityCount === 0) {
    throw Object.assign(
      new Error(`${source} page ${page}: page made no unique progress.`),
      { code: NO_UNIQUE_PROGRESS_CODE },
    );
  }
  for (const identity of pageIdentities) {
    seen.add(identity);
    if (getFingerprint && fingerprints) fingerprints.set(identity, pageSeen.get(identity));
  }
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
      if (error?.code !== NO_UNIQUE_PROGRESS_CODE) throw error;
      if (retries >= maxRetries) {
        // A mutable, date-sorted feed can return the same page while it is
        // changing underneath the crawler. Once the bounded reloads are
        // exhausted, the snapshot is incomplete but the source is not proven
        // broken. Let crawler runners preserve the last good slice and record
        // `feed_endpoint_unavailable` instead of opening a per-crawler red
        // failure for this transient pagination state.
        error.feedEndpointUnavailable = true;
        throw error;
      }
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
  getFingerprint,
  source = 'pagination',
} = {}) {
  if (typeof getIdentity !== 'function') throw new TypeError('pagination identity resolver is required');
  if (getFingerprint !== undefined && typeof getFingerprint !== 'function') {
    throw new TypeError('pagination content fingerprint resolver must be a function');
  }

  const identities = new Set();
  const fingerprints = new Map();
  let scannedRows = 0;

  return {
    record(items, page = '') {
      const pageIdentities = recordUniquePageProgress(identities, items, {
        getIdentity,
        getFingerprint,
        fingerprints,
        source,
        page,
        allowPreviouslySeen: true,
        allowIdenticalDuplicates: Boolean(getFingerprint),
      });
      scannedRows += items.length;
      return pageIdentities;
    },
    hasReached(declaredTotal) {
      return Number.isFinite(declaredTotal) && declaredTotal > 0 && scannedRows >= declaredTotal;
    },
    hasMinimumUniqueCoverage(declaredTotal, minimumRatio = 0.9) {
      if (!Number.isFinite(declaredTotal) || declaredTotal <= 0) return false;
      if (!Number.isFinite(minimumRatio) || minimumRatio <= 0 || minimumRatio > 1) return false;
      return identities.size >= Math.ceil(declaredTotal * minimumRatio);
    },
    get scannedRows() {
      return scannedRows;
    },
    get uniqueCount() {
      return identities.size;
    },
  };
}
