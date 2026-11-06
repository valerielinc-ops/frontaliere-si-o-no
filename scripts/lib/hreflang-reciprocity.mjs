/**
 * Pure hreflang return-link invariant.
 *
 * A crawler can report a missing return link simply because it scanned one
 * side of a locale cluster and not the other. The build must nevertheless be
 * able to prove the invariant on the pages it has parsed: every own-host
 * alternate target that is present in the supplied page set must link back to
 * the source URL.
 */

const DEFAULT_BASE_URL = 'https://frontaliereticino.ch';

/**
 * @typedef {object} HreflangPage
 * @property {string} [url]
 * @property {string} [href]
 * @property {string} [relPath]
 * @property {string} [file]
 * @property {Map<string, string>|Record<string, string>} [alternates]
 */

/** @typedef {Map<string, string>|Record<string, string>|null|undefined} HreflangAlternates */

/** @typedef {HreflangPage|null|undefined} HreflangTargetPage */

/**
 * @typedef {(href: string) => HreflangTargetPage|Promise<HreflangTargetPage>} HreflangTargetResolver
 */

/**
 * @typedef {object} HreflangResolverOptions
 * @property {string} [baseUrl]
 * @property {number} [maxEntries]
 */

/**
 * @typedef {object} HreflangPageCheckOptions
 * @property {string} [baseUrl]
 * @property {(href: string) => boolean} [skipTarget]
 * @property {HreflangTargetResolver} [resolveTargetPage]
 * @property {(page: HreflangPage) => string|undefined} [getPagePath]
 */

/**
 * @typedef {object} HreflangFailure
 * @property {string} source
 * @property {string} target
 * @property {string} hreflang
 * @property {string} sourcePath
 * @property {string} targetPath
 */

/** @param {unknown} value @param {string} [baseUrl] @returns {string} */
export function normalizeHreflangUrl(value, baseUrl = DEFAULT_BASE_URL) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    const url = new URL(value, baseUrl);
    url.search = '';
    url.hash = '';
    if (!url.pathname) url.pathname = '/';
    if (url.pathname !== '/' && !url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return value.trim();
  }
}

/** @param {HreflangAlternates} alternates @returns {Iterable<[string, string]>} */
function alternateEntries(alternates) {
  if (alternates instanceof Map) return alternates.entries();
  if (alternates && typeof alternates === 'object') return Object.entries(alternates);
  return [];
}

/** @param {string} value @param {string} baseUrl @returns {boolean} */
function isOwnHostUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Memoize target-page metadata without retaining an unbounded corpus index.
 * Values may be promises so concurrent sources share the same in-flight read.
 * The resolver exposes its observed high-water mark for deterministic tests.
 *
 * @param {HreflangTargetResolver} resolveTargetPage
 * @param {HreflangResolverOptions} [options]
 */
export function createBoundedHreflangTargetResolver(resolveTargetPage, options = {}) {
  if (typeof resolveTargetPage !== 'function') {
    throw new TypeError('createBoundedHreflangTargetResolver: resolver must be a function');
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const requestedLimit = Number(options.maxEntries ?? 4096);
  const maxEntries = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : 4096;
  /** @type {Map<string, Promise<HreflangTargetPage>>} */
  const cache = new Map();
  let peakCacheSize = 0;

  function trim() {
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    peakCacheSize = Math.max(peakCacheSize, cache.size);
  }

  /** @param {string} href @param {HreflangTargetPage} page @returns {boolean} */
  function remember(href, page) {
    const key = normalizeHreflangUrl(href, baseUrl);
    if (!key || cache.has(key)) return false;
    cache.set(key, Promise.resolve(page));
    trim();
    return true;
  }

  /** @param {string} href @returns {Promise<HreflangTargetPage>} */
  const resolve = async (href) => {
    const key = normalizeHreflangUrl(href, baseUrl);
    if (!key) return null;

    if (cache.has(key)) {
      const cached = cache.get(key);
      if (!cached) return null;
      cache.delete(key);
      cache.set(key, cached);
      return await cached;
    }

    const pending = Promise.resolve().then(() => resolveTargetPage(href));
    cache.set(key, pending);
    trim();

    try {
      const page = await pending;
      if (cache.get(key) === pending) {
        cache.delete(key);
        cache.set(key, Promise.resolve(page));
        trim();
      }
      return page;
    } catch (error) {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    }
  };

  return {
    resolve,
    remember,
    get cacheSize() { return cache.size; },
    get peakCacheSize() { return peakCacheSize; },
    maxEntries,
  };
}

/**
 * Check one parsed source page against its own-host targets. The caller owns
 * the bounded target resolver, so the source page and its targets can be
 * checked immediately without retaining a corpus-wide page index.
 *
 * @param {HreflangPage|null|undefined} page
 * @param {HreflangPageCheckOptions} [options]
 * @returns {Promise<HreflangFailure[]>}
 */
export async function findHreflangReciprocityFailuresForPage(page, options = {}) {
  if (!page) return [];
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const skipTarget = options.skipTarget ?? (() => false);
  const resolveTargetPage = options.resolveTargetPage;
  if (typeof resolveTargetPage !== 'function') {
    throw new TypeError('findHreflangReciprocityFailuresForPage: resolveTargetPage must be a function');
  }

  const source = normalizeHreflangUrl(page?.url ?? page?.href, baseUrl);
  if (!source) return [];

  const checks = [...alternateEntries(page?.alternates)].map(async ([hreflang, href]) => {
    if (hreflang === 'x-default' || !isOwnHostUrl(href, baseUrl) || skipTarget(href)) return null;

    const target = normalizeHreflangUrl(href, baseUrl);
    const targetPage = await resolveTargetPage(href);
    // Missing/unreadable/noindex targets are handled by their own invariant
    // or are intentionally outside the reciprocal-cluster check.
    if (!targetPage) return null;

    for (const [, targetHref] of alternateEntries(targetPage.alternates)) {
      if (normalizeHreflangUrl(targetHref, baseUrl) === source) return null;
    }

    return {
      source,
      target,
      hreflang,
      sourcePath: page.relPath ?? options.getPagePath?.(page) ?? source,
      targetPath: targetPage.relPath ?? options.getPagePath?.(targetPage) ?? target,
    };
  });

  return (await Promise.all(checks)).filter((failure) => failure !== null);
}

/**
 * @param {Iterable<HreflangPage>} pages
 * @param {{baseUrl?: string, skipTarget?: (href: string) => boolean, pageIndex?: Map<string, HreflangPage>, getPagePath?: (page: HreflangPage) => string|undefined}} [options]
 * @returns {HreflangFailure[]}
 */
export function findHreflangReciprocityFailures(pages, options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const skipTarget = options.skipTarget ?? (() => false);
  // Large dist audits can pass their already-built target Map here. Rebuilding
  // the same million-entry URL index would duplicate the dominant data shape
  // at the end of the scan, exactly when the heap is closest to its limit.
  /** @type {Map<string, HreflangPage>} */
  const pageByUrl = options.pageIndex ?? new Map();
  const pageList = (options.pageIndex || Array.isArray(pages)) ? pages : [...pages];

  if (!options.pageIndex) {
    for (const page of pageList) {
      const url = normalizeHreflangUrl(page?.url ?? page?.href, baseUrl);
      if (url) pageByUrl.set(url, page);
    }
  }

  const failures = [];
  for (const page of pageList) {
    const source = normalizeHreflangUrl(page?.url ?? page?.href, baseUrl);
    if (!source) continue;

    for (const [hreflang, href] of alternateEntries(page?.alternates)) {
      if (hreflang === 'x-default' || !isOwnHostUrl(href, baseUrl) || skipTarget(href)) continue;
      const target = normalizeHreflangUrl(href, baseUrl);
      const targetPage = pageByUrl.get(target);
      // Missing targets are a separate invariant. Do not turn one missing
      // file into two failures or claim reciprocity for a page not parsed.
      if (!targetPage) continue;

      let returnsToSource = false;
      for (const [, targetHref] of alternateEntries(targetPage.alternates)) {
        if (normalizeHreflangUrl(targetHref, baseUrl) === source) {
          returnsToSource = true;
          break;
        }
      }
      if (returnsToSource) continue;

      failures.push({
        source,
        target,
        hreflang,
        sourcePath: page.relPath ?? options.getPagePath?.(page) ?? source,
        targetPath: targetPage.relPath ?? options.getPagePath?.(targetPage) ?? target,
      });
    }
  }

  return failures;
}
